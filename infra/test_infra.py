"""Offline regressions: capture geometry and public telemetry isolation."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
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
        env = patch.dict(os.environ, STATE_PATH=str(self.state))
        env.start()
        self.addCleanup(env.stop)
        self.server = telemetry.ThreadingHTTPServer(('127.0.0.1', 0), telemetry.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def test_public_state(self):
        with urlopen(self.base + '/arena/state.json?t=1') as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            self.assertEqual(json.load(response)['bots'], {})

    def test_workspace_secrets_logs_and_traversal_are_inaccessible(self):
        for path in ['/', '/arena/.env', '/bootstrap.log', '/arena/../.env', '/arena/%2e%2e/.env']:
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


class SpectatorTests(unittest.TestCase):
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
