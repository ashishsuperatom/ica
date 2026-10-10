#!/usr/bin/env bash
# Every typecheck and test suite in the repository, in order; stops at the first failure and says which.
# Run before every deploy and push:   scripts/check-all.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail() { echo "✗ $1"; exit 1; }
step() {   # step <label> <dir> <command…>
  local label="$1" dir="$2"; shift 2
  local out; out="$(cd "$ROOT/$dir" && "$@" 2>&1)" || { echo "$out" | tail -30; fail "$label"; }
  echo "✓ $label"
}
step "vm typecheck"                vm                          pnpm -s typecheck
step "platform dataset guard"     vm                          pnpm -s check:generic
for p in migrate platform-types state programs session decision ui composition-graph; do
  step "vm/packages/$p tests"     "vm/packages/$p"            pnpm -s test
done
step "engine tests"                vm/apps/engine              pnpm -s test
for t in vm/apps/datasources/manager/sqlrewrite/test_*.py; do
  step "SQL rewrite $(basename "$t")"  vm/apps/datasources/manager  python3 "sqlrewrite/$(basename "$t")"
done
step "connectors build"            connectors                  pnpm -s build
step "connectors dist is committed" connectors                  sh -c "git ls-files --error-unmatch dist/catalog.json dist/code.json dist/bridges.json >/dev/null && git diff --quiet --exit-code -- dist"
step "connectors typecheck"        connectors                  pnpm -s typecheck
step "connectors tests"            connectors                  pnpm -s test
step "control plane typecheck"    control-plane/superadmin    pnpm -s typecheck
step "user UI typecheck"          control-plane/user-ui       npx tsc --noEmit -p tsconfig.json
step "dashboard template typecheck" .                         scripts/check-template-app.sh
step "control plane tests"        control-plane/superadmin    npx vitest run
step "reporting tests"            reporting                   pnpm -s test
step "CLI typecheck"              cli                         pnpm -s typecheck
step "CLI build"                  cli                         pnpm -s build
step "CLI tests"                  cli                         pnpm -s test
echo "all checks passed"
