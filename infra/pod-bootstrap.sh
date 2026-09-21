#!/usr/bin/env bash
# Clanker Pit arena bootstrap — runs unattended at pod start (via dockerArgs).
# Does the whole stack without SSH: Java, Node, MC server, vanilla client,
# NVIDIA X driver module, GPU Xorg, five tiled camera clients, mediamtx,
# ambient bots, spectate loop. Idempotent-ish; logs to /workspace/arena/logs.
# Required env: TYPESAFE_API_KEY (Jev), RUNPOD_API_KEY (Kimi, optional for ambient).
set -u
exec > >(tee -a /workspace/bootstrap.log) 2>&1
echo "=== clankerpit bootstrap $(date -u +%FT%TZ) ==="

ARENA=/workspace/arena
MC_VERSION=1.21.1
mkdir -p "$ARENA"/{server,bots,capture,cameras,stream,logs}
export DEBIAN_FRONTEND=noninteractive

echo "==> apt"
apt-get update -qq
apt-get install -y -qq openjdk-21-jre curl wget unzip tmux ffmpeg jq python3 ca-certificates \
  xserver-xorg-core x11-xserver-utils x11-utils xdotool pciutils mesa-utils > /dev/null

echo "==> node 20"
if ! command -v node >/dev/null; then
  curl -fsSL https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
fi
node -v

echo "==> minecraft server $MC_VERSION"
cd "$ARENA/server"
if [ ! -f server.jar ]; then
  MANIFEST=$(curl -fsSL https://piston-meta.mojang.com/mc/game/version_manifest_v2.json)
  VURL=$(echo "$MANIFEST" | jq -r --arg v "$MC_VERSION" '.versions[] | select(.id==$v) | .url')
  wget -q "$(curl -fsSL "$VURL" | jq -r '.downloads.server.url')" -O server.jar
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
level-name=world
enable-rcon=true
rcon.port=25575
rcon.password=clanker-dev
allow-flight=true
EOF

echo "==> mediamtx"
cd "$ARENA/stream"
if [ ! -x mediamtx ]; then
  curl -fsSL https://github.com/bluenviron/mediamtx/releases/download/v1.9.3/mediamtx_v1.9.3_linux_amd64.tar.gz -o /tmp/mtx.tar.gz
  tar -xzf /tmp/mtx.tar.gz
fi
cat > "$ARENA/capture/mediamtx.yml" <<'EOF'
rtmpAddress: :1935
hlsAddress: :8080
hlsAllowOrigin: "*"
hlsSegmentCount: 7
hlsSegmentDuration: 1s
hlsPartDuration: 200ms
paths:
  arena: {source: publisher}
  cinder: {source: publisher}
  vex: {source: publisher}
  mira: {source: publisher}
  tally: {source: publisher}
EOF

echo "==> fetch capture + bot code from github"
RAW=https://raw.githubusercontent.com/Underwater008/clanker-pit/main
for f in run-client.sh run-stream.sh options.txt gpu-restack.sh launch-cameras.sh client_setup.py spectate-loop.mjs; do
  curl -fsSL "$RAW/infra/capture/$f" -o "$ARENA/capture/$f"
done
for f in ambient.mjs llm.mjs memory.mjs env.mjs identity.cinder.json package.json; do
  curl -fsSL "$RAW/stage1/bot/$f" -o "$ARENA/bots/$f"
done
cp "$ARENA/capture/spectate-loop.mjs" "$ARENA/bots/"
chmod +x "$ARENA/capture"/*.sh
cat > "$ARENA/.env" <<EOF
RUNPOD_API_KEY=${RUNPOD_API_KEY:-}
TYPESAFE_API_KEY=${TYPESAFE_API_KEY:-}
EOF

echo "==> client download (jar+libs+assets)"
python3 "$ARENA/capture/client_setup.py" 2>&1 | tail -3

echo "==> NVIDIA X driver module"
DRV=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)
echo "driver: $DRV"
if [ ! -f /usr/lib/xorg/modules/drivers/nvidia_drv.so ]; then
  wget -q "https://download.nvidia.com/XFree86/Linux-x86_64/$DRV/NVIDIA-Linux-x86_64-$DRV.run" -O /tmp/nv.run \
    && sh /tmp/nv.run --extract-only -C /tmp/nvx > /dev/null 2>&1 \
    && mkdir -p /usr/lib/xorg/modules/drivers /usr/lib/xorg/modules/extensions \
    && cp /tmp/nvx/nvidia_drv.so /usr/lib/xorg/modules/drivers/ \
    && cp /tmp/nvx/libglxserver_nvidia.so.$DRV /usr/lib/xorg/modules/extensions/ \
    && ln -sf libglxserver_nvidia.so.$DRV /usr/lib/xorg/modules/extensions/libglxserver_nvidia.so
fi
BUS_HEX=$(nvidia-smi -q | grep "Bus Id" | head -1 | grep -oE "[0-9A-F]{2}:00.0" | cut -d: -f1)
BUS_DEC=$((16#$BUS_HEX))
cat > /etc/X11/xorg-gpu.conf <<EOF
Section "ServerLayout"
  Identifier "L0"
  Screen 0 "S0"
EndSection
Section "Device"
  Identifier "N0"
  Driver "nvidia"
  BusID "PCI:$BUS_DEC:0:0"
  Option "AllowEmptyInitialConfiguration" "True"
EndSection
Section "Screen"
  Identifier "S0"
  Device "N0"
  DefaultDepth 24
  SubSection "Display"
    Depth 24
    Modes "3840x1440"
    Virtual 3840 1440
  EndSubSection
EndSection
EOF

echo "==> bot deps"
cd "$ARENA/bots" && npm install --omit=dev > /dev/null 2>&1

echo "==> start minecraft server"
tmux new-session -d -s mc "cd $ARENA/server && java -Xms2G -Xmx4G -jar server.jar nogui 2>&1 | tee $ARENA/logs/mc.log"
for i in $(seq 1 90); do grep -q "Done (" "$ARENA/logs/mc.log" 2>/dev/null && break; sleep 5; done
grep -q "Done (" "$ARENA/logs/mc.log" && echo "server up" || { echo "SERVER FAILED"; tail -10 "$ARENA/logs/mc.log"; }

mc_cmd() { tmux send-keys -t mc "$1" Enter; sleep 1; }
mc_cmd "gamerule doDaylightCycle false"
mc_cmd "time set noon"
mc_cmd "weather clear 999999"

echo "==> start stream services"
tmux new-session -d -s mtx "cd $ARENA/capture && $ARENA/stream/mediamtx mediamtx.yml 2>&1 | tee $ARENA/logs/mtx.log"

echo "==> start Xorg on GPU"
nohup Xorg :10 -config /etc/X11/xorg-gpu.conf -noreset > "$ARENA/logs/xorg10.log" 2>&1 &
for i in $(seq 1 30); do DISPLAY=:10 xdpyinfo -display :10 > /dev/null 2>&1 && break; sleep 2; done
DISPLAY=:10 glxinfo -B | grep "OpenGL renderer" || echo "GPU XORG FAILED"

echo "==> launch cameras + captures"
bash "$ARENA/capture/gpu-restack.sh"

echo "==> launch ambient cast + spectate loop"
tmux new-session -d -s bots "cd $ARENA/bots && node ambient.mjs 2>&1 | tee -a $ARENA/logs/bots.log"
tmux new-session -d -s spec "cd $ARENA/bots && node spectate-loop.mjs 2>&1 | tee -a $ARENA/logs/spec.log"

echo "==> HLS check"
sleep 15
for p in arena cinder vex mira tally; do printf "%s: " $p; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/$p/index.m3u8; done
echo "=== bootstrap done $(date -u +%FT%TZ) ==="
