#!/usr/bin/env bash
# Start the Superatom engine + its sidecars under pm2. Reads .env for the project connection/keys;
# sets the infra paths (state dir, ports) itself. Re-run to restart. Survives reboot via `pm2 save`.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

# 1. connection + keys from .env (ICA_PROJECT / ICA_KEY / ICA_HUB / optional CLAUDE_CODE_OAUTH_TOKEN)
set -a; [ -f .env ] && . ./.env; set +a
: "${ICA_PROJECT:?set ICA_PROJECT in .env}"
: "${ICA_KEY:?set ICA_KEY in .env}"

# 2. infra paths — authoritative + absolute, so nothing depends on cwd. ONE unified state dir.
export ENGINE_STATE_DIR="$HERE/state"
export DATASOURCES_DIR="$HERE/datasources"
export DATASOURCE_DATA_DIR="$HERE/datasources"
export DATASOURCE_URL="${DATASOURCE_URL:-http://localhost:4000}"
export ICA_OC_URL="${ICA_OC_URL:-http://127.0.0.1:4096}"
mkdir -p "$ENGINE_STATE_DIR" "$DATASOURCES_DIR"

# 3. put nvm's node + pnpm's global bin on PATH (so pm2/pnpm/claude/tsx resolve)
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && { . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null 2>&1 || true; }
export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$PNPM_HOME:$PATH"

start() {  # start (or restart) one pm2 process, inheriting the env exported above
  local name="$1" cwd="$2" cmd="$3"
  if pm2 describe "$name" >/dev/null 2>&1; then pm2 restart "$name" --update-env
  else pm2 start "$cmd" --name "$name" --cwd "$cwd" --interpreter none; fi
}

echo "[run] opencode server (reflex model) on :4096…"
start sa-opencode "$HERE/apps/engine" "pnpm exec opencode serve --hostname 127.0.0.1 --port 4096"
echo "[run] datasource-manager on :4000…"
start sa-manager "$HERE/apps/datasources/manager" "pnpm exec tsx src/index.ts"
sleep 2
echo "[run] engine (connects OUT to the hub; no inbound ports)…"
start sa-engine "$HERE/apps/engine" "pnpm exec tsx engine.ts"

pm2 save
echo "[run] up. Watch:  pm2 logs sa-engine"
