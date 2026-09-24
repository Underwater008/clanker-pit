#!/usr/bin/env bash
# Clanker Pit arena bootstrap — runs unattended at pod start (via dockerArgs).
# Does the whole stack without SSH: Java, Node, MC server, vanilla client,
# NVIDIA X driver module, GPU Xorg, six tiled camera clients (incl. the guest
# creeper view), mediamtx, ambient bots, guest gateway, spectate loop.
# Idempotent-ish; logs to /workspace/arena/logs.
# Required env: TYPESAFE_API_KEY (Jev), RUNPOD_API_KEY (Kimi).
set -euo pipefail
exec > >(tee -a /workspace/bootstrap.log) 2>&1
echo "=== clankerpit bootstrap $(date -u +%FT%TZ) ==="

# Phone-home progress channel: POSTs one-liners to $WATCHDOG_URL (a webhook.site URL)
# so we can watch an SSH-less bootstrap from outside. Optional; silent if unset.
wlog() {
  echo "[wlog] $1"
  [ -n "${WATCHDOG_URL:-}" ] && curl -s -m 10 -X POST -H "Content-Type: text/plain" --data "$1" "$WATCHDOG_URL" > /dev/null 2>&1 || true
}
trap 'wlog "BOOTSTRAP EXIT code=$? at $(date -u +%FT%TZ)"' EXIT
wlog "bootstrap alive: $(hostname) driver=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | awk 'NR == 1')"

ARENA=/workspace/arena
MC_VERSION=1.21.1
mkdir -p "$ARENA"/{server,bots,capture,cameras,stream,logs}
export DEBIAN_FRONTEND=noninteractive

wlog "step: apt"
apt-get update -qq
apt-get install -y -qq openjdk-21-jre curl wget unzip tmux ffmpeg jq python3 ca-certificates \
  xvfb xserver-xorg-core x11-xserver-utils x11-utils xdotool pciutils mesa-utils > /dev/null

wlog "step: node 22 (required by pinned Minecraft protocol dependencies)"
if ! command -v node >/dev/null || [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 22 ]; then
  curl -fsSL https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz -o /tmp/node.tar.xz
  echo 'd60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307  /tmp/node.tar.xz' | sha256sum -c -
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
fi
node -v

wlog "step: minecraft server $MC_VERSION"
cd "$ARENA/server"
if [ ! -f server.jar ]; then
  MANIFEST=$(curl -fsSL https://piston-meta.mojang.com/mc/game/version_manifest_v2.json)
  VURL=$(echo "$MANIFEST" | jq -r --arg v "$MC_VERSION" '.versions[] | select(.id==$v) | .url')
  wget -q "$(curl -fsSL "$VURL" | jq -r '.downloads.server.url')" -O server.jar
fi
echo "eula=true" > eula.txt
# Keep the selected round and its world settings across pod restarts.
if [ ! -f server.properties ]; then
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
max-tick-time=-1
EOF
fi

wlog "step: mediamtx"
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
webrtcAddress: :8889
webrtcAllowOrigin: "*"
webrtcLocalUDPAddress: ""
webrtcICEServers2:
  - url: stun:stun.l.google.com:19302
paths:
  arena: {source: publisher}
  cinder: {source: publisher}
  vex: {source: publisher}
  mira: {source: publisher}
  tally: {source: publisher}
  guest: {source: publisher}
EOF

wlog "step: fetch capture + bot code from github"
SOURCE_SHA=${CLANKER_SOURCE_SHA:-$(curl -fsSL https://api.github.com/repos/Underwater008/clanker-pit/commits/main | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])')}
[[ "$SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo 'Expected a full source commit SHA'; exit 1; }
RAW=https://raw.githubusercontent.com/Underwater008/clanker-pit/$SOURCE_SHA
for f in run-client.sh run-stream.sh run-native-view.py guest-preview.py display.sh options.txt gpu-restack.sh launch-cameras.sh client_setup.py spectate-loop.mjs; do
  curl -fsSL "$RAW/infra/capture/$f" -o "$ARENA/capture/$f"
done
for f in ambient.mjs survival.mjs ambitions.mjs action-plan.mjs primitives.mjs progress.mjs recovery.mjs vegetation.mjs crafting.mjs native-mirror.mjs llm.mjs memory.mjs env.mjs decision.mjs village.mjs round-restart.mjs coolant.mjs coolant-setup.mjs council.mjs models.mjs guest-queue.mjs guest-boom.mjs guest-camera.mjs guest-gateway.mjs spring-repair.mjs flag-setup.mjs fixture-grant.mjs home-beds.mjs deposit-migrate.mjs identity.cinder.json package.json package-lock.json; do
  curl -fsSL "$RAW/stage1/bot/$f" -o "$ARENA/bots/$f"
done
cp "$ARENA/capture/spectate-loop.mjs" "$ARENA/bots/"
chmod +x "$ARENA/capture"/*.sh
curl -fsSL "$RAW/infra/telemetry-server.py" -o "$ARENA/telemetry-server.py"
# Port 8081 serves one public snapshot, never /workspace (which contains .env).
systemctl stop nginx 2>/dev/null || true
systemctl disable nginx 2>/dev/null || true
pkill nginx 2>/dev/null || true
tmux kill-session -t filesrv 2>/dev/null || true
tmux new-session -d -s filesrv "TELEMETRY_TRUSTED_PROXY_CIDRS='${TELEMETRY_TRUSTED_PROXY_CIDRS:-100.64.1.0/24}' TELEMETRY_CLIENT_IP_HEADER=CF-Connecting-IP python3 $ARENA/telemetry-server.py 2>&1 | tee -a $ARENA/logs/telemetry.log"
if [ ! -f "$ARENA/.env" ]; then
(umask 077
cat > "$ARENA/.env" <<EOF
RUNPOD_API_KEY=${RUNPOD_API_KEY:-}
TYPESAFE_API_KEY=${TYPESAFE_API_KEY:-}
EOF
)
fi
chmod 600 "$ARENA/.env"

wlog "step: client download (jar+libs+assets)"
python3 "$ARENA/capture/client_setup.py" 2>&1 | tail -3

wlog "step: NVIDIA X driver module"
DRV=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | awk 'NR == 1')
echo "driver: $DRV"
if [ ! -f /usr/lib/xorg/modules/drivers/nvidia_drv.so ] || [ ! -f /usr/lib/xorg/modules/extensions/libglxserver_nvidia.so ]; then
  for BASE in "https://download.nvidia.com/XFree86/Linux-x86_64" "https://us.download.nvidia.com/XFree86/Linux-x86_64" "https://us.download.nvidia.com/tesla"; do
    wget -q "$BASE/$DRV/NVIDIA-Linux-x86_64-$DRV.run" -O /tmp/nv.run || true
    # a real runfile starts with #!/bin/sh — a 200-OK HTML error page does not
    if [ -s /tmp/nv.run ] && head -c 2 /tmp/nv.run | grep -q '^#!'; then break; fi
    rm -f /tmp/nv.run
  done
  if [ -s /tmp/nv.run ]; then
    sh /tmp/nv.run --extract-only --target /tmp/nvx > /dev/null 2>&1 \
      && mkdir -p /usr/lib/xorg/modules/drivers /usr/lib/xorg/modules/extensions \
      && cp /tmp/nvx/nvidia_drv.so /usr/lib/xorg/modules/drivers/ \
      && cp /tmp/nvx/libglxserver_nvidia.so.$DRV /usr/lib/xorg/modules/extensions/ \
      && ln -sf libglxserver_nvidia.so.$DRV /usr/lib/xorg/modules/extensions/libglxserver_nvidia.so \
      && echo "nvidia x module installed" || echo "extract/install FAILED"
  else
    echo "driver runfile NOT FOUND for $DRV — GPU Xorg unavailable, will fall back to Xvfb"
  fi
fi
BUS_ID=$(nvidia-smi --query-gpu=pci.bus_id --format=csv,noheader | awk 'NR == 1')
BUS_HEX=${BUS_ID#*:}
BUS_HEX=${BUS_HEX%%:*}
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

wlog "step: bot deps"
cd "$ARENA/bots" && npm ci --ignore-scripts --omit=dev > /dev/null 2>&1

wlog "step: start minecraft server"
tmux new-session -d -s mc "cd $ARENA/server && java -Xms2G -Xmx4G -jar server.jar nogui 2>&1 | tee $ARENA/logs/mc.log"
for i in $(seq 1 90); do grep -q "Done (" "$ARENA/logs/mc.log" 2>/dev/null && break; sleep 5; done
grep -q "Done (" "$ARENA/logs/mc.log" && echo "server up" || { echo "SERVER FAILED"; tail -10 "$ARENA/logs/mc.log"; exit 1; }

mc_cmd() { tmux send-keys -t mc "$1" Enter; sleep 1; }
mc_cmd "gamerule doDaylightCycle true"

wlog "step: village round setup (Server fixture; idempotent)"
# The Server monument, coolant basin + spring, starter chest and world spawn
# are round fixtures, labeled as such in the logs and chat. Idempotent: a
# second run keeps an existing village.json.
BOT_DATA_DIR="$ARENA/bot-state" RCON_PASSWORD=clanker-dev \
  SCENARIO="${SCENARIO:-village}" node "$ARENA/bots/flag-setup.mjs" 2>&1 | tee -a "$ARENA/logs/flag-setup.log"

wlog "step: launch survival cast and native mirrors"
# SCENARIO=village: clankers protect the Server. CLANKER_MODELS routes a
# different LLM per clanker (Name=provider); default: all Kimi K3.
tmux new-session -d -s bots "cd $ARENA/bots && BUILD_SHA=$SOURCE_SHA SCENARIO=${SCENARIO:-village} node ambient.mjs 2>&1 | tee -a $ARENA/logs/bots.log"

wlog "step: starter kit fixture grant (waits for the cast, idempotent)"
( sleep 75
  cd "$ARENA/bots" && BOT_DATA_DIR="$ARENA/bot-state" RCON_PASSWORD=clanker-dev \
    node fixture-grant.mjs >> "$ARENA/logs/flag-setup.log" 2>&1 || true ) &

wlog "step: founding home beds and respawn points (idempotent fixture)"
( sleep 75
  cd "$ARENA/bots" && BOT_DATA_DIR="$ARENA/bot-state" RCON_PASSWORD=clanker-dev \
    node home-beds.mjs >> "$ARENA/logs/flag-setup.log" 2>&1 || true ) &

wlog "step: guest creeper gateway (viewer queue + turns + guest mirror)"
tmux new-session -d -s guest "cd $ARENA/bots && BOT_DATA_DIR=$ARENA/bot-state RCON_PASSWORD=clanker-dev node guest-gateway.mjs 2>&1 | tee -a $ARENA/logs/guest.log"
tmux new-session -d -s guestpreview "python3 $ARENA/capture/guest-preview.py 2>&1 | tee -a $ARENA/logs/guest-preview.log"

wlog "step: start stream services"
tmux new-session -d -s mtx "cd $ARENA/capture && $ARENA/stream/mediamtx mediamtx.yml 2>&1 | tee $ARENA/logs/mtx.log"

wlog "step: start Xorg on GPU"
GPU_OK=0
if [ -f /usr/lib/xorg/modules/drivers/nvidia_drv.so ]; then
  nohup Xorg :10 -config /etc/X11/xorg-gpu.conf -noreset > "$ARENA/logs/xorg10.log" 2>&1 &
  for i in $(seq 1 30); do DISPLAY=:10 xdpyinfo -display :10 > /dev/null 2>&1 && break; sleep 2; done
  if DISPLAY=:10 glxinfo -B 2>/dev/null | grep -i 'OpenGL renderer.*NVIDIA' > /dev/null; then
    GPU_OK=1
    DISPLAY=:10 glxinfo -B | grep "OpenGL renderer"
  else
    echo "GPU XORG FAILED — see xorg10.log"
    tail -8 "$ARENA/logs/xorg10.log"
  fi
fi

if [ "$GPU_OK" = "1" ]; then
  wlog "step: launch cameras + captures on GPU Xorg"
  bash "$ARENA/capture/gpu-restack.sh" || GPU_OK=0
fi
if [ "$GPU_OK" != "1" ]; then
  wlog "step: FALLBACK: cameras on Xvfb (llvmpipe)"
  # A failed restack can leave partial GPU clients/captures alive — including
  # the guest tile — before launching the independent fallback displays.
  for s in cammira camtally camarena camcinder camvex camguest capmira captally caparena capcinder capvex capguest; do
    tmux kill-session -t "$s" 2>/dev/null || true
  done
  pkill -f "run-native-view.py Guest" 2>/dev/null || true
  for d in 101 102 103 104 105 106; do Xvfb :$d -screen 0 1280x720x24 & done
  sleep 2
  launch() { tmux new-session -d -s "$4" "bash $ARENA/capture/run-client.sh $1 $2 2>&1 | tee $ARENA/logs/client-$1.log"; sleep 8; }
  launch ClankerCam 103 "" arena
  native() { tmux new-session -d -s "$4" "NATIVE_DISPLAY=$2 python3 $ARENA/capture/run-native-view.py $1 $3 0 0 2>&1 | tee -a $ARENA/logs/client-View$1.log"; }
  native Mira 101 25582 cammira
  native Tally 102 25583 camtally
  native Cinder 104 25580 camcinder
  native Vex 105 25581 camvex
  native Guest 106 25584 camguest
  # The low-latency guest preview must sample the guest's fallback display,
  # not the now-unused tile on GPU display :10.
  tmux kill-session -t guestpreview 2>/dev/null || true
  tmux new-session -d -s guestpreview "NATIVE_DISPLAY=106 GUEST_PREVIEW_X=0 GUEST_PREVIEW_Y=0 python3 $ARENA/capture/guest-preview.py 2>&1 | tee -a $ARENA/logs/guest-preview.log"
  sleep 60
  capf() { tmux new-session -d -s "cap$1" "bash $ARENA/capture/run-stream.sh $1 $2 2>&1 | tee -a $ARENA/logs/cap-$2.log"; }
  capf 101 mira; capf 102 tally; capf 103 arena; capf 104 cinder; capf 105 vex; capf 106 guest
fi

wlog "step: wide spectator camera"
tmux new-session -d -s spec "cd $ARENA/bots && node spectate-loop.mjs 2>&1 | tee -a $ARENA/logs/spec.log"

wlog "step: HLS check"
sleep 15
for p in arena cinder vex mira tally; do
  printf "%s: " "$p"
  curl --fail --max-time 20 -sS -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8080/$p/index.m3u8" || true
done
# The guest feed only publishes while a viewer is actually playing a creeper
# turn, so a 404 here is normal on an idle queue.
printf "guest (idle ok): "
curl --max-time 20 -sS -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8080/guest/index.m3u8" || true
echo "=== bootstrap done $(date -u +%FT%TZ) ==="
