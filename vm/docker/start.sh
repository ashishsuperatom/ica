#!/bin/sh
set -e

echo "[vm] starting services (project=${ICA_PROJECT:-unset})..."

# ── Agent auth PERSISTS on the volume ─────────────────────────────────────────
# claude/opencode/codex store their credentials under $HOME. The container's /root is EPHEMERAL (reset to
# the image on every stop/start), so auth done there is lost on restart. Point HOME at /app/data (the
# mounted volume) so a login survives restarts — you auth ONCE. Also seed claude-code's onboarding flag so
# its interactive first-run theme picker (which blocks the headless harness) never appears.
export HOME=/app/data/agent-home
mkdir -p "$HOME"
[ -f "$HOME/.claude.json" ] || printf '{"hasCompletedOnboarding":true,"theme":"dark"}' > "$HOME/.claude.json"
echo "[vm] HOME=$HOME (agent auth persists on the volume)"

# ── Warm the opencode server ──────────────────────────────────────────────────
# The reflex agent (opencode-go) connects to a running opencode server. Cold-spawning it per question
# exceeds the SDK's 5s startup timeout on this box and would crash the engine — so start ONE server here at
# boot and point the engine at it via ICA_OC_URL. It reads opencode-go auth from $HOME (the volume).
export PATH="/usr/local/share/pnpm:/app/apps/engine/node_modules/.bin:/app/node_modules/.bin:$PATH"
( cd /app/apps/engine && opencode serve --hostname 127.0.0.1 --port 4096 >/tmp/opencode-serve.log 2>&1 & )
export ICA_OC_URL=http://127.0.0.1:4096
echo "[vm] opencode serve warming on :4096"

# The machine env (from fly.ts) carries everything: ICA_PROJECT/ICA_KEY/ICA_HUB, DATASOURCE_URL,
# ENGINE_STATE_DIR / DATASOURCE_DATA_DIR / DATASOURCES_DIR (all under the mounted volume /app/data), and
# CLAUDE_CODE_OAUTH_TOKEN. Both processes below inherit it. One project per machine.

# ── Datasource manager (background, localhost only) ──────────────────────────
# Serves this project's sources from its registry.json under DATASOURCE_DATA_DIR (empty on a fresh machine —
# sources are added later via the connector agent). The engine reaches it at http://localhost:4000.
cd /app/apps/datasources/manager
DATASOURCE_PORT=4000 pnpm exec tsx src/index.ts &
DS_PID=$!
echo "[vm] datasource-manager pid=$DS_PID on :4000"
sleep 2   # let it bind before the engine calls it

# ── ICA engine (main process) ────────────────────────────────────────────────
# Connects OUT to the hub as role code-engine (no inbound ports). Persists model/programs/answers to the
# volume via ENGINE_STATE_DIR (state/<project>/).
cd /app/apps/engine
echo "[vm] ica-engine → ${ICA_HUB:-wss://superatom.site}"
exec pnpm exec tsx engine.ts
