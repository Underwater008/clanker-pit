#!/usr/bin/env bash
# Polls pod status until the SSH endpoint is available, then prints the SSH command.
# Usage: ./pod-status.sh           (check once)
#        ./pod-status.sh --wait    (poll until SSH-ready)
set -euo pipefail
cd "$(dirname "$0")"
set -a; source ../stage0/.env; set +a
POD_ID=$(python3 -c "import json; print(json.load(open('pod.json'))['id'])")

QUERY='{"query":"{ pod(input: {podId: \"'$POD_ID'\"}) { id desiredStatus costPerHr runtime { ports { ip isIpPublic privatePort publicPort } } } }"}'

check() {
  curl -s -X POST -H "Content-Type: application/json" -H "User-Agent: Mozilla/5.0" \
    "https://api.runpod.io/graphql?api_key=$RUNPOD_API_KEY" -d "$QUERY" | python3 -c "
import json, sys
try:
    resp = json.load(sys.stdin)
except Exception:
    print('unparseable response (transient)'); sys.exit(2)
pod = (resp.get('data') or {}).get('pod')
if not pod:
    print('no pod data (transient):', str(resp)[:200]); sys.exit(2)
print(f\"desiredStatus: {pod['desiredStatus']}\")
ports = (pod.get('runtime') or {}).get('ports') or []
for p in ports:
    if p.get('privatePort') == 22 and p.get('isIpPublic'):
        print(f\"ssh root@{p['ip']} -p {p['publicPort']} -i infra/pod_ed25519\")
        sys.exit(0)
print('runtime not ready (image pulling / booting)')
sys.exit(1)
"
}

if [ "${1:-}" = "--wait" ]; then
  for i in $(seq 1 90); do
    check && exit 0
    sleep 10
  done
  echo "timed out waiting for pod runtime" >&2
  exit 1
else
  check || true
fi
