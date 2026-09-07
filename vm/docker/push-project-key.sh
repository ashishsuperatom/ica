#!/usr/bin/env bash
# ── PUSH A ROTATED KEY TO A BOX, FROM A FILE, WITHOUT EVER DISPLAYING IT ─────────────────────────────────
#
# For when someone else does the rotating and an operator (or an agent) does the deploying. The key is read
# from a FILE and passed over ssh on stdin — it is never an argument, never echoed, and never printed on
# success or failure. So it stays out of shell history, out of the process list, and out of any transcript of
# the session that ran this.
#
#   ./push-project-key.sh <key-file> <ssh-host> [ssh-port] [remote-dir]
#
# The file should contain the key and nothing else. Delete it afterwards — the script says so and does not do
# it for you, because deleting someone's file is not a thing a deploy script should decide.
set -euo pipefail

FILE="${1:?usage: push-project-key.sh <key-file> <ssh-host> [port] [remote-dir]}"
HOST="${2:?ssh host}"
PORT="${3:-22}"
DIR="${4:-superatom-engine}"
KEYF="${SSH_KEY:-$HOME/.ssh/superatom_vm}"

[ -f "$FILE" ] || { echo "✗ no key file at $FILE"; exit 1; }
# EITHER a bare key OR the block the admin UI copies (ICA_PROJECT=… / ICA_KEY=…). The Copy button hands over
# both lines, so demanding a bare key means every real use of this script fails on the first try — and the
# person then edits a file containing a live credential to satisfy a validator, which is worse than accepting
# the format they were actually given.
if grep -q '^ICA_KEY=' "$FILE"; then
  KEY="$(grep '^ICA_KEY=' "$FILE" | head -1 | cut -d= -f2- | tr -d ' \t\r\n')"
else
  KEY="$(tr -d ' \t\r\n' < "$FILE")"
fi
[ -n "$KEY" ] || { echo "✗ the key file is empty"; exit 1; }
# Shape only. Never the value — an error message is a place credentials leak, and "it did not look right" is
# all anyone needs to know.
case "$KEY" in sk-proj-*) ;; *) echo "✗ that file does not contain a project key (expected sk-proj-…)"; exit 1;; esac
echo "→ read a ${#KEY}-character key from $FILE (not shown)"

SSH="ssh -i $KEYF -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -p $PORT"

# stdin, not an argument: an argument is visible in `ps` on the remote box for as long as the command runs.
printf '%s' "$KEY" | $SSH "$HOST" "cat > /tmp/.ica-key && chmod 600 /tmp/.ica-key" 
$SSH "$HOST" "set -e
  cd \$HOME/$DIR
  cp .env .env.before-rotation
  K=\$(cat /tmp/.ica-key); rm -f /tmp/.ica-key
  if grep -q '^ICA_KEY=' .env; then
    awk -v k=\"\$K\" '/^ICA_KEY=/ { print \"ICA_KEY=\" k; next } { print }' .env > .env.tmp && mv .env.tmp .env
  else
    printf '\nICA_KEY=%s\n' \"\$K\" >> .env
  fi
  chmod 600 .env
  echo '→ .env updated on the box (previous kept at .env.before-rotation)'
  docker compose up -d >/dev/null 2>&1
  echo '→ engine restarting'"

echo "→ waiting for the engine to prove the new key against the hub"
for i in $(seq 1 24); do
  sleep 5
  OUT=$($SSH "$HOST" "cd \$HOME/$DIR && docker compose logs --since 3m 2>/dev/null | grep -cE 'ENGINE FULLY READY|ENGINE READY' || true")
  BAD=$($SSH "$HOST" "cd \$HOME/$DIR && docker compose logs --since 3m 2>/dev/null | grep -cE 'Invalid API key|4001' || true")
  if [ "${BAD:-0}" -gt 0 ]; then
    echo "✗ the hub REJECTED the new key. The old one still works — roll back with:"
    echo "   $SSH $HOST 'cd \$HOME/$DIR && cp .env.before-rotation .env && docker compose up -d'"
    exit 1
  fi
  if [ "${OUT:-0}" -gt 0 ]; then
    echo "✓ the engine is connected on the new key."
    echo "  Now press Finish in the admin UI to retire the old key, then delete $FILE."
    exit 0
  fi
done
echo "? no ready banner within two minutes — check: $SSH $HOST 'cd \$HOME/$DIR && docker compose logs --tail 40'"
exit 1
