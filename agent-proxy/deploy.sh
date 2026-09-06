#!/usr/bin/env bash
# Push the LOCAL agent-proxy to the EC2 box and restart it under pm2:
#   edit locally → test locally → ./deploy.sh → live in a few seconds.
#
# Config (host + key) comes from agent-proxy/.deploy.env, which is gitignored. Example:
#   AP_HOST=ubuntu@107.23.203.105
#   AP_PEM=$HOME/.ssh/fast-router-kp.pem
#
# Secrets (.env) are NOT synced. They are set once on the box, so a redeploy can never overwrite a key
# with whatever happened to be on a laptop.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/.deploy.env" ] && . "$HERE/.deploy.env"
: "${AP_HOST:?set AP_HOST=ubuntu@<ip> in agent-proxy/.deploy.env}"
: "${AP_PEM:?set AP_PEM=/path/to/key.pem in agent-proxy/.deploy.env}"
SSH="ssh -i ${AP_PEM/#\~/$HOME} -o StrictHostKeyChecking=no -o ConnectTimeout=15"

# ONE SOURCE. The contract lives in vm/packages/agent-contract because the engine's Docker image copies only
# vm/ and must be able to import it; this box gets only agent-proxy/, so it needs a copy beside the proxy.
# Placed on EVERY deploy from the one original, never edited here — a copy that is refreshed is a mirror, a
# copy that is edited is the four-places problem coming back.
CONTRACT="$HERE/../vm/packages/agent-contract/contract.mjs"
[ -f "$CONTRACT" ] || { echo "✗ contract not found at $CONTRACT — refusing to deploy a proxy with no rules"; exit 1; }
cp "$CONTRACT" "$HERE/contract.mjs"
echo "→ contract copied from vm/packages/agent-contract (single source)"

echo "→ syncing source to $AP_HOST"
rsync -az --delete \
  --exclude node_modules --exclude logs --exclude .git \
  --exclude .deploy.env --exclude .env --exclude '*.pem' \
  -e "$SSH" "$HERE/" "$AP_HOST:agent-proxy/"

echo "→ restarting under pm2"
# Port 443 is privileged: the capability goes on the node BINARY so the proxy itself never runs as root.
$SSH "$AP_HOST" 'set -e
  sudo setcap "cap_net_bind_service=+ep" "$(readlink -f "$(which node)")"
  mkdir -p ~/agent-proxy/logs
  cd ~/agent-proxy
  pm2 describe agent-proxy >/dev/null 2>&1 \
    && pm2 restart ecosystem.config.cjs --update-env >/dev/null \
    || pm2 start ecosystem.config.cjs >/dev/null
  pm2 save >/dev/null
  sleep 2; pm2 status | grep -E "agent-proxy|online" | head -3'

echo "✓ deployed — health:  curl -s http://\${AP_HOST#*@}:443/p/x/_health"
echo "  logs:               $SSH $AP_HOST 'pm2 logs agent-proxy'"
