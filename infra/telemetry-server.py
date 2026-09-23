#!/usr/bin/env python3
"""Serve only public bot telemetry; never expose the workspace or its secrets.

Paths served:
  GET  /arena/state.json     — the public state snapshot (allowlisted)
  GET  /guest/status         — guest-creeper queue status (proxied to the
  POST /guest/{join,leave,input}  guest gateway on loopback, body-capped)

The gateway itself binds loopback only; this server is the public gatekeeper.
"""
from collections import OrderedDict
from ipaddress import ip_address, ip_network
import json
import os
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
        elif path in GUEST_GET:
            self._proxy_guest('GET')
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        path = urlsplit(self.path).path
        if path == '/arena/state.json' or path in GUEST_GET or path in GUEST_POST:
            self.send_response(204)
            self._cors()
            self.end_headers()
        else:
            self.send_error(404)

    def do_POST(self):
        path = urlsplit(self.path).path
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


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('TELEMETRY_PORT', '8081'))), Handler).serve_forever()
