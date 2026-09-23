#!/usr/bin/env python3
"""Serve only public bot telemetry; never expose the workspace or its secrets.

Paths served:
  GET  /arena/state.json     — the public state snapshot (allowlisted)
  GET  /guest/status         — guest-creeper queue status (proxied to the
  POST /guest/{join,leave,input}  guest gateway on loopback, body-capped)

The gateway itself binds loopback only; this server is the public gatekeeper.
"""
from collections import OrderedDict
import base64
import hashlib
from ipaddress import ip_address, ip_network
import json
import os
import socket
import struct
import re
import time
from threading import Lock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

GUEST_BODY_LIMIT = 8 * 1024
GUEST_TIMEOUT = 10
GUEST_GET = {'/guest/status'}
GUEST_POST = {'/guest/join', '/guest/leave', '/guest/input'}
WHEP_SESSION = re.compile(r'^/guest/whep/[A-Za-z0-9_-]{1,100}$')
WEBSOCKET_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
# RunPod forwards public HTTP through shared peers. Trust a single client-IP
# header only when the socket peer belongs to an explicitly configured proxy
# network; direct clients cannot choose their own limiter identity.
JOIN_WINDOW_SECONDS = 600
# A guest may die during arrival or finish a short turn and need to rejoin.
# Keep a bounded per-client limit without locking them out after two tries.
JOIN_MAX_PER_IP = 6
JOIN_MAX_IDENTITIES = 10000
JOIN_PRUNE_INTERVAL_SECONDS = 30
_join_times = OrderedDict()
_join_lock = Lock()
_join_last_prune = 0.0


def _address(value):
    try:
        if '%' in value:
            return None
        address = ip_address(value.strip())
        return getattr(address, 'ipv4_mapped', None) or address
    except (ValueError, TypeError, AttributeError):
        return None


def client_identity(peer, headers):
    address = _address(peer)
    fallback = str(address) if address else 'unknown'
    header = os.environ.get('TELEMETRY_CLIENT_IP_HEADER', '').strip()
    if address is None or not header:
        return fallback
    try:
        networks = [ip_network(cidr.strip(), strict=False) for cidr in
                    os.environ.get('TELEMETRY_TRUSTED_PROXY_CIDRS', '').split(',') if cidr.strip()]
    except ValueError:
        return fallback  # a malformed trust configuration must not trust all peers
    if not any(address in network for network in networks):
        return fallback
    # This is deliberately a single-address contract (e.g. CF-Connecting-IP),
    # not the leftmost untrusted value of an X-Forwarded-For chain.
    values = headers.get_all(header) if hasattr(headers, 'get_all') else [headers.get(header)]
    if not values or len(values) != 1:
        return fallback
    forwarded = _address(values[0])
    return str(forwarded) if forwarded else fallback


def _join_throttled(identity):
    global _join_last_prune
    now = time.monotonic()
    cutoff = now - JOIN_WINDOW_SECONDS
    with _join_lock:
        # ThreadingHTTPServer can handle simultaneous joins. Pruning and the
        # read/check/append must be one transaction or a burst bypasses limits.
        if now - _join_last_prune >= JOIN_PRUNE_INTERVAL_SECONDS or len(_join_times) >= JOIN_MAX_IDENTITIES:
            expired = [key for key, times in _join_times.items() if not times or times[-1] <= cutoff]
            for key in expired:
                del _join_times[key]
            _join_last_prune = now
        times = [stamp for stamp in _join_times.get(identity, []) if stamp > cutoff]
        throttled = len(times) >= JOIN_MAX_PER_IP
        if not throttled:
            times.append(now)
        if identity not in _join_times and len(_join_times) >= JOIN_MAX_IDENTITIES:
            _join_times.popitem(last=False)
        _join_times[identity] = times
        _join_times.move_to_end(identity)
        return throttled


def guest_upstream():
    # Read per-request so tests (and future reconfiguration) take effect.
    return os.environ.get('GUEST_FORWARD', 'http://127.0.0.1:8090')


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'no-store')

    def _state_snapshot(self):
        try:
            # Validate before sending: a writer may be replacing the snapshot.
            data = Path(os.environ.get('STATE_PATH', '/workspace/arena/state.json')).read_bytes()
            json.loads(data)
        except (OSError, ValueError):
            self.send_error(503, 'Telemetry not ready')
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self._cors()
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _proxy_guest(self, method, body=None):
        url = guest_upstream() + self.path[len('/guest'):]
        request = Request(
            url,
            data=body,
            method=method,
            headers={'Content-Type': self.headers.get('Content-Type', 'application/json')},
        )
        try:
            with urlopen(request, timeout=GUEST_TIMEOUT) as response:
                payload = response.read()
                self.send_response(response.status)
                self.send_header('Content-Type', response.headers.get('Content-Type', 'application/json'))
                self._cors()
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        except URLError as error:
            code = getattr(error, 'code', None)
            if code:
                # The gateway answered with an HTTP error (e.g. bad nickname).
                try:
                    payload = error.read()
                except Exception:
                    payload = b'{"error": "gateway rejected the request"}'
                self.send_response(code)
                self.send_header('Content-Type', 'application/json')
                self._cors()
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            else:
                self.send_error(502, 'Guest gateway unavailable')

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/arena/state.json':
            self._state_snapshot()
        elif path == '/guest/control':
            self._guest_control()
        elif path in GUEST_GET:
            self._proxy_guest('GET')
        else:
            self.send_error(404)

    def _guest_control(self):
        """A bounded WebSocket input pipe; the gateway still owns authorization."""
        key = self.headers.get('Sec-WebSocket-Key', '')
        if (self.headers.get('Upgrade', '').lower() != 'websocket' or
                self.headers.get('Connection', '').lower().find('upgrade') < 0 or
                self.headers.get('Sec-WebSocket-Version') != '13'):
            self.send_error(400, 'WebSocket upgrade required')
            return
        try:
            if len(base64.b64decode(key, validate=True)) != 16:
                raise ValueError('invalid WebSocket key')
        except (ValueError, base64.binascii.Error):
            self.send_error(400, 'Invalid WebSocket key')
            return
        accept = base64.b64encode(hashlib.sha1((key + WEBSOCKET_MAGIC).encode()).digest()).decode()
        self.send_response(101)
        self.send_header('Upgrade', 'websocket')
        self.send_header('Connection', 'Upgrade')
        self.send_header('Sec-WebSocket-Accept', accept)
        self.end_headers()
        self.connection.settimeout(12)
        last_input = 0.0
        for _ in range(5000):  # turn lifetime plus a generous reconnect window
            try:
                header = self.rfile.read(2)
                if len(header) != 2:
                    break
                opcode = header[0] & 0x0f
                masked = bool(header[1] & 0x80)
                size = header[1] & 0x7f
                if size == 126:
                    size = struct.unpack('!H', self.rfile.read(2))[0]
                if not (header[0] & 0x80) or not masked or size > 4096 or size == 127:
                    break
                mask = self.rfile.read(4)
                data = self.rfile.read(size)
                if len(mask) != 4 or len(data) != size:
                    break
                if opcode == 8:
                    break
                if opcode == 9:
                    self.wfile.write(bytes((0x8a, size)) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))
                    self.wfile.flush()
                    continue
                if opcode != 1:
                    break
                now = time.monotonic()
                if now - last_input < 0.035:
                    continue
                last_input = now
                decoded = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
                try:
                    message = json.loads(decoded)
                    if not isinstance(message, dict) or not isinstance(message.get('token'), str):
                        break
                    request = Request(guest_upstream() + '/input', decoded,
                                      {'Content-Type': 'application/json'}, method='POST')
                    with urlopen(request, timeout=2) as response:
                        response.read(128)
                except (ValueError, UnicodeDecodeError, URLError, TimeoutError, socket.timeout):
                    break
            except (OSError, struct.error):
                break
        self.close_connection = True

    def _guest_whep(self, method):
        """Expose guest WHEP signaling only; MediaMTX media uses ICE directly."""
        path = urlsplit(self.path).path
        if not (path == '/guest/whep' and method == 'POST' or
                WHEP_SESSION.fullmatch(path) and method == 'DELETE'):
            self.send_error(404)
            return
        body = None
        if method == 'POST':
            try:
                length = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                length = -1
            if length < 1 or length > 65536:
                self.send_error(413)
                return
            body = self.rfile.read(length)
        request = Request('http://127.0.0.1:8889' + path, body, method=method,
                          headers={'Content-Type': 'application/sdp'} if body else {})
        try:
            response = urlopen(request, timeout=8)
        except URLError as error:
            if getattr(error, 'code', None):
                response = error
            else:
                self.send_error(502, 'Guest WebRTC unavailable')
                return
        with response:
            payload = response.read(65537)
            if len(payload) > 65536:
                self.send_error(502, 'WHEP response too large')
                return
            self.send_response(response.status)
            self.send_header('Content-Type', response.headers.get('Content-Type', 'application/sdp'))
            self._cors()
            location = response.headers.get('Location')
            if location:
                session_path = urlsplit(location).path
                if WHEP_SESSION.fullmatch(session_path):
                    self.send_header('Location', session_path)
                    self.send_header('Access-Control-Expose-Headers', 'Location')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    def do_OPTIONS(self):
        path = urlsplit(self.path).path
        if path == '/arena/state.json' or path in GUEST_GET or path in GUEST_POST or path == '/guest/whep':
            self.send_response(204)
            self._cors()
            self.end_headers()
        else:
            self.send_error(404)

    def do_POST(self):
        path = urlsplit(self.path).path
        if path == '/guest/whep':
            self._guest_whep('POST')
            return
        if path not in GUEST_POST:
            self.send_error(404)
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            self.send_error(400)
            return
        # Negative lengths must never reach rfile.read() (an unbounded read).
        if length < 0:
            self.send_error(400)
            return
        if length > GUEST_BODY_LIMIT:
            # Drain a bounded amount so well-behaved clients can finish
            # sending and read the 413 instead of hitting a connection reset.
            if length <= 1024 * 1024:
                self.rfile.read(length)
            self.send_error(413)
            return
        body = self.rfile.read(length) if length else b''
        if path == '/guest/join' and _join_throttled(client_identity(self.client_address[0] if self.client_address else '', self.headers)):
            payload = json.dumps(
                {'error': 'Slow down - the queue is for everyone'}
            ).encode()
            self.send_response(429)
            self.send_header('Content-Type', 'application/json')
            self._cors()
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self._proxy_guest('POST', body)

    def do_DELETE(self):
        self._guest_whep('DELETE')


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('TELEMETRY_PORT', '8081'))), Handler).serve_forever()
