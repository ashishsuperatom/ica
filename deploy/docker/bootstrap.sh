#!/usr/bin/env bash
# One-line bootstrap for a fresh Ubuntu VM reached only through a browser console (Azure Bastion etc.),
# where multi-line copy-paste is painful. Type ONE line on the box:
#   curl -fsSL https://pub-e144ec4c086442f994a7d365dd681018.r2.dev/sa-engine-docker/bootstrap.sh | bash
# It installs Docker the proper way (get.docker.com), downloads + unzips the engine, and starts deploy.sh.
set -euo pipefail

BASE="https://pub-e144ec4c086442f994a7d365dd681018.r2.dev/sa-engine-docker"
ZIP="sa-engine-docker-0.1.0.zip"
DIR="$HOME/sa-engine-docker"

echo "[bootstrap] 1/3  Docker (official install via get.docker.com)…"
# If a distro docker.io is present, replace it — it lacks the compose v2 plugin and Docker's repo.
if dpkg -l 2>/dev/null | grep -qE '^ii\s+docker\.io'; then
  echo "[bootstrap]      removing distro docker.io…"
  sudo apt-get remove -y docker.io >/dev/null 2>&1 || true
  sudo apt-get autoremove -y >/dev/null 2>&1 || true
fi
if ! command -v docker >/dev/null 2>&1 || ! sudo docker compose version >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo usermod -aG docker "$USER" 2>/dev/null || true   # takes effect on next login; this run uses sudo

echo "[bootstrap] 2/3  download + unzip the engine…"
command -v unzip >/dev/null 2>&1 || sudo apt-get install -y unzip
mkdir -p "$DIR" && cd "$DIR"
curl -fSL "$BASE/$ZIP" -o "$ZIP"
unzip -o "$ZIP" >/dev/null

echo "[bootstrap] 3/3  handing off to deploy.sh…"
./deploy.sh   # first run writes .env and stops; fill it, then: cd ~/sa-engine-docker && ./deploy.sh

cat <<EOF

[bootstrap] Next: edit the 3 values, then deploy —
  cd ~/sa-engine-docker
  nano .env          # set ICA_PROJECT / ICA_KEY / ICA_HUB
  ./deploy.sh        # builds + starts the engine
  docker compose logs -f engine    # wait for "ENGINE FULLY READY"
EOF
