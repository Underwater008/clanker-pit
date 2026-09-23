#!/usr/bin/env python3
"""Latest-frame guest camera over WebSocket, with no video backlog.

This is a single-purpose public service on the pod's existing HTTP port 19123.
Only the current guest token can receive frames. The gateway on loopback owns
that authorization; this process never reads queue tokens or world files.
"""

import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import os
import socket
import struct
import subprocess
from threading import Condition, Lock, Thread
import time
from urllib.request import Request, urlopen


PORT = int(os.environ.get('GUEST_PREVIEW_PORT', '19123'))
GUEST_FORWARD = os.environ.get('GUEST_FORWARD', 'http://127.0.0.1:8090')
DISPLAY = os.environ.get('NATIVE_DISPLAY', '10')
REGION_X = int(os.environ.get('GUEST_PREVIEW_X', '2560'))
REGION_Y = int(os.environ.get('GUEST_PREVIEW_Y', '720'))
FPS = int(os.environ.get('GUEST_PREVIEW_FPS', '30'))
WIDTH = int(os.environ.get('GUEST_PREVIEW_WIDTH', '640'))
HEIGHT = int(os.environ.get('GUEST_PREVIEW_HEIGHT', '360'))
MAX_JPEG_BYTES = 2 * 1024 * 1024
MAX_CLIENTS = 2
WEBSOCKET_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
CLIENT_SLOTS = Lock()
active_clients = 0


class JpegFrames:
    """Extract complete JPEG images from arbitrary FFmpeg pipe chunks."""

    def __init__(self, max_bytes=MAX_JPEG_BYTES):
        self.pending = bytearray()
        self.max_bytes = max_bytes

    def feed(self, chunk):
        self.pending.extend(chunk)
        frames = []
        while self.pending:
            start = self.pending.find(b'\xff\xd8')
            if start < 0:
                self.pending[:] = self.pending[-1:]
                break
            if start:
                del self.pending[:start]
            end = self.pending.find(b'\xff\xd9', 2)
            if end < 0:
                if len(self.pending) > self.max_bytes:
                    self.pending.clear()
                break
            end += 2
            if end <= self.max_bytes:
                frames.append(bytes(self.pending[:end]))
            del self.pending[:end]
        return frames


def websocket_binary(payload):
    size = len(payload)
    if size < 126:
        header = bytes((0x82, size))
    elif size < 65536:
        header = b'\x82\x7e' + struct.pack('!H', size)
    else:
        header = b'\x82\x7f' + struct.pack('!Q', size)
    return header + payload


def authorized(token):
    if not isinstance(token, str) or not 16 <= len(token) <= 100:
        return False
    body = json.dumps({'token': token}).encode()
    request = Request(
        GUEST_FORWARD + '/video-auth', data=body, method='POST',
        headers={'Content-Type': 'application/json'},
    )
    try:
        with urlopen(request, timeout=2) as response:
            return response.status == 200 and json.load(response).get('ok') is True
    except (OSError, ValueError):
        return False


class LatestFrame:
    """Capture continuously so a slow receiver never accumulates old frames."""

    def __init__(self):
        command = [
            'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
            '-filter_threads', '1', '-f', 'x11grab',
            '-video_size', '1280x720', '-framerate', str(FPS),
            '-i', f':{DISPLAY}.0+{REGION_X},{REGION_Y}',
            '-vf', f'scale={WIDTH}:{HEIGHT}:flags=fast_bilinear',
            '-q:v', '7', '-c:v', 'mjpeg', '-f', 'image2pipe', '-',
        ]
        self.process = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, start_new_session=True,
            env=dict(os.environ, DISPLAY=f':{DISPLAY}'),
        )
        self.condition = Condition()
        self.latest = None
        self.sequence = 0
        self.closed = False
        self.thread = Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self):
        parser = JpegFrames()
        try:
            while not self.closed:
                # read1 returns as soon as a pipe chunk arrives. read(n) waits
                # to fill n bytes and bundles several frames into a burst.
                chunk = self.process.stdout.read1(32768)
                if not chunk:
                    break
                for jpeg in parser.feed(chunk):
                    with self.condition:
                        self.latest = (int(time.time() * 1000), jpeg)
                        self.sequence += 1
                        self.condition.notify_all()
        finally:
            with self.condition:
                self.closed = True
                self.condition.notify_all()

    def next(self, after, timeout=8):
        with self.condition:
            self.condition.wait_for(
                lambda: self.sequence > after or self.closed, timeout=timeout,
            )
            if self.sequence <= after:
                return None
            return self.sequence, self.latest

    def stop(self):
        self.closed = True
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.thread.join(timeout=2)


def read_client_token(stream):
    """Accept only one small, masked WebSocket text frame for authentication."""
    header = stream.read(2)
    if len(header) != 2 or header[0] != 0x81 or not header[1] & 0x80:
        return None
    size = header[1] & 0x7f
    if size == 126:
        raw = stream.read(2)
        if len(raw) != 2:
            return None
        size = struct.unpack('!H', raw)[0]
    if size > 256 or size == 127:
        return None
    mask = stream.read(4)
    payload = stream.read(size)
    if len(mask) != 4 or len(payload) != size:
        return None
    try:
        return json.loads(bytes(value ^ mask[index % 4] for index, value in enumerate(payload))).get('token')
    except (UnicodeDecodeError, ValueError, AttributeError):
        return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def do_GET(self):
        global active_clients
        if self.path == '/health':
            body = b'ok'
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path != '/frames':
            self.send_error(404)
            return
        key = self.headers.get('Sec-WebSocket-Key', '')
        try:
            valid_key = len(base64.b64decode(key, validate=True)) == 16
        except (ValueError, base64.binascii.Error):
            valid_key = False
        if (not valid_key or self.headers.get('Upgrade', '').lower() != 'websocket' or
                self.headers.get('Sec-WebSocket-Version') != '13'):
            self.send_error(400, 'WebSocket upgrade required')
            return
        with CLIENT_SLOTS:
            if active_clients >= MAX_CLIENTS:
                self.send_error(503, 'Guest preview busy')
                return
            active_clients += 1
        producer = None
        try:
            accept = base64.b64encode(hashlib.sha1((key + WEBSOCKET_MAGIC).encode()).digest()).decode()
            self.send_response(101)
            self.send_header('Upgrade', 'websocket')
            self.send_header('Connection', 'Upgrade')
            self.send_header('Sec-WebSocket-Accept', accept)
            self.end_headers()
            self.connection.settimeout(5)
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 65536)
            token = read_client_token(self.rfile)
            if not authorized(token):
                self.connection.sendall(b'\x88\x02\x03\xf0')  # policy violation
                return
            producer = LatestFrame()
            last_sequence = 0
            last_auth = time.monotonic()
            while True:
                if time.monotonic() - last_auth >= 2:
                    if not authorized(token):
                        break
                    last_auth = time.monotonic()
                result = producer.next(last_sequence, timeout=1)
                if result is None:
                    if producer.closed:
                        break
                    continue
                last_sequence, (encoded_at, jpeg) = result
                payload = struct.pack('!Q', encoded_at) + jpeg
                self.connection.sendall(websocket_binary(payload))
        except (BrokenPipeError, ConnectionError, OSError):
            pass
        finally:
            if producer:
                producer.stop()
            with CLIENT_SLOTS:
                active_clients -= 1


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
