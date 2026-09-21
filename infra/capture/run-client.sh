#!/usr/bin/env bash
# Launches the spectator Minecraft client inside Xvfb and joins the arena server.
# Runs on the pod, in tmux session 'cam'.
set -euo pipefail
ROOT=/workspace/arena/client
META=$(cat "$ROOT/meta.json")
VERSION=$(echo "$META" | python3 -c "import json,sys; print(json.load(sys.stdin)['version'])")
ASSET_INDEX=$(echo "$META" | python3 -c "import json,sys; print(json.load(sys.stdin)['assetIndex'])")
MAIN=$(echo "$META" | python3 -c "import json,sys; print(json.load(sys.stdin)['mainClass'])")
CP=$(cat "$ROOT/classpath.txt")

if ! pgrep -f "Xvfb :99" > /dev/null; then
  Xvfb :99 -screen 0 1280x720x24 &
  sleep 2
fi

export DISPLAY=:99
exec java -Xmx3G -Djava.library.path="$ROOT/natives" -cp "$CP" "$MAIN" \
  --username ClankerCam \
  --uuid 00000000-0000-4000-8000-0000000000ca \
  --accessToken 0 --clientId 0 --xuid 0 --userType mojang \
  --version "$VERSION" --versionType release \
  --gameDir "$ROOT" --assetsDir "$ROOT/assets" --assetIndex "$ASSET_INDEX" \
  --quickPlayMultiplayer 127.0.0.1:25565 \
  --width 1280 --height 720
