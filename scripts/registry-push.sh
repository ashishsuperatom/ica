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
#   scripts/registry-push.sh <image.oci.tar> <name> <tag> [<tag>…]
#
# Needs the AWS CLI and, in the environment: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (an R2 key for this bucket only),
# R2_ENDPOINT (https://<account>.r2.cloudflarestorage.com) and R2_BUCKET. Prints the manifest's digest last.
set -euo pipefail

OCI="${1:?image.oci.tar}"; NAME="${2:?name}"; shift 2; TAGS=("${@:?a tag}")
: "${R2_ENDPOINT:?}" "${R2_BUCKET:?}"
s3() { aws --endpoint-url "$R2_ENDPOINT" --region auto "$@"; }
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
tar -xf "$OCI" -C "$work"

# The image's manifest: the one index.json names (built for one platform, without attestations: one manifest).
manifest="$(python3 -c 'import json,sys; m=json.load(open(sys.argv[1]))["manifests"]; assert len(m)==1, m; print(m[0]["digest"])' "$work/index.json")"
mtype="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("mediaType","application/vnd.oci.image.manifest.v1+json"))' "$work/blobs/sha256/${manifest#sha256:}")"

new=0; kept=0; bytes=0
for f in "$work"/blobs/sha256/*; do
  d="sha256:$(basename "$f")"; [[ $d == "$manifest" ]] && continue
  key="v2/$NAME/blobs/$d"
  if s3 s3api head-object --bucket "$R2_BUCKET" --key "$key" >/dev/null 2>&1; then kept=$((kept + 1)); continue; fi
  s3 s3 cp --only-show-errors --content-type application/octet-stream "$f" "s3://$R2_BUCKET/$key"
  new=$((new + 1)); bytes=$((bytes + $(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")))
done
for ref in "$manifest" "${TAGS[@]}"; do
  s3 s3 cp --only-show-errors --content-type "$mtype" "$work/blobs/sha256/${manifest#sha256:}" "s3://$R2_BUCKET/v2/$NAME/manifests/$ref"
done
printf '{}' | s3 s3 cp --only-show-errors --content-type application/json - "s3://$R2_BUCKET/v2/"
echo "uploaded $new new blobs ($((bytes / 1048576)) MB), $kept already there; $NAME: ${TAGS[*]}" >&2
echo "$manifest"
