#!/usr/bin/env bash
# Build a project's Teams app package for sideloading. A project's Teams app is the project's, so it lives in its
# home: <state>/<projectId>/clients/teams/app.json (ids, name, accent, descriptions, output filename, icon label),
# with the state root ~/.superatom/state or ENGINE_STATE_DIR. The manifest template (appPackage/manifest.json) and the
# icon maker are the platform's.
#   ./package-app.sh <projectId>
#   ./package-app.sh all           every project whose home has clients/teams/app.json
# Output: <state>/<projectId>/clients/teams/dist/<file>.zip  (manifest.json + color.png + outline.png at the root)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${ENGINE_STATE_DIR:-$HOME/.superatom/state}"
cd "$ROOT"

build_one() {
  local proj="$1"
  local dir="$STATE/$proj/clients/teams"
  [ -f "$dir/app.json" ] || { echo "no $dir/app.json"; return 1; }

  # icons: (re)generate the color+outline tiles from the project's 2-char label + accent
  local label accent; label="$(python3 -c "import json;print(json.load(open('$dir/app.json'))['icon'])")"
  accent="$(python3 -c "import json;print(json.load(open('$dir/app.json'))['accent'])")"
  python3 scripts/make-icon.py "$label" "$accent" "$dir" >/dev/null

  # manifest: substitute the template placeholders from app.json
  local file; file="$(python3 - "$dir" <<'PY'
import json, sys, os
d = sys.argv[1]
a = json.load(open(os.path.join(d, "app.json")))
tpl = open("appPackage/manifest.json").read()
m = {
  "TEAMS_APP_ID": a["teamsAppId"], "BOT_ID": a["botId"],
  "APP_NAME_SHORT": a["nameShort"], "APP_NAME_FULL": a["nameFull"],
  "ACCENT": a["accent"], "DESC_SHORT": a["descShort"], "DESC_FULL": a["descFull"],
}
for k, v in m.items():
    tpl = tpl.replace("${{%s}}" % k, v)
open(os.path.join(d, "manifest.json"), "w").write(tpl)
print(a["file"])
PY
)"

  mkdir -p "$dir/dist"
  local out="$dir/dist/$file.zip"
  rm -f "$out"
  ( cd "$dir" && zip -q -j "$out" manifest.json color.png outline.png )
  echo "built $out"
}

if [ "${1:-}" = "all" ] || [ -z "${1:-}" ]; then
  for d in "$STATE"/*/clients/teams/; do [ -f "$d/app.json" ] && build_one "$(basename "$(dirname "$(dirname "$d")")")"; done
else
  build_one "$1"
fi
