#!/usr/bin/env bash
# One-shot Docker deploy on any Linux host. Builds the image, runs it with a persistent volume.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker isn't installed. Install it (https://docs.docker.com/engine/install/ubuntu/), then re-run."
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env — fill in ICA_PROJECT / ICA_KEY / ICA_HUB, then re-run ./deploy.sh"
  exit 0
fi

echo "[deploy] building + starting…"
docker compose up -d --build

cat <<EOF

[deploy] Up. The engine connects OUT to the hub (no inbound ports).
  Auth the coding agent once:   docker compose exec engine claude login   (unless you set a token in .env)
  Watch it:                     docker compose logs -f engine   (look for "ENGINE FULLY READY")
  Stop, keep data:              docker compose down
  Stop and WIPE all data:       docker compose down -v
EOF
