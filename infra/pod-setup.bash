#!/usr/bin/env bash
# Remote provisioning script for the arena pod. Runs ON the pod as root.
# Idempotent: safe to re-run. Installs Java 21, Node 20, a vanilla 1.21.1 server,
# Xvfb/ffmpeg/mediamtx for the later capture path, and starts the server in tmux.
set -euo pipefail

ARENA=/workspace/arena
MC_VERSION=1.21.1
mkdir -p "$ARENA"/{server,bot,stream,logs}
cd "$ARENA"

echo "==> apt packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq openjdk-21-jre-headless curl wget unzip tmux xvfb ffmpeg jq python3 ca-certificates > /dev/null

echo "==> node 20"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  curl -fsSL https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
fi
node -v

echo "==> minecraft server $MC_VERSION"
cd "$ARENA/server"
if [ ! -f server.jar ]; then
  MANIFEST=$(curl -fsSL https://piston-meta.mojang.com/mc/game/version_manifest_v2.json)
  VERSION_URL=$(echo "$MANIFEST" | jq -r --arg v "$MC_VERSION" '.versions[] | select(.id==$v) | .url')
  SERVER_URL=$(curl -fsSL "$VERSION_URL" | jq -r '.downloads.server.url')
  wget -q "$SERVER_URL" -O server.jar
fi
echo "eula=true" > eula.txt
cat > server.properties <<'EOF'
online-mode=false
difficulty=normal
gamemode=survival
spawn-protection=0
view-distance=12
simulation-distance=10
max-players=20
motd=Clanker Pit Arena
level-name=arena
enable-command-block=false
allow-flight=true
enable-rcon=true
rcon.port=25575
rcon.password=clanker-dev
EOF
# Flat-ish arena world, predictable for repeatable matches
cat > server.properties.tmp <<'EOF'
generator-settings={"layers"\:[{"block"\:"minecraft:bedrock","height"\:1},{"block"\:"minecraft:dirt","height"\:3},{"block"\:"minecraft:grass_block","height"\:1}],"biome"\:"minecraft:plains"}
level-type=minecraft:flat
EOF
if [ ! -d arena ]; then
  cat server.properties.tmp >> server.properties
fi
rm server.properties.tmp

echo "==> start minecraft server in tmux session 'mc'"
if ! tmux has-session -t mc 2>/dev/null; then
  tmux new-session -d -s mc "cd $ARENA/server && java -Xms2G -Xmx4G -jar server.jar nogui 2>&1 | tee $ARENA/logs/mc.log"
fi

echo "==> waiting for server to finish loading"
for i in $(seq 1 60); do
  grep -q 'Done (' "$ARENA/logs/mc.log" 2>/dev/null && break
  sleep 5
done
grep -q 'Done (' "$ARENA/logs/mc.log" && echo "server is up" || { echo "server failed to start; last log:"; tail -20 "$ARENA/logs/mc.log"; exit 1; }

echo "==> mediamtx (HLS server for later)"
cd "$ARENA/stream"
if [ ! -x mediamtx ]; then
  curl -fsSL https://github.com/bluenviron/mediamtx/releases/download/v1.9.3/mediamtx_v1.9.3_linux_amd64.tar.gz -o /tmp/mtx.tar.gz
  tar -xzf /tmp/mtx.tar.gz
fi

echo "==> done. Server on :25565, tmux session 'mc'"
