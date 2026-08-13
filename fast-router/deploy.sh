#!/usr/bin/env bash
# Push the LOCAL fast-router to the EC2 box and restart it — the iterate loop is:
#   edit locally → test locally → ./deploy.sh → live on EC2 in a few seconds.
#
# Only source is synced (never node_modules / .qdrant / the model cache), so it's fast and never
# clobbers the box's installed deps or downloaded model. Deps are re-installed only if they changed.
#
# Config (host + key) comes from fast-router/.deploy.env (gitignored). Example:
#   FR_HOST=ubuntu@107.23.203.105
#   FR_PEM=$HOME/.ssh/fast-router-kp.pem
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/.deploy.env" ] && . "$HERE/.deploy.env"
: "${FR_HOST:?set FR_HOST=ubuntu@<ip> in fast-router/.deploy.env}"
: "${FR_PEM:?set FR_PEM=/path/to/key.pem in fast-router/.deploy.env}"
SSH="ssh -i ${FR_PEM/#\~/$HOME} -o StrictHostKeyChecking=no -o ConnectTimeout=15"

echo "→ syncing source to $FR_HOST"
rsync -az --delete \
  --exclude node_modules --exclude .qdrant --exclude snapshots \
  --exclude .git --exclude .deploy.env --exclude '*.pem' \
  -e "$SSH" "$HERE/" "$FR_HOST:fast-router/"

echo "→ install if deps changed, then restart the worker"
$SSH "$FR_HOST" 'cd ~/fast-router && pnpm install --prefer-offline 2>&1 | tail -3 && pm2 restart fr-worker >/dev/null && sleep 3 && pm2 status | grep -Ei "fr-|online"'
echo "✓ deployed — tail logs with:  $SSH $FR_HOST 'pm2 logs fr-worker'"
