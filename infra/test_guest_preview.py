"""Low-latency guest preview framing and authentication regressions."""
import importlib.util
from io import BytesIO
from pathlib import Path
import socket
import struct
from threading import Thread
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    'guest_preview', Path(__file__).parent / 'capture/guest-preview.py',
)
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


class GuestPreviewTests(unittest.TestCase):
    def test_jpeg_split_and_latest_complete_frames(self):
        parser = preview.JpegFrames()
        self.assertEqual(parser.feed(b'noise\xff\xd8first'), [])
        self.assertEqual(parser.feed(b'\xff\xd9\xff\xd8second\xff'), [b'\xff\xd8first\xff\xd9'])
        self.assertEqual(parser.feed(b'\xd9'), [b'\xff\xd8second\xff\xd9'])

    def test_oversized_incomplete_frame_is_discarded(self):
        parser = preview.JpegFrames(max_bytes=10)
        self.assertEqual(parser.feed(b'\xff\xd8' + b'x' * 20), [])
        self.assertEqual(parser.feed(b'\xff\xd8ok\xff\xd9'), [b'\xff\xd8ok\xff\xd9'])

    def test_binary_websocket_frame_supports_large_jpeg(self):
        payload = struct.pack('!Q', 123456) + b'x' * 100000
        frame = preview.websocket_binary(payload)
        self.assertEqual(frame[:2], b'\x82\x7f')
        self.assertEqual(struct.unpack('!Q', frame[2:10])[0], len(payload))
        self.assertEqual(frame[10:], payload)

    def test_token_must_arrive_in_masked_text_frame(self):
        payload = b'{"token":"one-secret-token-value"}'
        mask = b'1234'
        masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        frame = b'\x81' + bytes([0x80 | len(payload)]) + mask + masked
        self.assertEqual(preview.read_client_token(BytesIO(frame)), 'one-secret-token-value')
        self.assertIsNone(preview.read_client_token(BytesIO(b'\x81' + bytes([len(payload)]) + payload)))

    def test_invalid_token_never_queries_gateway(self):
        with patch.object(preview, 'urlopen') as urlopen:
            self.assertFalse(preview.authorized('short'))
            urlopen.assert_not_called()

    def test_public_server_rejects_files_and_never_captures_for_wrong_token(self):
        server = preview.ThreadingHTTPServer(('127.0.0.1', 0), preview.Handler)
        server.daemon_threads = True
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 1)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        address = ('127.0.0.1', server.server_port)
        with socket.create_connection(address, timeout=2) as client:
            client.sendall(b'GET /workspace/arena/.env HTTP/1.1\r\nHost: localhost\r\n\r\n')
            self.assertIn(b'404', client.recv(512))

        payload = b'{"token":"wrong-guest-token-value"}'
        mask = b'1234'
        masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        with patch.object(preview, 'authorized', return_value=False), \
                patch.object(preview, 'LatestFrame') as capture, \
                socket.create_connection(address, timeout=2) as client:
            client.settimeout(2)
            client.sendall(
                b'GET /frames HTTP/1.1\r\nHost: localhost\r\n'
                b'Upgrade: websocket\r\nConnection: Upgrade\r\n'
                b'Sec-WebSocket-Version: 13\r\n'
                b'Sec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n\r\n'
                + b'\x81' + bytes([0x80 | len(payload)]) + mask + masked
            )
            response = client.recv(1024)
            self.assertIn(b'101 Switching Protocols', response)
            if b'\x88\x02\x03\xf0' not in response:
                response += client.recv(64)
            self.assertIn(b'\x88\x02\x03\xf0', response)
            capture.assert_not_called()


if __name__ == '__main__':
    unittest.main()
