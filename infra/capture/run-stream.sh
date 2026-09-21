#!/usr/bin/env bash
# Captures one Xvfb display and pushes RTMP to mediamtx (served as HLS).
# Usage: run-stream.sh <display-number> <stream-path>
set -euo pipefail
DISP=${1:?display required}
PATH_NAME=${2:?stream path required}
export DISPLAY=":$DISP"
# Restart loop: a dead ffmpeg must never take a feed down silently.
while true; do
  echo "[run-stream] starting capture :$DISP -> $PATH_NAME $(date -u +%FT%TZ)"
  ffmpeg -hide_banner -loglevel warning \
    -f x11grab -video_size 1280x720 -framerate 30 -i ":$DISP.0" \
    -vf format=yuv420p -c:v libx264 -preset veryfast -tune zerolatency \
    -b:v 2500k -maxrate 3000k -bufsize 5000k -g 60 \
    -an -f flv "rtmp://127.0.0.1:1935/$PATH_NAME" || true
  echo "[run-stream] ffmpeg exited; restarting in 2 s"
  sleep 2
done
