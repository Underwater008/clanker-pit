#!/usr/bin/env bash
# Shared guard for camera placement and x11grab. A reachable display is not
# necessarily large enough for the six-tile layout (incl. the guest creeper).
require_capture_region() {
  local display=$1 x=${2:-0} y=${3:-0} width=${4:-1280} height=${5:-720}
  local dimensions screen_width screen_height
  if ! [[ "$display" =~ ^[0-9]+$ && "$x" =~ ^[0-9]+$ && "$y" =~ ^[0-9]+$ ]]; then
    echo "Invalid display or capture coordinates" >&2
    return 1
  fi
  dimensions=$(xdpyinfo -display ":$display" 2>/dev/null | awk '/dimensions:/ {print $2}') || dimensions=''
  if ! [[ "$dimensions" =~ ^[0-9]+x[0-9]+$ ]]; then
    echo "Display :$display is unavailable; start the camera display first" >&2
    return 1
  fi
  screen_width=${dimensions%x*}
  screen_height=${dimensions#*x}
  if (( 10#$x + width > screen_width || 10#$y + height > screen_height )); then
    echo "Capture ${width}x${height} at $x,$y exceeds display :$display ($dimensions); refusing to start a broken feed" >&2
    return 1
  fi
}
