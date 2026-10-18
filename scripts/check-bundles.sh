#!/usr/bin/env bash
# Every built screen script must parse as a module before it is uploaded: a bundle the browser refuses is a white page
# that typechecks and tests do not see (the bundler can produce one from valid source).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bad=0
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT   # a folder of our own (mktemp -d is the same on macOS and Linux)
for f in $(find "$ROOT/control-plane/superadmin/dist/client" -path '*/assets/*.js'); do
  tmp="$work/bundle.mjs"; cp "$f" "$tmp"
  if ! node --check "$tmp" 2> "$work/err"; then echo "✗ ${f#$ROOT/} does not parse: $(grep -m1 -E 'Error' "$work/err")"; bad=1; fi
done
[ $bad = 0 ] && echo "✓ every screen script parses"
exit $bad
