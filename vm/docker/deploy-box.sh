#!/usr/bin/env bash
# ── PUT THIS REPO ON A BOX AND REBUILD ITS IMAGE ─────────────────────────────────────────────────────────
#
# WHY THIS EXISTS. The engine on a self-hosted box was updated by rsyncing the handful of files that had
# changed — whichever ones were remembered. That worked until it did not: the box's tree drifted to 175 of
# this repo's 176 engine files, the missing one only showed up when something tried to run it, and "I rebuilt
# the image" stopped meaning "the image matches the repo". An image built from a partial copy is a deploy you
# cannot reason about, and the failures it produces look like bugs in the code rather than gaps in the copy.
#
# So: ALWAYS the whole tree, never a file list. --delete, so a file removed here is removed there — a stale
# module left behind on the box is the same class of problem in the other direction.
#
# WHAT IT NEVER SENDS: .env and keys (the box's own credentials are set there and must not be overwritten
# from a laptop), node_modules and dist (the image builds its own), and local state (.state, .data,
# workspaces) which is the box's data, not ours. These mirror .dockerignore for the same reasons.
#
#   vm/docker/deploy-box.sh <ssh-host> [ssh-port] [remote-dir]
#
# Example (fusion5, through the ngrok tunnel):
#   vm/docker/deploy-box.sh ashish.tandi@fusion5.com@0.tcp.au.ngrok.io 16082
set -euo pipefail

HOST="${1:?usage: deploy-box.sh <ssh-host> [ssh-port] [remote-dir]}"
PORT="${2:-22}"
DIR="${3:-superatom-engine}"
KEY="${SSH_KEY:-$HOME/.ssh/superatom_vm}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

SSH="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -p $PORT"

echo "→ syncing the whole tree to $HOST:$DIR (nothing hand-picked)"
# --stats, not --info=stats1: macOS still ships rsync 2.6.9, which does not have --info at all.
rsync -az --delete --stats -e "$SSH" \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.env' --exclude '.env.*' --exclude '*.pem' \
  --exclude '.state' --exclude '.data' \
  --exclude '.agent-workspace' --exclude '.ica-workspace' \
  "$ROOT/vm/" "$HOST:$DIR/vm/"

# The Dockerfile lives at the repo root and COPYs vm/, so it has to go too — a box building from last
# month's Dockerfile against this month's source is the same drift in a place nobody thinks to look.
rsync -az -e "$SSH" "$ROOT/Dockerfile" "$HOST:$DIR/Dockerfile"

echo "→ verifying the copy matches (engine source file count)"
LOCAL_N=$(find "$ROOT/vm/apps/engine" -type f \( -name '*.ts' -o -name '*.mts' \) -not -path '*/node_modules/*' | wc -l | tr -d ' ')
REMOTE_N=$($SSH "$HOST" "find $DIR/vm/apps/engine -type f \( -name '*.ts' -o -name '*.mts' \) -not -path '*/node_modules/*' | wc -l" | tr -d ' ')
echo "   local=$LOCAL_N remote=$REMOTE_N"
[ "$LOCAL_N" = "$REMOTE_N" ] || { echo "✗ the box did not receive the whole tree — stopping before building a wrong image"; exit 1; }

echo "→ building the image on the box"
$SSH "$HOST" "cd $DIR && docker compose build 2>&1 | tail -5"

echo "✓ synced and built. Recreate the container with:  docker compose up -d"
