import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class PodStatusTests(unittest.TestCase):
    def test_explicit_stream_pod_overrides_stale_local_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'infra').mkdir()
            (root / 'stage0').mkdir()
            (root / 'bin').mkdir()
            shutil.copyfile(Path(__file__).with_name('pod-status.sh'), root / 'infra/pod-status.sh')
            (root / 'stage0/.env').write_text('RUNPOD_API_KEY=test-only\n')
            (root / 'infra/pod.json').write_text(json.dumps({'id': 'old-pod'}))
            stub = root / 'bin/curl'
            stub.write_text('''#!/usr/bin/env python3
import json, re, sys
query = json.loads(sys.argv[sys.argv.index('-d') + 1])['query']
pod = re.search(r'podId: "([a-zA-Z0-9_-]+)"', query).group(1)
print(json.dumps({'data': {'pod': {'id': pod, 'desiredStatus': 'RUNNING', 'machine': {'podHostId': pod + '-host'}, 'runtime': {'ports': [{'privatePort': 22, 'isIpPublic': True, 'publicPort': 12345, 'ip': '192.0.2.1'}]}}}}))
''')
            stub.chmod(0o755)
            env = dict(os.environ, PATH=f'{root / "bin"}:{os.environ["PATH"]}', CLANKER_POD_ID='env-pod')
            result = subprocess.run(['bash', str(root / 'infra/pod-status.sh'), '--pod-id', 'stream-pod'], env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('pod: stream-pod', result.stdout)
            self.assertIn('-p 12345 root@192.0.2.1', result.stdout)
            self.assertIn('stream-pod-host@ssh.runpod.io', result.stdout)
            self.assertNotIn('test-only', result.stdout)
            invalid = subprocess.run(['bash', str(root / 'infra/pod-status.sh'), '--pod-id', 'bad"id'], env=env, text=True, capture_output=True)
            self.assertEqual(invalid.returncode, 2)
            self.assertIn('Invalid pod id', invalid.stderr)


if __name__ == '__main__':
    unittest.main()
