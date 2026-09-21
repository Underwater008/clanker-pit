#!/usr/bin/env bash
# Moves all five cameras from Xvfb/llvmpipe onto the GPU Xorg :10 (3840x1440).
# Self-contained: safe to run via nohup so SSH drops can't kill it halfway.
# Tile map (1280x720 each):  [0,0]=mira [1280,0]=tally [2560,0]=arena
#                            [0,720]=cinder [1280,720]=vex
set -u
LOG=/workspace/arena/logs/restack.log
exec > >(tee -a "$LOG") 2>&1
echo "=== restack $(date -u +%FT%TZ) ==="

# 1. Stop old captures and camera clients (Xvfb-era)
tmux kill-session -t cap 2>/dev/null; for d in 101 102 103 104; do tmux kill-session -t cap$d 2>/dev/null; done
tmux kill-session -t cam 2>/dev/null; for d in 101 102 103 104; do tmux kill-session -t cam$d 2>/dev/null; done
pkill -f "net.minecraft.client.main.Main" 2>/dev/null
sleep 3

# 2. Fresh Xorg :10 at 3840x1440
pkill -f "Xorg :10" 2>/dev/null
sleep 2
rm -f /tmp/.X10-lock /tmp/.X11-unix/X10
nohup Xorg :10 -config /etc/X11/xorg-gpu.conf -noreset > /workspace/arena/logs/xorg10.log 2>&1 &
for i in $(seq 1 30); do
  DISPLAY=:10 xdpyinfo -display :10 > /dev/null 2>&1 && break
  sleep 2
done
if ! DISPLAY=:10 xdpyinfo -display :10 > /dev/null 2>&1; then
  echo "Xorg :10 FAILED to start"; tail -10 /workspace/arena/logs/xorg10.log; exit 1
fi
echo "Xorg :10 up: $(DISPLAY=:10 xdpyinfo -display :10 | grep dimensions)"
DISPLAY=:10 glxinfo -B | grep "OpenGL renderer"

# 3. Kill leftover Xvfb displays (no longer needed)
pkill -f "Xvfb :99" 2>/dev/null; for d in 101 102 103 104; do pkill -f "Xvfb :$d" 2>/dev/null; done

# 4. Launch the five cameras as tiles on :10
launch() { # name x y session
  tmux new-session -d -s "$4" "bash /workspace/arena/capture/run-client.sh $1 10 $2 $3 2>&1 | tee /workspace/arena/logs/client-$1.log"
  echo "launched $1 at ($2,$3)"
  sleep 8
}
launch CamMira 0 0 cammira
launch CamTally 1280 0 camtally
launch ClankerCam 2560 0 camarena
launch CamCinder 0 720 camcinder
launch CamVex 1280 720 camvex

echo "waiting for clients to join..."
sleep 70

# 5. Start region captures
cap() { # x y path session
  tmux new-session -d -s "$4" "bash /workspace/arena/capture/run-stream.sh 10 $3 $1 $2 2>&1 | tee -a /workspace/arena/logs/cap-$3.log"
  echo "capturing ($1,$2) -> $3"
}
cap 0 0 mira capmira
cap 1280 0 tally captally
cap 2560 0 arena caparena
cap 0 720 cinder capcinder
cap 1280 720 vex capvex
sleep 15

echo "--- HLS path check:"
for p in arena cinder vex mira tally; do printf "%s: " $p; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/$p/index.m3u8; done
echo "=== restack done ==="
