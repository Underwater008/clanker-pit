"""The capture command must normalize missed grabs before publishing RTMP."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
FFMPEG = shutil.which('ffmpeg')
FFPROBE = shutil.which('ffprobe')


@unittest.skipUnless(FFMPEG and FFPROBE, 'FFmpeg tools required for timing integration')
class CaptureTimingTests(unittest.TestCase):
    def test_missed_grabs_still_produce_regular_output_timestamps(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            args_path = tmp / 'capture-args.json'
            # Inspect the actual launcher command without an X display or a
            # public publisher. End its restart loop after one capture attempt.
            stubs = {
                'xdpyinfo': '#!/bin/sh\necho "dimensions: 1280x720 pixels"\n',
                'sleep': '#!/bin/sh\nexit 1\n',
                'ffmpeg': '#!/usr/bin/env python3\nimport json, os, sys\n'
                          'if "lavfi" in sys.argv: sys.exit(1)\n'
                          'with open(os.environ["CAPTURE_ARGS"], "w") as f: json.dump(sys.argv[1:], f)\n',
            }
            for name, source in stubs.items():
                path = tmp / name
                path.write_text(source)
                path.chmod(0o755)
            subprocess.run(['bash', str(ROOT / 'capture/run-stream.sh'), '10', 'timing'],
                           env=dict(os.environ, PATH=f'{tmp}:{os.environ["PATH"]}',
                                    CAPTURE_ARGS=str(args_path), STREAM_FPS='30'),
                           capture_output=True, text=True, timeout=5)
            args = json.loads(args_path.read_text())
            timing = []
            for option in ['-vf', '-r', '-vsync', '-fps_mode']:
                if option in args:
                    timing.extend([option, args[args.index(option) + 1]])
            output = tmp / 'timing.flv'
            # Drop every fifth source frame while retaining its clock. The old
            # launcher passes 66/67ms gaps through; CFR must duplicate frames.
            subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error',
                            '-f', 'lavfi', '-i',
                            "testsrc2=size=160x90:rate=30,select='not(eq(mod(n,5),0))'",
                            *timing, '-c:v', 'libx264', '-preset', 'ultrafast',
                            '-tune', 'zerolatency', '-t', '2', '-an', '-f', 'flv', str(output)],
                           capture_output=True, text=True, check=True, timeout=10)
            probe = subprocess.run([FFPROBE, '-v', 'error', '-select_streams', 'v:0',
                                    '-show_entries', 'packet=pts_time', '-of', 'json', str(output)],
                                   capture_output=True, text=True, check=True, timeout=5)
            stamps = [float(p['pts_time']) for p in json.loads(probe.stdout)['packets']]
            intervals = [round((b - a) * 1000) for a, b in zip(stamps, stamps[1:])]
            self.assertGreaterEqual(len(stamps), 58)
            self.assertTrue(all(delta in (33, 34) for delta in intervals), intervals)


if __name__ == '__main__':
    unittest.main()
