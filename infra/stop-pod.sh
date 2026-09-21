#!/usr/bin/env bash
# Stops the arena pod (keeps it resumable; disk persists on stop for pods with volumes —
# NOTE: we use container disk only, so STOP preserves the container; TERMINATE destroys it).
# Usage: ./stop-pod.sh [--terminate]
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
set -a; source ../stage0/.env; set +a
POD_ID=$(python3 -c "import json; print(json.load(open('pod.json'))['id'])")

if [ "${1:-}" = "--terminate" ]; then
  echo "TERMINATING pod $POD_ID — this destroys the container disk permanently."
  read -r -p "type 'destroy' to confirm: " confirm
  [ "$confirm" = "destroy" ] || exit 1
  MUT='{"query":"mutation { podTerminate(input: {podId: \"'$POD_ID'\"}) }"}'
else
  echo "Stopping pod $POD_ID (billing for compute stops; container is preserved for resume)"
  MUT='{"query":"mutation { podStop(input: {podId: \"'$POD_ID'\"}) { id desiredStatus } }"}'
fi

curl -s -X POST -H "Content-Type: application/json" -H "User-Agent: Mozilla/5.0" \
  "https://api.runpod.io/graphql?api_key=$RUNPOD_API_KEY" -d "$MUT" | python3 -m json.tool
