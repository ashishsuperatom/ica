#!/usr/bin/env bash
# Bootstrap the Superatom engine on a fresh Ubuntu host (EC2 / GCE / Azure VM). No Docker.
# Installs Node (via nvm), pnpm (corepack), pm2, build tools, then the workspace deps.
# Idempotent — safe to re-run. Works as root or as a sudo-capable user.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

SUDO=""
if [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

echo "[setup] build tools (native modules need python3/make/g++)…"
if command -v apt-get >/dev/null 2>&1; then
  $SUDO apt-get update -y
  $SUDO apt-get install -y --no-install-recommends python3 make g++ git ca-certificates curl unzip
fi

echo "[setup] Node 22 via nvm…"
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install 22 >/dev/null
nvm use 22 >/dev/null
nvm alias default 22 >/dev/null

echo "[setup] pnpm (corepack) + pm2 + claude-code + tsx…"
corepack enable
corepack prepare pnpm@9.0.0 --activate
# pnpm's global bin dir — put it on PATH now and persist it for future shells.
export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$PNPM_HOME:$PATH"
grep -q 'PNPM_HOME' "$HOME/.bashrc" 2>/dev/null || {
  printf '\nexport PNPM_HOME="%s"\nexport PATH="$PNPM_HOME:$PATH"\n' "$PNPM_HOME" >> "$HOME/.bashrc"
}
npm install -g pm2 >/dev/null
# claude-code is installed GLOBALLY on purpose (a workspace copy would shadow a real system claude).
pnpm add -g @anthropic-ai/claude-code tsx
claude --version >/dev/null && tsx --version >/dev/null

echo "[setup] installing workspace dependencies (compiles native addons — better-sqlite3, node-pty)…"
pnpm install --frozen-lockfile

mkdir -p "$HERE/state" "$HERE/datasources"
[ -f "$HERE/.env" ] || cp "$HERE/.env.example" "$HERE/.env"

cat <<EOF

[setup] Done.

Next:
  1. Edit .env with your project's keys:   nano .env
       (ICA_PROJECT, ICA_KEY, ICA_HUB — the same values a Fly machine gets.)
  2. Authenticate the coding agent once:   claude login
       (or put CLAUDE_CODE_OAUTH_TOKEN=... in .env instead.)
  3. Start everything:                     ./run.sh
       Then watch it connect:  pm2 logs sa-engine   (look for "ENGINE FULLY READY").

State lives in ./state — nothing here is destroyed on a re-run.
EOF
