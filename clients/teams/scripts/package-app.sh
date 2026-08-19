#!/usr/bin/env bash
# Build the Teams app package(s) for sideloading — ONE per project, from apps/<project>/.
# Each apps/<project>/ has app.json (ids/name/accent/desc + output filename + icon label) and its icons are
# generated from the label. The manifest template lives in appPackage/manifest.json (placeholders).
#   ./package-app.sh <project>     e.g. ./package-app.sh fusion5
#   ./package-app.sh all           build every project under apps/
# Output: dist/<file>.zip  (files at the zip root: manifest.json + color.png + outline.png)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

build_one() {
  local proj="$1"
  local dir="apps/$proj"
  [ -f "$dir/app.json" ] || { echo "no apps/$proj/app.json"; return 1; }

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

  mkdir -p dist
  local out="dist/$file.zip"
  rm -f "$out"
  ( cd "$dir" && zip -q -j "$ROOT/$out" manifest.json color.png outline.png )
  echo "built $out"
}

if [ "${1:-}" = "all" ] || [ -z "${1:-}" ]; then
  for d in apps/*/; do build_one "$(basename "$d")"; done
else
  build_one "$1"
fi
