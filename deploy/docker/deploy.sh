#!/usr/bin/env bash
# One-command Docker deploy on any Linux host. Installs Docker if missing, builds the image locally
# (no registry / no docker push), and runs it with a persistent volume. Just: unzip, fill .env, ./deploy.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"

# 1. Docker — install it if it isn't here (official convenience script; Ubuntu/Debian/most distros).
if ! command -v docker >/dev/null 2>&1; then
  echo "[deploy] Docker not found — installing (get.docker.com)…"
  curl -fsSL https://get.docker.com | sh
fi

# Can we talk to the daemon without sudo? If not, prefix docker with sudo.
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1; then DOCKER="sudo docker"
  else echo "[deploy] Can't reach the Docker daemon — run as root or add your user to the docker group."; exit 1; fi
fi
if ! $DOCKER compose version >/dev/null 2>&1; then
  echo "[deploy] The 'docker compose' plugin is missing — installing it…"
  SUDO=""; [ "$DOCKER" = "sudo docker" ] && SUDO="sudo"
  # Try the distro package first (works when Docker's official repo is present)…
  if command -v apt-get >/dev/null 2>&1;   then $SUDO apt-get update >/dev/null 2>&1 && $SUDO apt-get install -y docker-compose-plugin >/dev/null 2>&1 || true
  elif command -v dnf >/dev/null 2>&1;     then $SUDO dnf install -y docker-compose-plugin >/dev/null 2>&1 || true
  elif command -v yum >/dev/null 2>&1;     then $SUDO yum install -y docker-compose-plugin >/dev/null 2>&1 || true
  fi
  # …otherwise (Docker from docker.io/snap, no official repo) drop the v2 plugin binary in directly. Distro-agnostic.
  if ! $DOCKER compose version >/dev/null 2>&1; then
    DEST=/usr/local/lib/docker/cli-plugins; $SUDO mkdir -p "$DEST"
    $SUDO curl -fSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" -o "$DEST/docker-compose"
    $SUDO chmod +x "$DEST/docker-compose"
  fi
  $DOCKER compose version >/dev/null 2>&1 || { echo "[deploy] compose plugin still missing after install — install it manually, then re-run."; exit 1; }
fi

# 2. .env — created on first run; you fill it, then re-run.
if [ ! -f .env ]; then
  cp .env.example .env
  echo "[deploy] Created .env — fill in ICA_PROJECT / ICA_KEY / ICA_HUB, then re-run:  ./deploy.sh"
  exit 0
fi

# 3. build the image locally + start it (persistent volume, restarts on reboot)
echo "[deploy] building + starting…"
$DOCKER compose up -d --build

cat <<EOF

[deploy] Up. The engine connects OUT to the hub (no inbound ports).
  Auth the coding agent once:   $DOCKER compose exec engine claude login   (unless CLAUDE_CODE_OAUTH_TOKEN is in .env)
  Watch it:                     $DOCKER compose logs -f engine   (look for "ENGINE FULLY READY")
  Stop, keep data:              $DOCKER compose down
  Stop and WIPE all data:       $DOCKER compose down -v
EOF
