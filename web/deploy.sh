#!/usr/bin/env bash
# One-command deploy of the stream page to Vercel production + domain wiring.
# Requires VERCEL_TOKEN in stage0/.env (create at https://vercel.com/account/tokens).
#
# What it does:
#   1. Resolves your Vercel account id from the token
#   2. Creates the "clankerpit" project if it doesn't exist (otherwise reuses it)
#   3. Writes .vercel/project.json so `vercel deploy` is non-interactive
#   4. Deploys web/ to production
#   5. Attaches clankerpit.com and www.clankerpit.com to the project
#   6. Prints the DNS records to set at the registrar
set -euo pipefail
cd "$(dirname "$0")"
set -a; source ../stage0/.env; set +a
: "${VERCEL_TOKEN:?VERCEL_TOKEN missing — paste it into stage0/.env first}"

API="https://api.vercel.com"
AUTH="Authorization: Bearer $VERCEL_TOKEN"

echo "==> resolving account"
USER_ID=$(curl -sf -H "$AUTH" "$API/v2/user" | python3 -c "import json,sys; print(json.load(sys.stdin)['user']['id'])")
echo "    account: $USER_ID"

echo "==> project clankerpit"
PROJECT_ID=$(curl -s -H "$AUTH" "$API/v9/projects/clankerpit" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('id',''))" || true)
if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID=$(curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
    "$API/v10/projects" -d '{"name":"clankerpit","framework":null}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
  echo "    created: $PROJECT_ID"
else
  echo "    exists: $PROJECT_ID"
fi

mkdir -p .vercel
cat > .vercel/project.json <<EOF
{"projectId":"$PROJECT_ID","orgId":"$USER_ID"}
EOF

echo "==> deploying to production"
DEPLOY_URL=$(npx --yes vercel@latest deploy --prod --yes --token "$VERCEL_TOKEN" 2>/dev/null | tail -1)
echo "    $DEPLOY_URL"

echo "==> attaching domains"
for d in clankerpit.com www.clankerpit.com; do
  RESULT=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
    "$API/v10/projects/$PROJECT_ID/domains" -d "{\"name\":\"$d\"}")
  echo "    $d: $(echo "$RESULT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('ok' if d.get('name') else d.get('error',{}).get('message', d))" 2>/dev/null || echo "$RESULT")"
done

echo
echo "Done. Final step at your DNS registrar for clankerpit.com:"
echo "  A     @     76.76.21.21"
echo "  CNAME www   cname.vercel-dns.com"
echo "(If you prefer, transfer nameservers to Vercel DNS: ns1.vercel-dns.com, ns2.vercel-dns.com)"
