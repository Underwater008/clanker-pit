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
view_path = state_path.with_name('guest-camera-view.json')
process = None
generation = None
started = 0
joined = False
stopping = False
viewer_seen_at = None
hud_hidden = False
camera_step = 0  # F5 cycles first -> third-back -> third-front -> first
last_logged_view = 'first'


def guest_window():
    """Find only the official client belonging to this guest mirror."""
    env = dict(os.environ, DISPLAY=f':{os.environ.get("NATIVE_DISPLAY", "10")}')
    try:
        windows = subprocess.check_output(
            ['xdotool', 'search', '--onlyvisible', '--name', '^Minecraft'],
            env=env, stderr=subprocess.DEVNULL, text=True,
        ).split()
        for window in windows:
            try:
                pid = subprocess.check_output(
                    ['xdotool', 'getwindowpid', window], env=env,
                    stderr=subprocess.DEVNULL, text=True,
                ).strip()
                cmdline = Path(f'/proc/{pid}/cmdline').read_bytes()
            except (OSError, subprocess.CalledProcessError):
                continue
            if b'--username\0ViewGuest\0' not in cmdline:
                continue
            return window
    except (OSError, subprocess.CalledProcessError):
        pass
    return None


def guest_key(window, key):
    env = dict(os.environ, DISPLAY=f':{os.environ.get("NATIVE_DISPLAY", "10")}')
    try:
        subprocess.run(
            ['xdotool', 'key', '--window', window, key], env=env,
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


def requested_view(current_generation):
    try:
        request = json.loads(view_path.read_text())
        if request.get('generation') == current_generation and request.get('mode') == 'third':
            return 'third'
    except (OSError, ValueError, AttributeError):
        pass
    return 'first'


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
            if name == 'Guest' and time.time() - viewer_seen_at >= 2:
                window = guest_window()
                if window and not hud_hidden:
                    hud_hidden = guest_key(window, 'F1')
                    if hud_hidden:
                        print(f'Native view Guest hid the survival HUD on window {window}', flush=True)
                if window and hud_hidden:
                    wanted = requested_view(generation)
                    target_step = 1 if wanted == 'third' else 0
                    while camera_step != target_step:
                        if not guest_key(window, 'F5'):
                            break
                        camera_step = (camera_step + 1) % 3
                        time.sleep(0.2)  # distinct key presses for Minecraft
                    if camera_step == target_step and wanted != last_logged_view:
                        last_logged_view = wanted
                        print(f'Native view Guest switched to {wanted} person', flush=True)
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
            camera_step = 0
            last_logged_view = 'first'
            env = dict(os.environ, MC_SERVER=f'127.0.0.1:{port}')
            process = subprocess.Popen(['bash', '/workspace/arena/capture/run-client.sh', f'View{name}', os.environ.get('NATIVE_DISPLAY', '10'), x, y], env=env, start_new_session=True)
            print(f'Native view {name} connected to mirror {port}, generation {generation}', flush=True)
        time.sleep(2)
finally:
    stop_child()
