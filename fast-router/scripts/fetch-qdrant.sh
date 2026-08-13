#!/usr/bin/env bash
# Download the Qdrant binary for THIS machine's OS/arch into ./.qdrant/qdrant.
# Portable: macOS (arm64/x64) for local dev, Linux (x64/arm64) for the EC2 box. No Docker needed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HERE/.qdrant"
mkdir -p "$DEST"

os="$(uname -s)"; arch="$(uname -m)"
case "$os/$arch" in
  Darwin/arm64)        asset="qdrant-aarch64-apple-darwin.tar.gz" ;;
  Darwin/x86_64)       asset="qdrant-x86_64-apple-darwin.tar.gz" ;;
  Linux/x86_64)        asset="qdrant-x86_64-unknown-linux-gnu.tar.gz" ;;
  Linux/aarch64)       asset="qdrant-aarch64-unknown-linux-musl.tar.gz" ;;
  Linux/arm64)         asset="qdrant-aarch64-unknown-linux-musl.tar.gz" ;;
  *) echo "unsupported platform: $os/$arch" >&2; exit 1 ;;
esac

url="$(curl -s https://api.github.com/repos/qdrant/qdrant/releases/latest \
  | grep -oE "\"browser_download_url\": *\"[^\"]*${asset}\"" | head -1 | sed -E 's/.*"(https[^"]+)".*/\1/')"
[ -n "$url" ] || { echo "no release asset for $asset" >&2; exit 1; }

echo "[fetch-qdrant] $os/$arch → $asset"
curl -sL "$url" -o "$DEST/qdrant.tar.gz"
tar xzf "$DEST/qdrant.tar.gz" -C "$DEST"
rm -f "$DEST/qdrant.tar.gz"
chmod +x "$DEST/qdrant"
[ "$os" = "Darwin" ] && xattr -c "$DEST/qdrant" 2>/dev/null || true
echo "[fetch-qdrant] ready: $DEST/qdrant ($("$DEST/qdrant" --version 2>/dev/null | head -1))"
