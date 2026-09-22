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
source "$(dirname "$0")/display.sh"

# Tiled clients require the shared display. Silently starting a 1280x720 Xvfb
# here used to strand four captures outside the screen and produce HLS 404s.
if [ -n "$WIN_X" ] || [ -n "$WIN_Y" ]; then
  require_capture_region "$DISP" "${WIN_X:?window_x required}" "${WIN_Y:?window_y required}"
elif ! xdpyinfo -display ":$DISP" > /dev/null 2>&1; then
  Xvfb ":$DISP" -screen 0 1280x720x24 &
  sleep 2
fi
require_capture_region "$DISP" "${WIN_X:-0}" "${WIN_Y:-0}"

ROOT=/workspace/arena/client
GDIR=/workspace/arena/cameras/$NAME
mkdir -p "$GDIR"
cp -n /workspace/arena/capture/options.txt "$GDIR/options.txt" 2>/dev/null || true

META=$(cat "$ROOT/meta.json")
VERSION=$(echo "$META" | python3 -c "import json,sys; print(json.load(sys.stdin)['version'])")
ASSET_INDEX=$(echo "$META" | python3 -c "import json,sys; print(json.load(sys.stdin)['assetIndex'])")
MAIN=$(echo "$META" | python3 -c "import json,sys; print(json.load(sys.stdin)['mainClass'])")
CP=$(cat "$ROOT/classpath.txt")

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

# Ignore GLFW's invisible 1x1 helper window; move the visible game window.
if [ -n "$WIN_X" ] && [ -n "$WIN_Y" ]; then
  (
    for i in $(seq 1 150); do
      kill -0 "$JPID" 2>/dev/null || exit 1
      WID=$(xdotool search --onlyvisible --all --pid "$JPID" --name '^Minecraft' 2>/dev/null | head -1 || true)
      if [ -n "$WID" ]; then
        xdotool windowmove "$WID" "$WIN_X" "$WIN_Y"
        exit 0
      fi
      sleep 2
    done
    echo "Timed out positioning $NAME on display :$DISP" >&2
    exit 1
  ) &
fi

wait $JPID
