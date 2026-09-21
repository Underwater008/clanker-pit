#!/usr/bin/env bash
# Launches a vanilla client and (optionally) tiles its window on a shared Xorg display.
# Usage: run-client.sh <username> <display> [window_x window_y]
# Examples: run-client.sh ClankerCam 99          (own Xvfb display, legacy)
#           run-client.sh CamCinder 10 1280 0    (tile on shared GPU Xorg :10)
set -euo pipefail
NAME=${1:-ClankerCam}
DISP=${2:-99}
WIN_X=${3:-}
WIN_Y=${4:-}

ROOT=/workspace/arena/client
GDIR=/workspace/arena/cameras/$NAME
mkdir -p "$GDIR"
cp -n /workspace/arena/capture/options.txt "$GDIR/options.txt" 2>/dev/null || true

META=$(cat "$ROOT/meta.json")
VERSION=$(echo "$META" | python3 -c "import json,sys; print(json.load(sys.stdin)['version'])")
ASSET_INDEX=$(echo "$META" | python3 -c "import json,sys; print(json.load(sys.stdin)['assetIndex'])")
MAIN=$(echo "$META" | python3 -c "import json,sys; print(json.load(sys.stdin)['mainClass'])")
CP=$(cat "$ROOT/classpath.txt")

# Use an existing X server if one is up; else fall back to Xvfb.
if ! xdpyinfo -display ":$DISP" > /dev/null 2>&1; then
  Xvfb ":$DISP" -screen 0 1280x720x24 &
  sleep 2
fi

export DISPLAY=":$DISP"
java -Xmx2G -Djava.library.path="$ROOT/natives" -cp "$CP" "$MAIN" \
  --username "$NAME" \
  --uuid 00000000-0000-4000-8000-$(printf '%012x' "$DISP$RANDOM") \
  --accessToken 0 --clientId 0 --xuid 0 --userType mojang \
  --version "$VERSION" --versionType release \
  --gameDir "$GDIR" --assetsDir "$ROOT/assets" --assetIndex "$ASSET_INDEX" \
  --quickPlayMultiplayer 127.0.0.1:25565 \
  --width 1280 --height 720 &
JPID=$!

# Tile the window once it appears (xdotool matches by owning PID — race-free).
if [ -n "$WIN_X" ] && [ -n "$WIN_Y" ]; then
  (
    for i in $(seq 1 60); do
      WID=$(xdotool search --pid $JPID 2>/dev/null | head -1 || true)
      if [ -n "$WID" ]; then
        xdotool windowmove "$WID" "$WIN_X" "$WIN_Y"
        exit 0
      fi
      sleep 2
    done
  ) &
fi

wait $JPID
