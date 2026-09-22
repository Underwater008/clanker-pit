#!/usr/bin/env python3
"""Restart the native display when its bot reconnects; capture stays on its tile."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

name, port, x, y = sys.argv[1:5]
state_path = Path(os.environ.get('BOT_DATA_DIR', '/workspace/arena/bot-state')) / f'mirror-{name}.json'
process = None
generation = None
started = 0
joined = False
stopping = False


def stop_child():
    global process
    if process and process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    process = None


def stop(*_):
    global stopping
    stopping = True


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    while not stopping:
        try:
            state = json.loads(state_path.read_text())
        except (OSError, ValueError):
            state = {}
        ready = state.get('ready') and time.time() * 1000 - state.get('updated', 0) < 120000
        if process and state.get('viewer'):
            joined = True
        if process and (not ready or generation != state.get('generation')):
            stop_child()
        if process and not state.get('viewer') and ((joined and time.time() - started > 15) or time.time() - started > 300):
            stop_child()
        if ready and (process is None or process.poll() is not None):
            generation = state['generation']
            started = time.time()
            joined = False
            env = dict(os.environ, MC_SERVER=f'127.0.0.1:{port}')
            process = subprocess.Popen(['bash', '/workspace/arena/capture/run-client.sh', f'View{name}', os.environ.get('NATIVE_DISPLAY', '10'), x, y], env=env, start_new_session=True)
            print(f'Native view {name} connected to mirror {port}, generation {generation}', flush=True)
        time.sleep(2)
finally:
    stop_child()
