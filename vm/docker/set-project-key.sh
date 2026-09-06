#!/usr/bin/env bash
# ── PUT A ROTATED PROJECT KEY ON THIS BOX ────────────────────────────────────────────────────────────────
#
# Run this ON the engine box after issuing a new key in the admin UI (Projects → Rotate key). Both keys work
# until you press Finish there, so this can be done calmly and verified before the old one is retired.
#
#   ./set-project-key.sh
#
# The key is READ FROM A PROMPT, never passed as an argument: an argument lands in shell history, in the
# process list while it runs, and in any terminal recording. Prompting keeps it out of all three. It is also
# read silently, so it does not appear on screen.
set -euo pipefail

DIR="${ENGINE_DIR:-$HOME/superatom-engine}"
ENVF="$DIR/.env"
[ -f "$ENVF" ] || { echo "✗ no .env at $ENVF (set ENGINE_DIR)"; exit 1; }

printf 'New ICA_KEY (input hidden): '
read -rs KEY; echo
[ -n "$KEY" ] || { echo "✗ nothing entered"; exit 1; }
case "$KEY" in sk-proj-*) ;; *) echo "✗ that does not look like a project key (expected sk-proj-…)"; exit 1;; esac

# Keep a copy of the previous line. Both keys are valid during a rotation, so if anything goes wrong the old
# one still works and putting it back is a one-line edit rather than a recovery.
cp "$ENVF" "$ENVF.before-rotation"
if grep -q '^ICA_KEY=' "$ENVF"; then
  # A temp file, not sed -i in place: an interrupted in-place edit can leave .env truncated, and a box with a
  # half-written .env does not start at all.
  awk -v k="$KEY" '/^ICA_KEY=/ { print "ICA_KEY=" k; next } { print }' "$ENVF" > "$ENVF.tmp"
  mv "$ENVF.tmp" "$ENVF"
else
  printf '\nICA_KEY=%s\n' "$KEY" >> "$ENVF"
fi
chmod 600 "$ENVF"
echo "→ .env updated (previous kept at .env.before-rotation)"

echo "→ restarting the engine"
( cd "$DIR" && docker compose up -d >/dev/null 2>&1 )

echo "→ waiting for it to connect and prove the new key"
for i in $(seq 1 24); do
  sleep 5
  L=$(cd "$DIR" && docker compose logs --since 3m 2>/dev/null | grep -cE 'ENGINE FULLY READY|ENGINE READY' || true)
  B=$(cd "$DIR" && docker compose logs --since 3m 2>/dev/null | grep -cE 'Invalid API key|4001' || true)
  if [ "${B:-0}" -gt 0 ]; then echo "✗ the hub rejected the key — restore with: cp $ENVF.before-rotation $ENVF && docker compose up -d"; exit 1; fi
  if [ "${L:-0}" -gt 0 ]; then
    echo "✓ engine is up on the new key."
    echo "  Now press Finish in the admin UI to retire the old one, then run the diagnostic:"
    echo "    docker compose exec engine pnpm exec tsx apps/engine/tools/diag.mts"
    exit 0
  fi
done
echo "? engine did not report ready within two minutes — check:  docker compose logs --tail 40"
exit 1
