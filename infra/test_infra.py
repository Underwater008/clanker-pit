"""Offline regressions: capture geometry and public telemetry isolation."""
from concurrent.futures import ThreadPoolExecutor
from email.message import Message
import importlib.util
import json
import os
from http.server import BaseHTTPRequestHandler
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
import urllib.request
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('telemetry', ROOT / 'telemetry-server.py')
telemetry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(telemetry)


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin = Path(self.tmp.name)
        stub = self.bin / 'xdpyinfo'
        stub.write_text('#!/bin/sh\n[ -n "$TEST_DIMENSIONS" ] || exit 1\nprintf "  dimensions: %s pixels\\n" "$TEST_DIMENSIONS"\n')
        stub.chmod(0o755)

    def run_script(self, script, args, dimensions):
        env = dict(os.environ, PATH=f'{self.bin}:{os.environ["PATH"]}', TEST_DIMENSIONS=dimensions)
        return subprocess.run(['bash', str(ROOT / 'capture' / script), *args], env=env, capture_output=True, text=True, timeout=3)

    def test_offscreen_captures_fail_before_encoder(self):
        for x, y in [('2560', '0'), ('0', '720'), ('1280', '720'), ('1280', '0')]:
            with self.subTest(x=x, y=y):
                result = self.run_script('run-stream.sh', ['10', 'arena', x, y], '1280x720')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('exceeds display', result.stderr)

    def test_tiled_client_cannot_create_small_fallback(self):
        result = self.run_script('run-client.sh', ['ClankerCam', '10', '2560', '0'], '')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unavailable', result.stderr)

    def test_relaunch_validates_before_stopping_existing_cameras(self):
        result = self.run_script('launch-cameras.sh', [], '1280x720')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('exceeds display', result.stderr)

    def test_full_layout_and_single_display_are_valid(self):
        env = dict(os.environ, PATH=f'{self.bin}:{os.environ["PATH"]}')
        for dimensions, x, y in [('3840x1440', '2560', '0'), ('3840x1440', '1280', '720'), ('1280x720', '0', '0')]:
            result = subprocess.run(['bash', '-c', 'source "$1"; require_capture_region 10 "$2" "$3"', '_', str(ROOT / 'capture/display.sh'), x, y], env=dict(env, TEST_DIMENSIONS=dimensions), capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)


class TelemetryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / 'state.json'
        self.state.write_text(json.dumps({'updated': 'now', 'bots': {}}))
        (Path(self.tmp.name) / '.env').write_text('SECRET=must-not-be-public')
        # A stub guest gateway on loopback: it records what the public
        # telemetry server forwards.
        self.upstream = telemetry.ThreadingHTTPServer(('127.0.0.1', 0), StubGateway)
        StubGateway.requests.clear()
        StubGateway.next_payload = {}
        StubGateway.next_status = 200
        telemetry._join_times.clear()
        threading.Thread(target=self.upstream.serve_forever, daemon=True).start()
        self.addCleanup(self.upstream.server_close)
        self.addCleanup(self.upstream.shutdown)
        env = patch.dict(os.environ, {
            'STATE_PATH': str(self.state),
            'GUEST_FORWARD': f'http://127.0.0.1:{self.upstream.server_port}',
            'TELEMETRY_TRUSTED_PROXY_CIDRS': '',
            'TELEMETRY_CLIENT_IP_HEADER': '',
        })
        env.start()
        self.addCleanup(env.stop)
        self.server = telemetry.ThreadingHTTPServer(('127.0.0.1', 0), telemetry.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def request(self, path, method='GET', body=None, headers=None):
        req = urllib.request.Request(self.base + path, data=body, method=method,
                                     headers=headers or {})
        with urlopen(req) as response:
            return response, json.load(response)

    def test_public_state(self):
        with urlopen(self.base + '/arena/state.json?t=1') as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            self.assertEqual(response.headers['Access-Control-Allow-Origin'], '*')
            self.assertEqual(json.load(response)['bots'], {})

    def test_workspace_secrets_logs_and_traversal_are_inaccessible(self):
        for path in ['/', '/arena/.env', '/bootstrap.log', '/arena/../.env', '/arena/%2e%2e/.env',
                     '/guest/secret', '/guest/../gateway.js', '/guest/input/../../x']:
            with self.subTest(path=path), self.assertRaises(HTTPError) as error:
                urlopen(self.base + path)
            self.assertEqual(error.exception.code, 404)
            error.exception.close()

    def test_partial_snapshot_is_reported_unavailable(self):
        self.state.write_text('{')
        with self.assertRaises(HTTPError) as error:
            urlopen(self.base + '/arena/state.json')
        self.assertEqual(error.exception.code, 503)
        error.exception.close()

    def test_guest_status_is_proxied_with_cors(self):
        StubGateway.next_payload = {'ok': True, 'queueLength': 2, 'active': None}
        response, payload = self.request('/guest/status')
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers['Access-Control-Allow-Origin'], '*')
        self.assertEqual(payload['queueLength'], 2)
        self.assertEqual(StubGateway.requests, [('GET', '/status', None)])

    def test_guest_join_forwards_the_body(self):
        StubGateway.next_payload = {'ok': True, 'token': 't'}
        response, payload = self.request('/guest/join', method='POST',
                                         body=json.dumps({'nickname': 'Ada'}).encode(),
                                         headers={'Content-Type': 'text/plain'})
        self.assertEqual(payload['token'], 't')
        self.assertEqual(StubGateway.requests,
                         [('POST', '/join', json.dumps({'nickname': 'Ada'}).encode())])

    def test_oversized_guest_bodies_are_rejected_before_the_gateway(self):
        try:
            self.request('/guest/input', method='POST', body=b'x' * (telemetry.GUEST_BODY_LIMIT + 1))
            self.fail('oversized body accepted')
        except HTTPError as error:
            self.assertEqual(error.code, 413)
            error.close()
        self.assertEqual(StubGateway.requests, [])

    def test_negative_content_length_is_rejected(self):
        req = urllib.request.Request(self.base + '/guest/input', method='POST',
                                     headers={'Content-Length': '-5'}, data=b'')
        with self.assertRaises(HTTPError) as error:
            urlopen(req)
        self.assertEqual(error.exception.code, 400)
        error.exception.close()
        self.assertEqual(StubGateway.requests, [])

    def test_join_throttling_happens_here_not_at_the_gateway(self):
        # Behind this proxy the gateway only ever sees 127.0.0.1, so the
        # per-IP limit is enforced at this public boundary.
        StubGateway.next_payload = {'ok': True, 'token': 't'}
        headers = {'Content-Type': 'text/plain', 'Content-Length': '2'}
        for expected in [200] * telemetry.JOIN_MAX_PER_IP + [429, 429]:
            req = urllib.request.Request(self.base + '/guest/join', method='POST',
                                         data=b'{}', headers=headers)
            with self.subTest(expected=expected):
                try:
                    with urlopen(req) as response:
                        self.assertEqual(response.status, expected)
                except HTTPError as error:
                    self.assertEqual(error.code, expected)
                    error.close()

    def test_two_visitors_behind_one_trusted_proxy_do_not_share_join_limit(self):
        with patch.dict(os.environ, {
            'TELEMETRY_TRUSTED_PROXY_CIDRS': '127.0.0.1/32',
            'TELEMETRY_CLIENT_IP_HEADER': 'CF-Connecting-IP',
        }):
            attempts = [('203.0.113.1', 200)] * telemetry.JOIN_MAX_PER_IP + [
                ('203.0.113.1', 429), ('203.0.113.2', 200)]
            for visitor, expected in attempts:
                try:
                    response, _ = self.request('/guest/join', method='POST', body=b'{}',
                                               headers={'CF-Connecting-IP': visitor})
                    self.assertEqual(response.status, expected)
                except HTTPError as error:
                    self.assertEqual(error.code, expected)
                    error.close()

    def test_preflight_options_are_allowed_for_guest_paths(self):
        req = urllib.request.Request(self.base + '/guest/input', method='OPTIONS')
        with urlopen(req) as response:
            self.assertEqual(response.status, 204)
            self.assertEqual(response.headers['Access-Control-Allow-Origin'], '*')

    def test_gateway_rejection_reaches_the_browser(self):
        StubGateway.next_status = 400
        StubGateway.next_payload = {'error': 'Pick a name'}
        try:
            self.request('/guest/join', method='POST', body=b'{}')
            self.fail('rejection swallowed')
        except HTTPError as error:
            self.assertEqual(error.code, 400)
            self.assertEqual(json.load(error)['error'], 'Pick a name')
            error.close()

    def test_gateway_downtime_is_a_502_not_a_leak(self):
        self.upstream.shutdown()
        self.upstream.server_close()
        try:
            self.request('/guest/status')
            self.fail('downtime swallowed')
        except HTTPError as error:
            self.assertEqual(error.code, 502)
            body = error.read()
            self.assertNotIn(b'Secret', body)
            error.close()


class ProxyIdentityTests(unittest.TestCase):
    def setUp(self):
        telemetry._join_times.clear()
        telemetry._join_last_prune = 0.0
        env = patch.dict(os.environ, {
            'TELEMETRY_TRUSTED_PROXY_CIDRS': '100.64.1.0/24',
            'TELEMETRY_CLIENT_IP_HEADER': 'CF-Connecting-IP',
        })
        env.start()
        self.addCleanup(env.stop)

    def test_only_the_explicit_proxy_boundary_can_supply_identity(self):
        headers = {'CF-Connecting-IP': '203.0.113.10', 'X-Forwarded-For': '198.51.100.99'}
        self.assertEqual(telemetry.client_identity('100.64.1.97', headers), '203.0.113.10')
        self.assertEqual(telemetry.client_identity('198.51.100.9', headers), '198.51.100.9')
        self.assertEqual(telemetry.client_identity('100.64.2.97', headers), '100.64.2.97')
        self.assertEqual(telemetry.client_identity('::ffff:100.64.1.97', headers), '203.0.113.10')

    def test_no_configuration_or_malformed_headers_never_enable_implicit_trust(self):
        with patch.dict(os.environ, {'TELEMETRY_TRUSTED_PROXY_CIDRS': ''}):
            self.assertEqual(telemetry.client_identity('100.64.1.97', {'CF-Connecting-IP': '203.0.113.10'}), '100.64.1.97')
        with patch.dict(os.environ, {'TELEMETRY_TRUSTED_PROXY_CIDRS': 'invalid'}):
            self.assertEqual(telemetry.client_identity('100.64.1.97', {'CF-Connecting-IP': '203.0.113.10'}), '100.64.1.97')
        for value in [None, 'unknown', '203.0.113.10, 198.51.100.99', '::1%eth0']:
            self.assertEqual(telemetry.client_identity('100.64.1.97', {'CF-Connecting-IP': value}), '100.64.1.97')
        duplicate = Message()
        duplicate['CF-Connecting-IP'] = '203.0.113.10'
        duplicate['CF-Connecting-IP'] = '198.51.100.99'
        self.assertEqual(telemetry.client_identity('100.64.1.97', duplicate), '100.64.1.97')

    def test_simultaneous_joins_cannot_race_the_check_and_append(self):
        with ThreadPoolExecutor(max_workers=16) as pool:
            throttled = list(pool.map(lambda _: telemetry._join_throttled('visitor'), range(64)))
        self.assertEqual(throttled.count(False), telemetry.JOIN_MAX_PER_IP)
        self.assertEqual(throttled.count(True), 64 - telemetry.JOIN_MAX_PER_IP)

    def test_limiter_expires_old_visitors_and_stays_bounded(self):
        with patch.object(telemetry, 'JOIN_MAX_IDENTITIES', 3):
            with patch.object(telemetry.time, 'monotonic', return_value=1000):
                for number in range(8):
                    telemetry._join_throttled(str(number))
                self.assertEqual(len(telemetry._join_times), 3)
            with patch.object(telemetry.time, 'monotonic', return_value=1700):
                self.assertFalse(telemetry._join_throttled('new'))
                self.assertEqual(list(telemetry._join_times), ['new'])


class StubGateway(BaseHTTPRequestHandler):
    requests: list = []
    next_payload: dict = {}
    next_status: int = 200

    def _respond(self):
        StubGateway.requests.append((self.command, self.path, self.rfile.read(int(self.headers.get('Content-Length') or 0)) or None))
        payload = json.dumps(StubGateway.next_payload).encode()
        self.send_response(StubGateway.next_status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self._respond()

    def do_POST(self):
        self._respond()

    def log_message(self, format, *args):
        pass


class SpectatorTests(unittest.TestCase):
    def run_camera_fixture(self, marker, scenario='village'):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            script = tmp / 'spectate.mjs'
            script.write_text((ROOT / 'capture/spectate-loop.mjs').read_text())
            if marker is not None:
                (tmp / 'village.json').write_text(json.dumps(marker))
            package = tmp / 'node_modules/rcon-client'
            package.mkdir(parents=True)
            (package / 'package.json').write_text(json.dumps({'type': 'module', 'exports': './index.js'}))
            (package / 'index.js').write_text('''
import { EventEmitter } from 'node:events';
export class Rcon extends EventEmitter {
  static async connect(options) { console.log('PORT ' + options.port); return new Rcon(); }
  async send(command) {
    console.log('COMMAND ' + command);
    if (command === 'spectate Tally CamTally') process.exit(0);
    return 'ok';
  }
  async end() {}
}
''')
            result = subprocess.run(
                ['node', str(script)],
                env=dict(os.environ, NATIVE_MIRRORS='0', BOT_DATA_DIR=str(tmp), SCENARIO=scenario, RCON_PORT='25577'),
                capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout

    def test_village_overview_positions_only_wide_camera_and_faces_flag(self):
        output = self.run_camera_fixture({'flag': {'x': -152, 'y': 63, 'z': -168}})
        teleports = [line for line in output.splitlines() if line.startswith('COMMAND teleport ')]
        self.assertEqual(teleports, ['COMMAND teleport ClankerCam -127.5 83 -139.5 facing -151.5 64.5 -167.5'])
        self.assertIn('PORT 25577', output)
        self.assertIn('COMMAND spectate Mira CamMira', output)

    def test_missing_invalid_or_survival_fixture_leaves_wide_pose_unchanged(self):
        for marker, scenario in [
            (None, 'village'),
            ({'flag': None}, 'village'),
            ({'flag': {'x': '0; op intruder', 'y': 63, 'z': 0}}, 'village'),
            ({'flag': {'x': 0, 'y': 999, 'z': 0}}, 'village'),
            ({'flag': {'x': 0, 'y': 63, 'z': 0}}, 'survival'),
        ]:
            with self.subTest(marker=marker, scenario=scenario):
                output = self.run_camera_fixture(marker, scenario)
                self.assertNotIn('COMMAND teleport ', output)
                self.assertIn('COMMAND gamemode spectator ClankerCam', output)

    def test_reconnects_and_rebinds_after_server_disconnect(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            script = tmp / 'spectate.mjs'
            script.write_text((ROOT / 'capture/spectate-loop.mjs').read_text())
            package = tmp / 'node_modules/rcon-client'
            package.mkdir(parents=True)
            (package / 'package.json').write_text(json.dumps({'type': 'module', 'exports': './index.js'}))
            (package / 'index.js').write_text('''
import { EventEmitter } from 'node:events';
let connections = 0;
export class Rcon extends EventEmitter {
  static async connect() { const r = new Rcon(); r.number = ++connections; return r; }
  async send(command) {
    if (this.number === 1) throw new Error('simulated disconnect');
    console.log('COMMAND ' + command);
    if (command === 'spectate Tally CamTally') process.exit(0);
  }
  async end() { console.log('CLOSED ' + this.number); }
}
''')
            result = subprocess.run(['node', str(script)], env=dict(os.environ, NATIVE_MIRRORS='0'), capture_output=True, text=True, timeout=12)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('rcon_reconnecting', result.stdout)
            self.assertIn('CLOSED 1', result.stdout)
            self.assertEqual(result.stdout.count('rcon_connected'), 2)
            for name in ['ClankerCam', 'CamCinder', 'CamVex', 'CamMira', 'CamTally']:
                self.assertIn('COMMAND gamemode spectator ' + name, result.stdout)


if __name__ == '__main__':
    unittest.main()
