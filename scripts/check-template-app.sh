#!/usr/bin/env bash
# Typechecks the dashboard template app (vm/packages/project-template/shared/app/web) as a project home receives it:
# rendered into a scratch folder with {{PLATFORM}} replaced by this repository (as project-template/cli.mjs does), its
# packages lent from the user UI (react, vite), the control plane (vitest) and the vm workspace (@types/node) — the
# template keeps no node_modules of its own.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cp -R "$ROOT/vm/packages/project-template/shared/app/web/." "$T/"
sed -i.bak "s#{{PLATFORM}}#$ROOT#g" "$T/tsconfig.app.json" && rm "$T/tsconfig.app.json.bak"
mkdir -p "$T/node_modules/@types"
for d in "$ROOT/control-plane/user-ui/node_modules/"*; do [ "$(basename "$d")" = "@types" ] || ln -s "$d" "$T/node_modules/"; done
for d in "$ROOT/control-plane/user-ui/node_modules/@types/"*; do ln -s "$d" "$T/node_modules/@types/"; done
ln -s "$ROOT/vm/node_modules/@types/node" "$T/node_modules/@types/node"
ln -s "$ROOT/control-plane/superadmin/node_modules/vitest" "$T/node_modules/vitest"
cd "$T" && "$ROOT/control-plane/user-ui/node_modules/.bin/tsc" -p tsconfig.app.json --noEmit
