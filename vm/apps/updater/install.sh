#!/bin/sh
# Install a Superatom project's engine on this machine — once; from then on its updater keeps it on the release chosen
# in the admin console. Served at get.superatom.site/engine/install.sh (docs/deploying-the-engine.md).
#
#   curl -fsSL https://get.superatom.site/engine/install.sh | sh -s -- <project key>
#   (or SUPERATOM_KEY=<key> … | sh; or run it and paste the key when asked)
#
# Needs only curl. Docker is installed when it is missing — on Linux from get.superatom.site only, never from elsewhere,
# with or without the internet (on a Mac: Docker Desktop). The key — a key of the
# project holding project.manage — is used once, to set the engine up, and never kept on this machine. The work itself is
# done by the engine's own image (apps/updater/install.mjs): it asks the platform which release, pulls it by its digest,
# and starts the engine and its updater.
set -eu

REGISTRY="registry.superatom.ai"
# Docker's official static binaries, from our mirror (.github/workflows/docker-mirror.yml); any other file is refused.
DOCKER_VERSION="29.8.1"
DOCKER_SHA256="d8db66739d2e28d4933786d73e918d9be643a67fbd835db1bf740d650a259e70"
DOCKER_URL="https://get.superatom.site/docker/$DOCKER_VERSION/docker-$DOCKER_VERSION-x86_64.tgz"
IMAGE="$REGISTRY/superatom-engine:dev"
fail() { printf '✗ %s\n  → %s\n' "$1" "$2" >&2; exit 1; }

KEY="${1:-${SUPERATOM_KEY:-}}"
if [ -z "$KEY" ] && [ -r /dev/tty ]; then
  printf 'The project key (it is not shown, and not kept on this machine): ' >/dev/tty
  stty -echo </dev/tty 2>/dev/null || true; read -r KEY </dev/tty; stty echo </dev/tty 2>/dev/null || true; echo >/dev/tty
fi
case "$KEY" in sak_*_*) ;; *) fail "no project key" "make one in the admin console (the project → Agent keys, with project.manage), then: curl -fsSL https://get.superatom.site/engine/install.sh | sh -s -- <key>" ;; esac

# Docker: there, running, and usable by this user (sudo when it is not).
SUDO=""
if ! command -v docker >/dev/null 2>&1; then
  case "$(uname -s)" in
    Linux)
      echo "installing Docker $DOCKER_VERSION (from get.superatom.site)…"
      [ "$(id -u)" -eq 0 ] || SUDO="sudo"
      [ "$(uname -m)" = "x86_64" ] || fail "this machine is $(uname -m)" "the engine runs on x86_64 (amd64) Linux"
      command -v systemctl >/dev/null 2>&1 || fail "this machine has no systemd" "Docker is run as a systemd service: use a Linux with systemd, or install Docker yourself and run this again"
      command -v iptables >/dev/null 2>&1 || fail "iptables is missing (Docker needs it)" "install iptables (apt install iptables / dnf install iptables), then run this again"
      TMPD="$(mktemp -d)"
      curl -fsSL --retry 3 -o "$TMPD/docker.tgz" "$DOCKER_URL" || fail "could not download Docker from get.superatom.site" "allow https://get.superatom.site through the firewall or proxy, then run this again"
      echo "$DOCKER_SHA256  $TMPD/docker.tgz" | sha256sum -c --quiet - || fail "the Docker download does not match its pinned checksum" "run this again; if it repeats, tell us"
      { tar -xzf "$TMPD/docker.tgz" -C "$TMPD" && $SUDO install -m 0755 "$TMPD"/docker/* /usr/local/bin/; } || fail "Docker could not be unpacked into /usr/local/bin" "check the disk has room (df -h), then run this again"
      rm -rf "$TMPD"
      getent group docker >/dev/null 2>&1 || $SUDO groupadd --system docker
      printf '%s\n' '[Unit]' 'Description=Docker (static binaries from get.superatom.site, installed by the Superatom Engine installer)' \
        'After=network-online.target' 'Wants=network-online.target' '' '[Service]' 'Type=notify' \
        'ExecStart=/usr/local/bin/dockerd --group docker' 'ExecReload=/bin/kill -s HUP $MAINPID' 'Restart=always' 'RestartSec=2' \
        'LimitNOFILE=1048576' 'Delegate=yes' 'KillMode=process' 'TasksMax=infinity' '' '[Install]' 'WantedBy=multi-user.target' \
        | $SUDO tee /etc/systemd/system/docker.service >/dev/null
      $SUDO systemctl daemon-reload && $SUDO systemctl enable --now docker || fail "Docker did not start" "journalctl -u docker --no-pager | tail -40"
      i=0; until $SUDO docker info >/dev/null 2>&1; do i=$((i + 1)); [ $i -ge 30 ] && fail "Docker is installed but not answering" "journalctl -u docker --no-pager | tail -40"; sleep 1; done
      echo "  docker $($SUDO docker version --format '{{.Server.Version}}') running" ;;
    Darwin) fail "Docker is not installed" "install Docker Desktop (https://www.docker.com/products/docker-desktop), start it, then run this again" ;;
    *) fail "this system is not supported" "run the engine on Linux (or a Mac with Docker Desktop)" ;;
  esac
fi
if ! docker info >/dev/null 2>&1; then
  if [ "$(id -u)" -ne 0 ] && sudo -n true 2>/dev/null && sudo docker info >/dev/null 2>&1; then SUDO="sudo"
  elif [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then SUDO="sudo"
  else fail "Docker is not running (or this user may not use it)" "start Docker (sudo systemctl start docker, or Docker Desktop) — or add this user to the docker group — then run this again"; fi
fi

curl -fsS -o /dev/null "https://$REGISTRY/v2/" || fail "this machine cannot reach $REGISTRY" "allow https://$REGISTRY (and https://superatom.site) through the firewall or proxy, then run this again"

echo "fetching the installer (the engine's own image)…"
$SUDO docker pull -q "$IMAGE" >/dev/null || fail "could not pull $IMAGE" "check this machine reaches $REGISTRY, then run this again"

# The key reaches the installer through a file only this user can read — never a command line others can see — and the
# file is gone when this ends.
ENVF="$(mktemp)"; trap 'rm -f "$ENVF"' EXIT
chmod 600 "$ENVF"; printf 'SUPERATOM_KEY=%s\n' "$KEY" >"$ENVF"
[ -n "${SUPERATOM_PLATFORM:-}" ] && printf 'SUPERATOM_PLATFORM=%s\n' "$SUPERATOM_PLATFORM" >>"$ENVF"
$SUDO docker run --rm --env-file "$ENVF" -v /var/run/docker.sock:/var/run/docker.sock --entrypoint node "$IMAGE" /app/apps/updater/install.mjs
