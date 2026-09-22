#!/usr/bin/env bash
# (Re)launches the five camera clients as tiles on Xorg :10. Idempotent.
# Assumes Xorg :10 is already running at 3840x1440 (see gpu-restack.sh).
set -euo pipefail
source "$(dirname "$0")/display.sh"
require_capture_region 10 0 0 3840 1440
exec > >(tee -a /workspace/arena/logs/launch-cameras.log) 2>&1
echo "=== launch-cameras $(date -u +%FT%TZ) ==="

pkill -f "net.minecraft.client.main.Main" 2>/dev/null || true
sleep 3
for s in cammira camtally camarena camcinder camvex; do tmux kill-session -t "$s" 2>/dev/null || true; done

launch() { # name x y session
  mkdir -p "/workspace/arena/cameras/$1"
  cp -f /workspace/arena/capture/options.txt "/workspace/arena/cameras/$1/options.txt"
  tmux new-session -d -s "$4" "bash /workspace/arena/capture/run-client.sh $1 10 $2 $3 2>&1 | tee /workspace/arena/logs/client-$1.log"
  echo "launched $1 at ($2,$3)"
  sleep 10
}
native() { # contestant port x y session
  mkdir -p "/workspace/arena/cameras/View$1"
  cp -f /workspace/arena/capture/options.txt "/workspace/arena/cameras/View$1/options.txt"
  tmux new-session -d -s "$5" "python3 /workspace/arena/capture/run-native-view.py $1 $2 $3 $4 2>&1 | tee /workspace/arena/logs/client-View$1.log"
  sleep 8
}
native Mira 25582 0 0 cammira
native Tally 25583 1280 0 camtally
launch ClankerCam 2560 0 camarena
native Cinder 25580 0 720 camcinder
native Vex 25581 1280 720 camvex
echo "done; clients joining"
