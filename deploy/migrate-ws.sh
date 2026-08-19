#!/usr/bin/env bash
# Migrate a workspace to the concern-organized layout (idempotent):
#   - move every SQLite file (+ -wal/-shm) into db/
#   - remove the stale ROOT-level seams + role docs (regenerated in their concern folders next run)
# Keeps CONTEXT.md, run.mjs, programs/, units/, out/ and the new concern folders untouched.
# Usage: migrate-ws.sh <workspace-dir>            (one project workspace)
#        migrate-ws.sh --state-root <state-root>  (iterate every <id>/ under a state root)
set -euo pipefail

migrate_one() {
  local ws="$1"
  [ -d "$ws" ] || { echo "skip (no dir): $ws"; return 0; }
  mkdir -p "$ws/db"
  for db in project.sqlite grounding.sqlite answers.sqlite; do
    for ext in "" "-wal" "-shm"; do
      if [ -f "$ws/$db$ext" ]; then mv -f "$ws/$db$ext" "$ws/db/$db$ext"; echo "  moved $db$ext -> db/"; fi
    done
  done
  for f in query.mjs introspect.mjs model.mjs grounding.mjs ANALYST.md MODEL.md GROUNDING.md CONNECTOR.md; do
    if [ -f "$ws/$f" ]; then rm -f "$ws/$f"; echo "  removed stale root $f"; fi
  done
  echo "migrated: $ws"
}

if [ "${1:-}" = "--state-root" ]; then
  root="${2:?usage: migrate-ws.sh --state-root <state-root>}"
  for d in "$root"/*/; do [ -d "$d" ] && migrate_one "${d%/}"; done
else
  migrate_one "${1:?usage: migrate-ws.sh <workspace-dir>}"
fi
