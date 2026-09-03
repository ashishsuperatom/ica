#!/usr/bin/env bash
# Roll the engine to an always-on Docker box. "Replace, don't version" — the engine connects OUT
# to the hub, which evicts the previous code-engine when the new one connects, so no ports / blue-green needed.
# State is on the persistent volume and additive schema self-migrates, so a code-only roll needs no migration.
#
#   fast      (default) — rsync source + docker cp into the RUNNING container + restart. ~30-60s. EPHEMERAL:
#                         reverts to the image on a container recreate/reboot. Use for rapid iteration.
#   permanent           — rsync source + `docker compose up -d --build`. ~1-2 min. Baked into the image;
#                         survives reboots. Build failure leaves the OLD container running (safe).
#
# Usage:
#   SSH_HOST=<host> SSH_PORT=<port> SSH_USER=<user> deploy/roll-engine.sh [fast|permanent]
# Required env: SSH_HOST, SSH_PORT, SSH_USER — whose box it is, is not something this script should assume.
# Optional env: SSH_KEY (default ~/.ssh/superatom_vm), CONTAINER (default superatom-engine-1),
#               BUNDLE (default superatom-engine)
set -euo pipefail
MODE="${1:-fast}"
SSH_USER="${SSH_USER:?set SSH_USER}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/superatom_vm}"
HOST="${SSH_HOST:?set SSH_HOST}"; PORT="${SSH_PORT:?set SSH_PORT}"
# <compose project>-<service>-<n>. The project is the bundle dir (superatom-engine) and the service is
# `engine`, so "engine" appears twice. The old default omitted the service, so every `fast` roll aborted on
# the first docker cp until CONTAINER was passed by hand. It failed loudly, which is why it never became a
# wrong-code incident — but it made the documented invocation one that does not work.
CONTAINER="${CONTAINER:-superatom-engine-engine-1}"
BUNDLE="${BUNDLE:-superatom-engine}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SSH_OPTS=(-i "$SSH_KEY" -p "$PORT" -o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new -l "$SSH_USER")

echo "[roll] mode=$MODE  →  $HOST:$PORT ($CONTAINER)"
echo "[roll] 1/3 syncing vm/ → box:~/$BUNDLE/vm/"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  --exclude='node_modules/' --exclude='.state/' --exclude='.git/' --exclude='dist/' --exclude='out/' \
  --exclude='*.log' --exclude='.turbo/' --exclude='.DS_Store' --exclude='._*' --exclude='.data/' \
  --exclude='_*.mts' --exclude='_*.cjs' --exclude='_*.mjs' \
  --exclude='projects/' \
  "$REPO/vm/" "$HOST:$BUNDLE/vm/"

# WHY projects/ IS EXCLUDED, and it is not an optimisation:
#   --delete makes this rsync a MIRROR, and the box runs a different project from the laptop. Its
#   vm/projects/<its id>/ holds that project's .env, its private key and its datasource bridges — none of
#   which exist here, all of which --delete would remove. The engine would come up with no credentials and no
#   sources, and the only copy of some of it is on that box, because secrets are deliberately not in git.
#   Code is what this script rolls. Project CONFIG belongs to the box.

if [ "$MODE" = "permanent" ]; then
  echo "[roll] 2/3 rebuilding image (permanent — build failure keeps the old container up)…"
  ssh "${SSH_OPTS[@]}" "$HOST" "bash -lc 'cd ~/$BUNDLE && docker compose up -d --build'"
else
  echo "[roll] 2/3 fast: copying source into the running container + restart…"
  ssh "${SSH_OPTS[@]}" "$HOST" "bash -lc 'docker cp ~/$BUNDLE/vm/apps/. $CONTAINER:/app/apps/ && docker cp ~/$BUNDLE/vm/packages/. $CONTAINER:/app/packages/ && cd ~/$BUNDLE && docker compose restart engine'"
fi

echo "[roll] 3/3 waiting for ENGINE FULLY READY…"
ssh "${SSH_OPTS[@]}" "$HOST" "bash -lc 'for i in \$(seq 1 40); do docker logs --tail 60 $CONTAINER 2>&1 | grep -q \"ENGINE FULLY READY\" && { echo \"[roll] ✅ FULLY READY\"; exit 0; }; sleep 3; done; echo \"[roll] ⚠️  no FULLY READY after 120s — check: docker logs $CONTAINER\"; exit 1'"
