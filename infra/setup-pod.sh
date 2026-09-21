#!/usr/bin/env bash
# Copies the setup script and bot code to the pod, then runs setup over SSH.
# No arguments: discovers the pod's public SSH endpoint from the RunPod API.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck disable=SC1091
set -a; source ../stage0/.env; set +a
POD_ID=$(python3 -c "import json; print(json.load(open('pod.json'))['id'])")

QUERY='{"query":"{ pod(input: {podId: \"'$POD_ID'\"}) { runtime { ports { ip isIpPublic privatePort publicPort } } } }"}'
RESP=$(curl -s -X POST -H "Content-Type: application/json" -H "User-Agent: Mozilla/5.0" \
  "https://api.runpod.io/graphql?api_key=$RUNPOD_API_KEY" -d "$QUERY")
read HOST PORT < <(echo "$RESP" | python3 -c "
import json, sys
ports = (json.load(sys.stdin)['data']['pod'].get('runtime') or {}).get('ports') or []
for p in ports:
    if p['privatePort'] == 22 and p['isIpPublic']:
        print(p['ip'], p['publicPort'])
        break
")
[ -n "${HOST:-}" ] && [ -n "${PORT:-}" ] || { echo "pod has no public SSH endpoint yet — is it RUNNING? (./pod-status.sh --wait)" >&2; exit 1; }

SSH="ssh -i pod_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p $PORT root@$HOST"
SCP="scp -i pod_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -P $PORT"

echo "==> uploading to root@$HOST:$PORT"
$SCP pod-setup.bash "root@$HOST":/root/pod-setup.bash
$SSH 'mkdir -p /workspace/arena/bot'
$SCP bot/package.json bot/bot-walk.mjs "root@$HOST":/workspace/arena/bot/

echo "==> running remote setup (idempotent)"
$SSH 'bash /root/pod-setup.bash'

echo "==> installing bot dependencies"
$SSH 'cd /workspace/arena/bot && npm install --omit=dev'

echo "==> setup complete"
