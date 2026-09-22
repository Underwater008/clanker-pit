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
viewer_seen_at = None
hud_hidden = False


def hide_guest_hud():
    """Toggle only the ViewGuest game window after its mirror has joined."""
    env = dict(os.environ, DISPLAY=f':{os.environ.get("NATIVE_DISPLAY", "10")}')
    try:
        windows = subprocess.check_output(
            ['xdotool', 'search', '--onlyvisible', '--name', '^Minecraft'],
            env=env, stderr=subprocess.DEVNULL, text=True,
        ).split()
        for window in windows:
            pid = subprocess.check_output(
                ['xdotool', 'getwindowpid', window], env=env,
                stderr=subprocess.DEVNULL, text=True,
            ).strip()
            cmdline = Path(f'/proc/{pid}/cmdline').read_bytes()
            if b'--username\0ViewGuest\0' not in cmdline:
                continue
            subprocess.run(
                ['xdotool', 'key', '--window', window, 'F1'], env=env,
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            print(f'Native view Guest hid the survival HUD on window {window}', flush=True)
            return True
    except (OSError, subprocess.CalledProcessError):
        pass
    return False


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
            if not joined:
                viewer_seen_at = time.time()
            joined = True
            if name == 'Guest' and not hud_hidden and time.time() - viewer_seen_at >= 2:
                hud_hidden = hide_guest_hud()
        if process and (not ready or generation != state.get('generation')):
            stop_child()
        if process and not state.get('viewer') and ((joined and time.time() - started > 15) or time.time() - started > 300):
            stop_child()
        if ready and (process is None or process.poll() is not None):
            generation = state['generation']
            started = time.time()
            joined = False
            viewer_seen_at = None
            hud_hidden = False
            env = dict(os.environ, MC_SERVER=f'127.0.0.1:{port}')
            process = subprocess.Popen(['bash', '/workspace/arena/capture/run-client.sh', f'View{name}', os.environ.get('NATIVE_DISPLAY', '10'), x, y], env=env, start_new_session=True)
            print(f'Native view {name} connected to mirror {port}, generation {generation}', flush=True)
        time.sleep(2)
finally:
    stop_child()
