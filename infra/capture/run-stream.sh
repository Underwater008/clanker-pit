#!/usr/bin/env bash
# Captures a display (or a fixed region of one) and pushes RTMP to mediamtx.
# Usage: run-stream.sh <display> <stream-path> [region_x region_y]
# Restart loop: a dead ffmpeg must never take a feed down silently.
set -euo pipefail
DISP=${1:?display required}
PATH_NAME=${2:?stream path required}
REG_X=${3:-}
REG_Y=${4:-}
STREAM_FPS=${STREAM_FPS:-30}
source "$(dirname "$0")/display.sh"
require_capture_region "$DISP" "${REG_X:-0}" "${REG_Y:-0}"

export DISPLAY=":$DISP"
GRAB=":$DISP.0"
if [ -n "$REG_X" ] && [ -n "$REG_Y" ]; then
  GRAB=":$DISP.0+$REG_X,$REG_Y"
fi

# Containers can see many host CPUs but have only a few cores of quota. Keep
# software thread pools bounded, and offload encoding when NVENC actually works.
ENCODER_ARGS=(-c:v libx264 -preset veryfast -tune zerolatency -threads 2 -sc_threshold 0)
GOP=$((STREAM_FPS * 2))
if [ "$PATH_NAME" = guest ]; then
  # WebRTC needs H.264 without B-frames; shorter keyframe spacing also makes
  # the HLS fallback recover faster when the guest camera starts mid-turn.
  ENCODER_ARGS+=(-profile:v baseline -bf 0)
  GOP="$STREAM_FPS"
fi
if ffmpeg -hide_banner -loglevel error -f lavfi -i color=size=1280x720:rate=30 \
    -frames:v 1 -c:v h264_nvenc -preset p4 -tune ll -f null - >/dev/null 2>&1; then
  ENCODER_ARGS=(-c:v h264_nvenc -preset p4 -tune ll -bf 0 -no-scenecut 1)
  if [ "$PATH_NAME" = guest ]; then ENCODER_ARGS+=(-profile:v baseline); fi
fi
echo "[run-stream] encoder ${ENCODER_ARGS[*]}"

# x11grab can miss capture deadlines under CPU pressure. Resample onto a
# fixed output clock so those gaps do not change LL-HLS part durations on iOS.
# Disable adaptive scene-cut keyframes as well: resetting a GOP just before
# HLS's minimum segment boundary can stretch a 2s segment toward 3s.
# -vsync cfr also supports the pod's FFmpeg 4.4 (which lacks -fps_mode).
while true; do
  echo "[run-stream] starting capture $GRAB -> $PATH_NAME $(date -u +%FT%TZ)"
  ffmpeg -hide_banner -loglevel warning -filter_threads 1 \
    -f x11grab -video_size 1280x720 -framerate "$STREAM_FPS" -i "$GRAB" \
    -vf "fps=${STREAM_FPS},format=yuv420p" -r "$STREAM_FPS" -vsync cfr "${ENCODER_ARGS[@]}" \
    -b:v 2500k -maxrate 3000k -bufsize 5000k -g "$GOP" \
    -an -f flv "rtmp://127.0.0.1:1935/$PATH_NAME" || true
  echo "[run-stream] ffmpeg exited; restarting in 2 s"
  sleep 2
done
