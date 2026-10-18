#!/usr/bin/env bash
# An engine release, copied into Fly's registry: registry.fly.io/superatom-engine — the same bytes, the same digest.
#
#   FLY_TOKEN=… scripts/registry-to-fly.sh <tag> [<digest>]
#
# Fly machines cannot sign in to another registry, so the projects that run on Fly pull the engine from Fly's own. Only
# what Fly does not hold yet is sent (a code-only release is about a megabyte). Run by the engine workflow after every
# release, and on demand (Actions → engine → Run workflow with copy_to_fly) for an older one — Fly may drop an image no machine has used lately.
set -euo pipefail
tag="${1:?usage: registry-to-fly.sh <tag> [<digest>]}"; digest="${2:-}"
: "${FLY_TOKEN:?FLY_TOKEN (the FLY_REGISTRY_TOKEN secret) is not set}"
fail() { printf '✗ %s\n  → %s\n' "$1" "$2" >&2; exit 1; }
command -v skopeo >/dev/null || { sudo apt-get update -q >/dev/null && sudo apt-get install -yq skopeo >/dev/null; }
if [ -z "$digest" ]; then
  digest="sha256:$(curl -fsS -H 'accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' "https://registry.superatom.ai/v2/superatom-engine/manifests/$tag" | sha256sum | cut -c1-64)" \
    || fail "registry.superatom.ai has no release $tag" "see the releases: curl -s https://get.superatom.site/engine"
fi
for i in 1 2 3; do
  skopeo copy -q --retry-times 3 --preserve-digests --dest-username x --dest-password "$FLY_TOKEN" \
    "docker://registry.superatom.ai/superatom-engine@$digest" "docker://registry.fly.io/superatom-engine:$tag" && break
  [ "$i" = 3 ] && fail "$tag could not be copied to registry.fly.io" "re-run; if the token was refused, make a new one (docs/deploying-the-engine.md, 'Fly')"
  sleep 20
done
got="sha256:$(skopeo inspect --raw --creds "x:$FLY_TOKEN" "docker://registry.fly.io/superatom-engine@$digest" | sha256sum | cut -c1-64)"
[ "$got" = "$digest" ] || fail "registry.fly.io holds other bytes for $tag" "re-run this; it copies by digest"
echo "registry.fly.io/superatom-engine@$digest ($tag)"
