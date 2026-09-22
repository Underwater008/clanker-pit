#!/usr/bin/env python3
"""Serve only public bot telemetry; never expose the workspace or its secrets."""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if urlsplit(self.path).path != '/arena/state.json':
            self.send_error(404)
            return
        try:
            # Validate before sending: a writer may be replacing the snapshot.
            data = Path(os.environ.get('STATE_PATH', '/workspace/arena/state.json')).read_bytes()
            json.loads(data)
        except (OSError, ValueError):
            self.send_error(503, 'Telemetry not ready')
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('TELEMETRY_PORT', '8081'))), Handler).serve_forever()
