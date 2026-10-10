#!/usr/bin/env bash
# Put an image into our registry, which is nothing but files in an R2 bucket laid out the way `docker pull` reads them:
#
#   v2/                                      any answer at all: "this is a registry"
#   v2/<name>/blobs/sha256:<hex>             each layer and the config, by its digest (written once, never changed)
#   v2/<name>/manifests/sha256:<hex>         the image's manifest, by its digest — what boxes pull
#   v2/<name>/manifests/<tag>                the same manifest under each name given: its own, which never moves
#                                            (dev-20261010-1a2b3c4d), and a channel that does (dev; prod is set by
#                                            promoting a tested image — the same bytes, never a rebuild)
#
# The bucket's custom domain (registry.superatom.ai) serves these as they are: no registry server, nothing running.
# Layers already there are skipped, so a release uploads only what changed — usually our code, a few MB.
#
# SAFE TO FAIL HALFWAY, SAFE TO RUN AGAIN. Blobs go first and the manifests last, so until the very end nothing names
# the new image and a box can only ever pull a complete one. Each upload is retried; afterwards every file is read back
# THROUGH THE PUBLIC ADDRESS and checked (each blob's size, the manifest's digest), so "published" means "pullable".
# A failure says what failed and what to do (docs/deploying-the-engine.md has the full list).
#
#   scripts/registry-push.sh <image.oci.tar> <name> <tag> [<tag>…]
#
# Needs the AWS CLI, curl and python3, and in the environment: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (an R2 key for
# this bucket only), R2_ENDPOINT (https://<account>.r2.cloudflarestorage.com), R2_BUCKET; REGISTRY_URL (default
# https://registry.superatom.ai). Prints the manifest's digest last.
set -euo pipefail

OCI="${1:?usage: registry-push.sh <image.oci.tar> <name> <tag> [<tag>…]}"; NAME="${2:?name}"; shift 2; TAGS=("${@:?a tag}")
REGISTRY_URL="${REGISTRY_URL:-https://registry.superatom.ai}"
fail() { echo "✗ $1" >&2; echo "  → $2" >&2; exit 1; }
[[ -f $OCI ]] || fail "no image file at $OCI" "the build step did not produce it — read the build step's log above"
[[ -n ${R2_ENDPOINT:-} && -n ${R2_BUCKET:-} ]] || fail "R2_ENDPOINT or R2_BUCKET is not set" "set them as variables of the 'registry' environment (GitHub → Settings → Environments → registry)"
[[ -n ${AWS_ACCESS_KEY_ID:-} && -n ${AWS_SECRET_ACCESS_KEY:-} ]] || fail "the R2 key is not set" "set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY as secrets of the 'registry' environment (gh secret set … --env registry)"
command -v aws >/dev/null || fail "the AWS CLI is not installed" "GitHub's runners have it; elsewhere install it (it is only an S3 client for R2)"
export AWS_MAX_ATTEMPTS=8 AWS_RETRY_MODE=adaptive
s3() { aws --endpoint-url "$R2_ENDPOINT" --region auto "$@"; }

# The key works and reaches this bucket — before anything is uploaded, so a bad key fails here, plainly.
s3 s3api head-bucket --bucket "$R2_BUCKET" >/dev/null 2>&1 \
  || fail "the R2 key cannot reach bucket $R2_BUCKET at $R2_ENDPOINT" "check the key is an R2 token with Object Read & Write on this bucket and has not been revoked (Cloudflare → R2 → Manage API tokens); update the two secrets"

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
tar -xf "$OCI" -C "$work" || fail "$OCI is not a readable image archive" "rebuild; the build step's output was cut short"
manifest="$(python3 -c 'import json,sys; m=json.load(open(sys.argv[1]))["manifests"]; assert len(m)==1, f"{len(m)} manifests"; print(m[0]["digest"])' "$work/index.json")" \
  || fail "the image archive does not hold exactly one manifest" "build for one platform with provenance off (the workflow does); an attestation adds a second"
mfile="$work/blobs/sha256/${manifest#sha256:}"
mtype="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("mediaType","application/vnd.oci.image.manifest.v1+json"))' "$mfile")"
# What the manifest names, with sizes — the list checked at the end.
python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); [print(x["digest"], x["size"]) for x in [m["config"], *m["layers"]]]' "$mfile" > "$work/named.txt"

new=0; kept=0; bytes=0
while read -r d size; do
  f="$work/blobs/sha256/${d#sha256:}"; key="v2/$NAME/blobs/$d"
  [[ -f $f ]] || fail "the manifest names $d but the archive does not hold it" "rebuild the image"
  have="$(s3 s3api head-object --bucket "$R2_BUCKET" --key "$key" --query ContentLength --output text 2>/dev/null || true)"
  if [[ $have == "$size" ]]; then kept=$((kept + 1)); continue; fi
  s3 s3 cp --only-show-errors --content-type application/octet-stream "$f" "s3://$R2_BUCKET/$key" \
    || fail "uploading $d ($((size / 1048576)) MB) failed after retries" "run the workflow again (Actions → engine → Re-run failed jobs): what is already up is kept"
  new=$((new + 1)); bytes=$((bytes + size))
done < "$work/named.txt"
for ref in "$manifest" "${TAGS[@]}"; do
  s3 s3 cp --only-show-errors --content-type "$mtype" "$mfile" "s3://$R2_BUCKET/v2/$NAME/manifests/$ref" \
    || fail "writing the manifest as $ref failed" "run again; the layers are already up, only the manifests are rewritten"
done
printf '{}' | s3 s3 cp --only-show-errors --content-type application/json - "s3://$R2_BUCKET/v2/" || true
echo "uploaded $new new blobs ($((bytes / 1048576)) MB), $kept already there; $NAME: ${TAGS[*]}" >&2

# ── READ IT BACK through the public address, as a box will ─────────────────────────────────────────────────────
code="$(curl -s -o /dev/null -w '%{http_code}' "$REGISTRY_URL/v2/")"
[[ $code == 200 ]] || fail "$REGISTRY_URL/v2/ answers $code" "the bucket's custom domain is not serving it: Cloudflare → R2 → superatom-registry → Settings → Custom domains"
for ref in "$manifest" "${TAGS[@]}"; do
  got="sha256:$(curl -fsS "$REGISTRY_URL/v2/$NAME/manifests/$ref" | sha256sum | cut -d' ' -f1)" \
    || fail "$REGISTRY_URL cannot serve the manifest $ref" "run again; if it persists, check the custom domain and that the object exists in the bucket"
  [[ $got == "$manifest" ]] || fail "$REGISTRY_URL serves a different manifest for $ref ($got)" "a cache in front of the domain is stale — purge it for registry.superatom.ai, then run again"
done
while read -r d size; do
  len="$(curl -fsSI "$REGISTRY_URL/v2/$NAME/blobs/$d" | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}')"
  [[ $len == "$size" ]] || fail "$REGISTRY_URL serves $d with size '${len:-none}', expected $size" "run again (the upload is re-done for a blob whose size is wrong)"
done < "$work/named.txt"
echo "verified through $REGISTRY_URL: the manifest and its $(wc -l < "$work/named.txt" | tr -d ' ') blobs" >&2
echo "$manifest"
