#!/usr/bin/env bash
# Publish a version of a product — sacli, and anything else we ship as files — into the registry bucket, served at
# get.superatom.site (docs/releases.md). Every product is laid out the same way:
#
#   releases/<product>/<version>/<file>          each file of the version; written once, never changed
#   releases/<product>/<version>/manifest.json   what the version holds: each file's name, size and sha256, the commit
#   releases/<product>/channels/<channel>.json   which version a channel names (latest, beta…); the only thing that moves
#
# A version that is already there is refused, never overwritten: a new release needs a new version.
#
# SAFE TO FAIL HALFWAY, SAFE TO RUN AGAIN. The files go first, the manifest after them, the channel last — until the
# manifest is written the version does not exist, and until the channel moves no installer takes it. Every file is read
# back THROUGH THE PUBLIC ADDRESS and its sha256 checked, so "published" means "downloadable".
#
#   scripts/release.sh <product> <version> [--channel <name>] [--commit <sha>] <file> [<file>…]
#   scripts/release.sh <product> --check <version>     exit 0 when that version is already published, 1 when not
#   scripts/release.sh <product> --move <channel> <version>   point a channel at a published version (also a rollback)
#
# Needs the AWS CLI, curl and python3, and in the environment: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (an R2 key for
# this bucket only), R2_ENDPOINT (https://<account>.r2.cloudflarestorage.com), R2_BUCKET; GET_URL (default
# https://get.superatom.site).
set -euo pipefail

fail() { echo "✗ $1" >&2; echo "  → $2" >&2; exit 1; }
PRODUCT="${1:?usage: release.sh <product> <version> [--channel <name>] [--commit <sha>] <file>…}"; shift
GET_URL="${GET_URL:-https://get.superatom.site}"
NAME='^[a-z0-9][a-z0-9._-]{0,63}$'
[[ $PRODUCT =~ $NAME ]] || fail "\"$PRODUCT\" is not a product name" "lower-case letters, digits, dots, dashes"


[[ -n ${R2_ENDPOINT:-} && -n ${R2_BUCKET:-} ]] || fail "R2_ENDPOINT or R2_BUCKET is not set" "set them as variables of the 'registry' environment (GitHub → Settings → Environments → registry)"
[[ -n ${AWS_ACCESS_KEY_ID:-} && -n ${AWS_SECRET_ACCESS_KEY:-} ]] || fail "the R2 key is not set" "set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY as secrets of the 'registry' environment"
command -v aws >/dev/null || fail "the AWS CLI is not installed" "GitHub's runners have it; elsewhere install it (it is only an S3 client for R2)"
export AWS_MAX_ATTEMPTS=8 AWS_RETRY_MODE=adaptive
s3() { aws --endpoint-url "$R2_ENDPOINT" --region auto "$@"; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
size() { wc -c < "$1" | tr -d ' '; }
type_of() { case $1 in *.sh) echo 'text/x-shellscript; charset=utf-8';; *.mjs|*.js) echo 'text/javascript; charset=utf-8';; *.json) echo application/json;; *.md) echo 'text/markdown; charset=utf-8';; *) echo application/octet-stream;; esac; }

s3 s3api head-bucket --bucket "$R2_BUCKET" >/dev/null 2>&1 \
  || fail "the R2 key cannot reach bucket $R2_BUCKET at $R2_ENDPOINT" "check the key is an R2 token with Object Read & Write on this bucket and has not been revoked; update the two secrets"
# A channel names a published version: written last, read back (it is cached for up to a minute in front).
move() {
  local ch="$1" v="$2" got
  [[ $ch =~ ^[a-z]{1,20}$ ]] || fail "\"$ch\" is not a channel name" "lower-case letters only (latest, beta)"
  s3 s3api head-object --bucket "$R2_BUCKET" --key "releases/$PRODUCT/$v/manifest.json" >/dev/null 2>&1 \
    || fail "$PRODUCT $v is not published" "a channel can only name a published version: see $GET_URL/$PRODUCT"
  printf '{"product":"%s","channel":"%s","version":"%s","at":"%s"}\n' "$PRODUCT" "$ch" "$v" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    | s3 s3 cp --only-show-errors --content-type application/json - "s3://$R2_BUCKET/releases/$PRODUCT/channels/$ch.json" \
    || fail "moving $ch to $v failed" "the version is published; move the channel alone: scripts/release.sh $PRODUCT --move $ch $v"
  got="$(curl -fsS "$GET_URL/$PRODUCT/$ch" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])' 2>/dev/null || true)"
  [[ $got == "$v" ]] || echo "note: $GET_URL/$PRODUCT/$ch still says ${got:-nothing}; it is cached for up to a minute" >&2
  echo "$PRODUCT $ch → $v" >&2
}
if [[ ${1:-} == --check ]]; then
  s3 s3api head-object --bucket "$R2_BUCKET" --key "releases/$PRODUCT/${2:?a version}/manifest.json" >/dev/null 2>&1 && exit 0 || exit 1
fi
if [[ ${1:-} == --move ]]; then move "${2:?a channel}" "${3:?a version}"; exit 0; fi

VERSION="${1:?a version}"; shift
[[ $VERSION =~ $NAME && ! $VERSION =~ ^[a-z]+$ && $VERSION != install.sh ]] || fail "\"$VERSION\" is not a version name" "lower-case letters, digits, dots, dashes (0.2.0, dev-20261013-1a2b3c4d) — a name of letters only is a channel's"
CHANNEL=""; COMMIT="$(git rev-parse HEAD 2>/dev/null || true)"; FILES=()
while (($#)); do
  case $1 in
    --channel) CHANNEL="${2:?a channel name}"; shift 2 ;;
    --commit) COMMIT="${2:?a commit}"; shift 2 ;;
    *) FILES+=("$1"); shift ;;
  esac
done
((${#FILES[@]})) || fail "no files to publish" "name each file of the version after the version"
[[ -z $CHANNEL || $CHANNEL =~ ^[a-z]{1,20}$ ]] || fail "\"$CHANNEL\" is not a channel name" "lower-case letters only (latest, beta)"
for f in "${FILES[@]}"; do
  [[ -f $f ]] || fail "no file at $f" "build first"
  b="$(basename "$f")"; [[ $b =~ $NAME && $b != manifest.json ]] || fail "\"$b\" cannot be a file's name here" "lower-case letters, digits, dots, dashes; manifest.json is the release's own"
done
# The public address serves releases — before anything is uploaded, so a version is never published unreadable.
curl -fsS "$GET_URL/" 2>/dev/null | python3 -c 'import json,sys; assert "products" in json.load(sys.stdin)' 2>/dev/null \
  || fail "$GET_URL does not serve releases" "deploy the platform first (scripts/deploy-control-plane.sh — src/releases.ts), then run again"
base="releases/$PRODUCT/$VERSION"
if s3 s3api head-object --bucket "$R2_BUCKET" --key "$base/manifest.json" >/dev/null 2>&1; then
  fail "$PRODUCT $VERSION is already published" "a version never changes: raise the version and release again"
fi

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
for f in "${FILES[@]}"; do
  s3 s3 cp --only-show-errors --content-type "$(type_of "$f")" "$f" "s3://$R2_BUCKET/$base/$(basename "$f")" \
    || fail "uploading $(basename "$f") failed after retries" "run again: nothing names the version until its manifest is written"
  printf '%s\t%s\t%s\n' "$(basename "$f")" "$(size "$f")" "$(sha "$f")" >> "$work/files.tsv"
done
python3 - "$PRODUCT" "$VERSION" "$COMMIT" "$work/files.tsv" > "$work/manifest.json" <<'PY'
import json, sys, datetime
product, version, commit, tsv = sys.argv[1:]
files = [dict(zip(('name', 'size', 'sha256'), l.rstrip('\n').split('\t'))) for l in open(tsv)]
for f in files: f['size'] = int(f['size'])
print(json.dumps({'product': product, 'version': version, **({'commit': commit} if commit else {}),
  'at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'files': files}, indent=2))
PY
s3 s3 cp --only-show-errors --content-type application/json "$work/manifest.json" "s3://$R2_BUCKET/$base/manifest.json" \
  || fail "writing the manifest failed" "run again (the version is not visible until this succeeds)"
echo "published $PRODUCT $VERSION: $(cut -f1 "$work/files.tsv" | tr '\n' ' ')" >&2

# ── READ IT BACK through the public address, as an installer will ──────────────────────────────────────────────
while IFS=$'\t' read -r name _ want; do
  curl -fsS -o "$work/got" "$GET_URL/$PRODUCT/$VERSION/$name" \
    || fail "$GET_URL cannot serve $PRODUCT/$VERSION/$name" "check the platform is deployed (src/releases.ts) and bound to the bucket; then run with --channel only after it serves"
  [[ $(sha "$work/got") == "$want" ]] || fail "$GET_URL serves a different $name than was uploaded" "a cache in front is stale or the upload was cut short — run again"
done < "$work/files.tsv"
echo "verified through $GET_URL: $(wc -l < "$work/files.tsv" | tr -d ' ') files" >&2

[[ -n $CHANNEL ]] && move "$CHANNEL" "$VERSION"
echo "$VERSION"
