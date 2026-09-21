#!/usr/bin/env bash
# Captures the Xvfb display and pushes RTMP to mediamtx (which serves HLS).
# Runs on the pod, in tmux session 'cap'.
set -euo pipefail
export DISPLAY=:99
exec ffmpeg -hide_banner -loglevel warning \
  -f x11grab -video_size 1280x720 -framerate 30 -i :99.0 \
  -vf format=yuv420p -c:v libx264 -preset veryfast -tune zerolatency \
  -b:v 2500k -maxrate 3000k -bufsize 5000k -g 60 \
  -an -f flv rtmp://127.0.0.1:1935/arena
