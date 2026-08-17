#!/usr/bin/env bash
# Zip the Teams app package for sideloading. Requires appPackage/ to contain
# manifest.json (ids filled in) + color.png (192×192) + outline.png (32×32).
set -euo pipefail
cd "$(dirname "$0")/../appPackage"

for f in manifest.json color.png outline.png; do
  [ -f "$f" ] || { echo "missing: appPackage/$f  (see appPackage/README.md)"; exit 1; }
done

out="../superatom-teams.zip"
rm -f "$out"
zip -j "$out" manifest.json color.png outline.png >/dev/null
echo "built $(cd .. && pwd)/superatom-teams.zip — upload it in Teams (Apps → Manage your apps → Upload a custom app)"
