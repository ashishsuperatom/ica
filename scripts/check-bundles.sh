#!/usr/bin/env bash
# Every built screen script must parse as a module before it is uploaded: a bundle the browser refuses is a white page
# that typechecks and tests do not see (the bundler can produce one from valid source).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bad=0
for f in $(find "$ROOT/control-plane/superadmin/dist/client" -path '*/assets/*.js'); do
  tmp="$(mktemp -t sa-bundle).mjs"; cp "$f" "$tmp"
  if ! node --check "$tmp" 2> "$tmp.err"; then echo "✗ ${f#$ROOT/} does not parse: $(grep -m1 -E 'Error' "$tmp.err")"; bad=1; fi
  rm -f "$tmp" "$tmp.err"
done
[ $bad = 0 ] && echo "✓ every screen script parses"
exit $bad
