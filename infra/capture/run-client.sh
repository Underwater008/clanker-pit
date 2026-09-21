#!/usr/bin/env bash
# Launches a vanilla client inside Xvfb and joins the arena server.
# Usage: run-client.sh <username> <display-number>
# Examples: run-client.sh ClankerCam 99      (wide arena cam)
#           run-client.sh CamCinder 101      (POV cam spectating Cinder)
set -euo pipefail
NAME=${1:-ClankerCam}   # default preserves the original wide-cam behavior
DISP=${2:-99}

ROOT=/workspace/arena/client
GDIR=/workspace/arena/cameras/$NAME
mkdir -p "$GDIR"
cp -n /workspace/arena/capture/options.txt "$GDIR/options.txt" 2>/dev/null || true

META=$(cat "$ROOT/meta.json")
VERSION=$(echo "$META" | python3 -c "import json,sys; print(json.load(sys.stdin)['version'])")
ASSET_INDEX=$(echo "$META" | python3 -c "import json,sys; print(json.load(sys.stdin)['assetIndex'])")
MAIN=$(echo "$META" | python3 -c "import json,sys; print(json.load(sys.stdin)['mainClass'])")
CP=$(cat "$ROOT/classpath.txt")

if ! pgrep -f "Xvfb :$DISP" > /dev/null; then
  Xvfb ":$DISP" -screen 0 1280x720x24 &
  sleep 2
fi

export DISPLAY=":$DISP"
exec java -Xmx2G -Djava.library.path="$ROOT/natives" -cp "$CP" "$MAIN" \
  --username "$NAME" \
  --uuid 00000000-0000-4000-8000-$(printf '%012x' "$DISP") \
  --accessToken 0 --clientId 0 --xuid 0 --userType mojang \
  --version "$VERSION" --versionType release \
  --gameDir "$GDIR" --assetsDir "$ROOT/assets" --assetIndex "$ASSET_INDEX" \
  --quickPlayMultiplayer 127.0.0.1:25565 \
  --width 1280 --height 720
