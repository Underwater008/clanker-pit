#!/usr/bin/env bash
# (Re)launches the camera clients as tiles on Xorg :10. Idempotent.
# Assumes Xorg :10 is already running at 3840x1440 (see gpu-restack.sh).
# Tiles (1280x720): [0,0]=mira [1280,0]=tally [2560,0]=arena
#                   [0,720]=cinder [1280,720]=vex [2560,720]=guest
set -euo pipefail
source "$(dirname "$0")/display.sh"
require_capture_region 10 0 0 3840 1440
exec > >(tee -a /workspace/arena/logs/launch-cameras.log) 2>&1
echo "=== launch-cameras $(date -u +%FT%TZ) ==="

pkill -TERM -f '^python3 /workspace/arena/capture/run-native-view.py ' 2>/dev/null || true
sleep 3
pkill -f "net.minecraft.client.main.Main" 2>/dev/null || true
sleep 3
for s in cammira camtally camarena camcinder camvex camguest; do tmux kill-session -t "$s" 2>/dev/null || true; done

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
  # This pod has about four CPU cores. Wait for each renderer to finish its
  # expensive startup before launching the next one.
  for _ in $(seq 1 120); do
    if jq -e '.viewer == true' "/workspace/arena/bot-state/mirror-$1.json" >/dev/null 2>&1; then return; fi
    sleep 2
  done
  echo "Native $1 still loading; supervisor will keep retrying"
}
native Mira 25582 0 0 cammira
native Tally 25583 1280 0 camtally
launch ClankerCam 2560 0 camarena
native Cinder 25580 0 720 camcinder
native Vex 25581 1280 720 camvex
# Sixth tile: the guest creeper's POV. Its mirror state file only reports
# ready while a guest turn is live, so the watcher idles cheaply between
# turns and the run-native-view supervisor starts the display per turn.
tmux new-session -d -s camguest "python3 /workspace/arena/capture/run-native-view.py Guest 25584 2560 720 2>&1 | tee /workspace/arena/logs/client-ViewGuest.log"
echo "launched guest view supervisor at (2560,720)"
echo "done; clients joining"
