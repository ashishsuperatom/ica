#!/usr/bin/env bash
# Roll the engine to an always-on Docker box (e.g. fusion5). "Replace, don't version" — the engine connects OUT
# to the hub, which evicts the previous code-engine when the new one connects, so no ports / blue-green needed.
# State is on the persistent volume and additive schema self-migrates, so a code-only roll needs no migration.
#
#   fast      (default) — rsync source + docker cp into the RUNNING container + restart. ~30-60s. EPHEMERAL:
#                         reverts to the image on a container recreate/reboot. Use for rapid iteration.
#   permanent           — rsync source + `docker compose up -d --build`. ~1-2 min. Baked into the image;
#                         survives reboots. Build failure leaves the OLD container running (safe).
#
# Usage:
#   SSH_HOST=0.tcp.au.ngrok.io SSH_PORT=13632 deploy/roll-engine.sh [fast|permanent]
# Optional env: SSH_USER (default ashish.tandi@fusion5.com), SSH_KEY (default ~/.ssh/superatom_vm),
#               CONTAINER (default sa-engine-docker-engine-1), BUNDLE (default sa-engine-docker)
set -euo pipefail
MODE="${1:-fast}"
SSH_USER="${SSH_USER:-ashish.tandi@fusion5.com}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/superatom_vm}"
HOST="${SSH_HOST:?set SSH_HOST}"; PORT="${SSH_PORT:?set SSH_PORT}"
CONTAINER="${CONTAINER:-sa-engine-docker-engine-1}"
BUNDLE="${BUNDLE:-sa-engine-docker}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SSH_OPTS=(-i "$SSH_KEY" -p "$PORT" -o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new -l "$SSH_USER")

echo "[roll] mode=$MODE  →  $HOST:$PORT ($CONTAINER)"
echo "[roll] 1/3 syncing vm/ → box:~/$BUNDLE/vm/"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  --exclude='node_modules/' --exclude='.state/' --exclude='.git/' --exclude='dist/' --exclude='out/' \
  --exclude='*.log' --exclude='.turbo/' --exclude='.DS_Store' --exclude='._*' --exclude='.data/' \
  "$REPO/vm/" "$HOST:$BUNDLE/vm/"

if [ "$MODE" = "permanent" ]; then
  echo "[roll] 2/3 rebuilding image (permanent — build failure keeps the old container up)…"
  ssh "${SSH_OPTS[@]}" "$HOST" "bash -lc 'cd ~/$BUNDLE && docker compose up -d --build'"
else
  echo "[roll] 2/3 fast: copying source into the running container + restart…"
  ssh "${SSH_OPTS[@]}" "$HOST" "bash -lc 'docker cp ~/$BUNDLE/vm/apps/. $CONTAINER:/app/apps/ && docker cp ~/$BUNDLE/vm/packages/. $CONTAINER:/app/packages/ && cd ~/$BUNDLE && docker compose restart engine'"
fi

echo "[roll] 3/3 waiting for ENGINE FULLY READY…"
ssh "${SSH_OPTS[@]}" "$HOST" "bash -lc 'for i in \$(seq 1 40); do docker logs --tail 60 $CONTAINER 2>&1 | grep -q \"ENGINE FULLY READY\" && { echo \"[roll] ✅ FULLY READY\"; exit 0; }; sleep 3; done; echo \"[roll] ⚠️  no FULLY READY after 120s — check: docker logs $CONTAINER\"; exit 1'"
