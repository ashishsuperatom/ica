#!/usr/bin/env bash
# ── DEPLOY EVERYTHING, IN ORDER, AND PROVE IT ────────────────────────────────────────────────────────────
#
# WHY THIS EXISTS. There are four places this repo runs: the Cloudflare Worker, the engine box, the EC2
# tunnel, and whatever laptop you are on. They were deployed one at a time, by hand, as each change landed —
# and that is not a deploy process, it is a memory test. It failed the way memory tests do: proxy.mjs was
# changed and committed, and the EC2 box went on running the previous version for hours because nobody
# remembered that this particular edit had a third target. The symptom is always the same — the code is right,
# the tests pass, and the running system does something else.
#
# The fix is the same one that fixed the hand-picked rsync: stop choosing. This deploys ALL of them, in
# dependency order, and verifies each before moving on. "Deployed" becomes one state you can check rather
# than four things you have to recall.
#
#   ./deploy-all.sh              deploy everything
#   ./deploy-all.sh --check      verify only: what is live, what has drifted, change nothing
#
# ORDER MATTERS. The Worker first, because both proxies call it to verify a project and read the vault; a box
# deployed against an older Worker can fail in ways that look like a bad key. The engine box last, because it
# is the thing whose health tells you the whole chain works.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

CHECK_ONLY=0; [ "${1:-}" = "--check" ] && CHECK_ONLY=1
ENGINE_HOST="${ENGINE_HOST:-}"; ENGINE_PORT="${ENGINE_PORT:-22}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/superatom_vm}"
[ -f .deploy-targets.env ] && . ./.deploy-targets.env    # ENGINE_HOST=user@host  ENGINE_PORT=nnn (gitignored)

ESSH() { ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -p "$ENGINE_PORT" "$ENGINE_HOST" "$@"; }

step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
ok()   { printf '   ✓ %s\n' "$1"; }
bad()  { printf '   ✗ %s\n' "$1"; FAILED=1; }
FAILED=0

# ── 0. THE CODE IS CORRECT BEFORE ANYTHING SHIPS ────────────────────────────────────────────────────────
step "checks"
( cd vm && pnpm typecheck >/dev/null 2>&1 ) && ok "engine typecheck" || bad "engine typecheck"
( cd control-plane/superadmin && pnpm typecheck >/dev/null 2>&1 ) && ok "worker typecheck" || bad "worker typecheck"
( cd control-plane/superadmin && pnpm test >/dev/null 2>&1 ) && ok "tests" || bad "tests"
node --check agent-proxy/proxy.mjs >/dev/null 2>&1 && ok "proxy.mjs parses" || bad "proxy.mjs parses"
[ "$FAILED" = 1 ] && { echo; echo "✗ refusing to deploy — fix the above first"; exit 1; }

# ── 1. THE ONE CONTRACT, MIRRORED NOWHERE ELSE ──────────────────────────────────────────────────────────
# The EC2 proxy needs a copy beside it (that box gets only agent-proxy/). Confirm the copy is IDENTICAL to
# the source rather than assume it: a stale mirror is the four-places problem returning by the back door.
step "contract"
SRC=vm/packages/agent-contract/contract.mjs
if [ -f agent-proxy/contract.mjs ] && ! diff -q "$SRC" agent-proxy/contract.mjs >/dev/null; then
  bad "agent-proxy/contract.mjs has DRIFTED from $SRC (deploy.sh will overwrite it)"
else ok "contract copy matches the source"; fi

if [ "$CHECK_ONLY" = 1 ]; then
  step "live versions"
  curl -s -m 20 https://superadmin.superatom.site/ -o /dev/null -w "   worker http %{http_code}\n" || true
  if [ -n "$ENGINE_HOST" ]; then
    ESSH "cd \$HOME/superatom-engine && docker compose exec -T engine pnpm exec tsx apps/engine/tools/diag.mts 2>/dev/null | tail -12" || true
  else echo "   (set ENGINE_HOST in .deploy-targets.env to check the engine box)"; fi
  exit $FAILED
fi

# ── 2. WORKER — first, because both proxies depend on it ─────────────────────────────────────────────────
step "worker (cloudflare)"
( cd control-plane/superadmin && pnpm run deploy 2>&1 | tail -2 ) && ok "worker deployed" || bad "worker deploy"

# ── 3. EC2 TUNNEL — the one that got forgotten ───────────────────────────────────────────────────────────
step "tunnel (ec2)"
if [ -f agent-proxy/.deploy.env ]; then
  ( cd agent-proxy && ./deploy.sh 2>&1 | tail -3 ) && ok "tunnel deployed" || bad "tunnel deploy"
else
  bad "agent-proxy/.deploy.env missing — the tunnel was NOT deployed"
fi

# ── 4. ENGINE BOX — last, and it verifies the whole chain ────────────────────────────────────────────────
step "engine box"
if [ -n "$ENGINE_HOST" ]; then
  vm/docker/deploy-box.sh "$ENGINE_HOST" "$ENGINE_PORT" superatom-engine && ok "engine image built" || bad "engine build"
  ESSH "cd \$HOME/superatom-engine && docker compose up -d >/dev/null 2>&1 && echo recreated" && ok "container recreated" || bad "recreate"
  echo "   waiting for it to come up…"; sleep 60
  ESSH "cd \$HOME/superatom-engine && docker compose exec -T engine pnpm exec tsx apps/engine/tools/diag.mts 2>/dev/null | tail -12"
else
  bad "ENGINE_HOST not set — the engine box was NOT deployed (put it in .deploy-targets.env)"
fi

echo
[ "$FAILED" = 0 ] && echo "✓ all four targets are on this commit: $(git rev-parse --short HEAD)" \
                  || echo "✗ something above did not deploy — the targets are NOT all on $(git rev-parse --short HEAD)"
exit $FAILED
