#!/bin/sh
# Install sacli, the Superatom CLI — or move to another version of it. Served at get.superatom.site/sacli/install.sh,
# published with each version of sacli (docs/releases.md).
#
#   curl -fsSL https://get.superatom.site/sacli/install.sh | sh                 the latest version
#   curl -fsSL https://get.superatom.site/sacli/install.sh | sh -s -- 0.2.0     a given version (or a channel)
#
# Each version is kept in ~/.superatom/sacli/<version>/ and `current` points at the one in use, so moving between
# versions is one step and the previous one stays. The command is a small launcher in ~/.local/bin. Running this again
# upgrades; `sacli upgrade` does the same from sacli itself.
#
#   SACLI_HOME     where versions are kept (default ~/.superatom/sacli)
#   SACLI_BIN_DIR  where the `sacli` command goes (default ~/.local/bin)
#   SACLI_GET      where releases come from (default https://get.superatom.site)
set -eu

REF="${1:-latest}"
GET="${SACLI_GET:-https://get.superatom.site}"
HOME_DIR="${SACLI_HOME:-$HOME/.superatom/sacli}"
BIN_DIR="${SACLI_BIN_DIR:-$HOME/.local/bin}"

fail() { printf '✗ %s\n  → %s\n' "$1" "$2" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "sacli needs Node.js 22 or newer, and node is not installed" "install it from https://nodejs.org (or your package manager), then run this again"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || fail "sacli needs Node.js 22 or newer; this machine has $(node --version)" "upgrade Node (https://nodejs.org), then run this again"
command -v curl >/dev/null 2>&1 || fail "curl is not installed" "install curl, then run this again"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$GET/sacli/$REF" -o "$tmp/manifest.json" \
  || fail "$GET has no sacli \"$REF\"" "the versions there are: $GET/sacli"
# What the version is and what sacli.mjs must hash to — read with node, which sacli needs anyway.
set -- $(node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  const f = (m.files || []).find((x) => x.name === "sacli.mjs")
  if (!m.version || !f) process.exit(1)
  console.log(m.version, f.sha256)' "$tmp/manifest.json") \
  || fail "the release $REF does not describe sacli.mjs" "this is a broken release; try a given version: sh -s -- <version> (see $GET/sacli)"
VERSION="$1"; WANT="$2"

curl -fsSL "$GET/sacli/$VERSION/sacli.mjs" -o "$tmp/sacli.mjs" || fail "downloading sacli $VERSION failed" "run this again; if it persists, check you can reach $GET"
GOT="$(node -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$tmp/sacli.mjs")"
[ "$GOT" = "$WANT" ] || fail "the download of sacli $VERSION is not what was published (sha256 differs)" "run this again; if it persists, something between you and $GET changes files — tell us"

mkdir -p "$HOME_DIR/$VERSION" "$BIN_DIR"
mv "$tmp/sacli.mjs" "$HOME_DIR/$VERSION/sacli.mjs"
chmod 755 "$HOME_DIR/$VERSION/sacli.mjs"
ln -sfn "$VERSION" "$HOME_DIR/current"
printf '#!/bin/sh\n# sacli launcher (get.superatom.site/sacli/install.sh): runs the version ~/.superatom/sacli/current points at.\nexec node "%s/current/sacli.mjs" "$@"\n' "$HOME_DIR" > "$BIN_DIR/sacli"
chmod 755 "$BIN_DIR/sacli"
# A background connection started by the previous version is closed, so the next command runs this one.
node "$HOME_DIR/current/sacli.mjs" disconnect --all >/dev/null 2>&1 || true

echo "sacli $VERSION installed ($HOME_DIR/$VERSION)."
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo ""; echo "$BIN_DIR is not on your PATH. Add it, e.g.:"; echo "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc   # or ~/.bashrc"; echo "then open a new terminal." ;;
esac
found="$(command -v sacli 2>/dev/null || true)"
if [ -n "$found" ] && [ "$found" != "$BIN_DIR/sacli" ]; then
  echo ""; echo "Note: another sacli comes first on your PATH ($found); remove it or put $BIN_DIR before it."
fi
echo ""
echo "Next — save your agent key (it is never shown on screen):"
echo "  printf %s \"\$KEY\" | sacli login        # or on a Mac: pbpaste | sacli login"
