#!/usr/bin/env bash
# Creates the Clanker Pit arena pod on RunPod (idempotent: refuses if pod.json exists).
# Requires RUNPOD_API_KEY (stage0/.env is sourced automatically) and infra/pod_ed25519.pub.
# NOTE: RunPod's Cloudflare blocks Python's default UA — always call via curl.
set -euo pipefail
cd "$(dirname "$0")"

if [ -f pod.json ]; then
  echo "pod.json already exists — refusing to create a second pod. Delete it only after terminating the old pod." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; source ../stage0/.env; set +a
: "${RUNPOD_API_KEY:?RUNPOD_API_KEY missing (check stage0/.env)}"

PUBKEY=$(cat pod_ed25519.pub)

python3 - "$PUBKEY" > /tmp/pod-create.json <<'PYEOF'
import json, sys
payload = {
  "query": "mutation ($input: PodFindAndDeployOnDemandInput!) { podFindAndDeployOnDemand(input: $input) { id name desiredStatus imageName costPerHr } }",
  "variables": {"input": {
    "name": "clankerpit-arena",
    "imageName": "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04",
    "gpuTypeId": "NVIDIA GeForce RTX 3090",
    "cloudType": "COMMUNITY",
    "gpuCount": 1,
    "volumeInGb": 0,
    "containerDiskInGb": 60,
    "minVcpuCount": 4,
    "minMemoryInGb": 16,
    "ports": "22/tcp,8080/http",
    "startSsh": True,
    "env": [
      {"key": "PUBLIC_KEY", "value": sys.argv[1]},
      {"key": "JUPYTER_PASSWORD", "value": "disabled"}
    ]
  }}
}
print(json.dumps(payload))
PYEOF

RESPONSE=$(curl -s -X POST -H "Content-Type: application/json" -H "User-Agent: Mozilla/5.0" \
  "https://api.runpod.io/graphql?api_key=$RUNPOD_API_KEY" -d @/tmp/pod-create.json)

echo "$RESPONSE" | python3 -m json.tool
if echo "$RESPONSE" | grep -q '"id"'; then
  echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']['podFindAndDeployOnDemand']; json.dump(d, open('pod.json','w'), indent=2)"
  echo "Saved pod info to infra/pod.json"
fi
