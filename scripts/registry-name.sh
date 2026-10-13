#!/usr/bin/env bash
# Name an image already in our registry (pushed by its digest alone, scripts/registry-push.sh): first prove it is the
# build it should be — the `superatom.build` label in its config, read through the public address in a few kilobytes —
# then write its manifest under each name (its own, dev-<date>-<commit>, and a channel, dev), and read each back.
# Until this runs, nobody can choose the image: releases are listed and chosen by name.
#
#   scripts/registry-name.sh <name> <digest> <build id> <tag> [<tag>…]
set -euo pipefail
NAME="${1:?usage: registry-name.sh <name> <digest> <build id> <tag> [<tag>…]}"; DIGEST="${2:?digest}"; BUILD="${3:?build id}"; shift 3; TAGS=("${@:?a tag}")
REGISTRY_URL="${REGISTRY_URL:-https://registry.superatom.ai}"
fail() { echo "✗ $1" >&2; echo "  → $2" >&2; exit 1; }
s3() { aws --endpoint-url "$R2_ENDPOINT" --region auto "$@"; }
accept='application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'

manifest="$(curl -fsS -H "accept: $accept" "$REGISTRY_URL/v2/$NAME/manifests/$DIGEST")" \
  || fail "$REGISTRY_URL does not serve $DIGEST" "the push step did not finish — re-run the workflow"
config="$(printf '%s' "$manifest" | python3 -c 'import json,sys; print(json.load(sys.stdin)["config"]["digest"])')"
label="$(curl -fsS "$REGISTRY_URL/v2/$NAME/blobs/$config" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("config",{}).get("Labels") or {}).get("superatom.build",""))')"
[[ $label == "$BUILD" ]] || fail "$DIGEST says it is build '${label:-none}', not $BUILD" "another run pushed in between, or the label is missing — re-run this one"
mtype="$(printf '%s' "$manifest" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("mediaType","application/vnd.oci.image.manifest.v1+json"))')"

for tag in "${TAGS[@]}"; do
  s3 s3 cp --only-show-errors --metadata-directive REPLACE --content-type "$mtype" "s3://$R2_BUCKET/v2/$NAME/manifests/$DIGEST" "s3://$R2_BUCKET/v2/$NAME/manifests/$tag" \
    || fail "naming the image $tag failed" "re-run; naming is safe to repeat"
  got="sha256:$(curl -fsS -H "accept: $accept" "$REGISTRY_URL/v2/$NAME/manifests/$tag" | sha256sum | cut -d' ' -f1)"
  [[ $got == "$DIGEST" ]] || fail "$REGISTRY_URL serves another image as $tag ($got)" "a cache in front of the domain is stale — purge it, then re-run"
done
echo "named $DIGEST (build $BUILD): ${TAGS[*]}" >&2
