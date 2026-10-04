#!/usr/bin/env bash
# THE ONE WAY THE CONTROL PLANE IS DEPLOYED.
#
#   1. Only committed code: a deploy is a commit, so what runs can always be found.
#   2. Every check (scripts/check-all.sh) — including the lock that keeps shipped migrations from ever changing.
#   3. Deploy, remembering the version that was live.
#   4. Smoke-test production: the site answers, and every live project's Durable Object starts (its migrations run) —
#      a made-up agent key must be refused with "unknown key", which only a started DO can say.
#   5. If any of that fails: roll back to the version that was live, at once, and say why.
#
#   scripts/deploy-control-plane.sh            (pnpm -C control-plane/superadmin run deploy calls this)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CP="$ROOT/control-plane/superadmin"
SITE="${SA_SITE:-https://superatom.site}"
say() { echo "▸ $*"; }
fail() { echo "✗ $*"; exit 1; }

cd "$ROOT"
dirty="$(git status --porcelain -- control-plane vm cli clients scripts | grep -v '^??' || true)"
[ -z "$dirty" ] || { echo "$dirty"; fail "uncommitted changes — commit them first; a deploy is a commit"; }
say "deploying $(git rev-parse --short HEAD): $(git log -1 --format=%s | cut -c1-90)"

say "running every check"
"$ROOT/scripts/check-all.sh" > /tmp/sa-deploy-checks.log 2>&1 || { tail -20 /tmp/sa-deploy-checks.log; fail "checks failed — not deploying"; }

cd "$CP"
PREV="$(npx wrangler deployments list --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d[-1]["versions"][0]["version_id"])' 2>/dev/null || true)"
[ -n "$PREV" ] || fail "could not read the live version (needed to roll back) — not deploying"
say "live now: $PREV"

say "building and deploying"
pnpm -s run deploy:raw > /tmp/sa-deploy.log 2>&1 || { tail -20 /tmp/sa-deploy.log; fail "the deploy itself failed (nothing changed if wrangler did not upload)"; }
NEW="$(grep -oE 'Current Version ID: [0-9a-f-]+' /tmp/sa-deploy.log | awk '{print $4}')"
say "deployed: $NEW"

rollback() {
  echo "✗ smoke test failed: $1"
  say "rolling back to $PREV"
  npx wrangler rollback "$PREV" -y -m "automatic: $1" > /tmp/sa-rollback.log 2>&1 && say "rolled back to $PREV" || { tail -10 /tmp/sa-rollback.log; echo "✗ ROLLBACK FAILED — roll back by hand: npx wrangler rollback $PREV"; }
  exit 1
}

say "smoke test"
code="$(curl -s -o /dev/null -w '%{http_code}' "$SITE/u/")"
[ "$code" = "200" ] || rollback "the user app answered $code"
fake() { printf 'sak_%s_%s' "$1" "$(printf 'z%.0s' $(seq 1 43))"; }
for pid in $(grep -vE '^\s*(#|$)' "$ROOT/scripts/live-projects.txt"); do
  ok=""
  for attempt in 1 2 3 4 5 6; do
    body="$(curl -s -X POST "$SITE/api/agent/$pid" -H "authorization: Bearer $(fake "$pid")" -d '{"t":"session:agents"}' -w '\n%{http_code}')"
    if [ "$(echo "$body" | tail -1)" = "401" ] && echo "$body" | grep -q 'unknown key'; then ok=1; break; fi
    sleep 5
  done
  [ -n "$ok" ] || rollback "project $pid's Durable Object did not start (last answer: $(echo "$body" | head -c 200))"
  say "project $pid: starts"
done
echo "✓ deployed $NEW and checked"
