#!/usr/bin/env python3
"""Serve only public bot telemetry; never expose the workspace or its secrets.

Paths served:
  GET  /arena/state.json     — the public state snapshot (allowlisted)
  GET  /guest/status         — guest-creeper queue status (proxied to the
  POST /guest/{join,leave,input}  guest gateway on loopback, body-capped)

The gateway itself binds loopback only; this server is the public gatekeeper.
"""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

GUEST_BODY_LIMIT = 8 * 1024
GUEST_TIMEOUT = 10
GUEST_GET = {'/guest/status'}
GUEST_POST = {'/guest/join', '/guest/leave', '/guest/input'}


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
        if length > GUEST_BODY_LIMIT:
            # Drain a bounded amount so well-behaved clients can finish
            # sending and read the 413 instead of hitting a connection reset.
            if length <= 1024 * 1024:
                self.rfile.read(length)
            self.send_error(413)
            return
        body = self.rfile.read(length) if length else b''
        self._proxy_guest('POST', body)


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('TELEMETRY_PORT', '8081'))), Handler).serve_forever()
