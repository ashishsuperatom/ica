#!/usr/bin/env bash
# THE FALLBACK: release the engine without GitHub Actions — when Actions is down or slow and a release cannot wait. The
# same steps as .github/workflows/engine.yml, the same scripts: every check, a build on a LINUX x86_64 Docker host (never
# this Mac — the image must be built where it runs), scripts/registry-push.sh, and the same pull-back test.
#
#   DOCKER_HOST=ssh://<linux box> \
#   AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… \
#   scripts/release-engine-local.sh
#
# LAST RESORT, on this Mac: ALLOW_EMULATED_BUILD=1 builds the x86_64 image under emulation (Docker Desktop, with Rosetta
# turned on in its settings). It works, but it is slow (native modules compile emulated: 10–30 min), can crash, and is the
# build least likely to match GitHub's bytes — so it is never chosen by accident, and the run says so.
#
# The R2 key is the same kind the workflow holds (Object Read & Write on superatom-registry only), typed in for this run,
# never saved. The release must be a commit that is on the dev branch on GitHub, so what was released can be found.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
fail() { echo "✗ $1" >&2; echo "  → $2" >&2; exit 1; }
export R2_ENDPOINT="${R2_ENDPOINT:-https://91e1058d99235b9c34602fb0c28916d3.r2.cloudflarestorage.com}" R2_BUCKET="${R2_BUCKET:-superatom-registry}"

[[ -n ${DOCKER_HOST:-} || ${ALLOW_EMULATED_BUILD:-} == 1 ]] || fail "DOCKER_HOST is not set" "point it at a Linux x86_64 machine with Docker: DOCKER_HOST=ssh://<host> (on this Mac only as a last resort: ALLOW_EMULATED_BUILD=1)"
arch="$(docker info --format '{{.Architecture}}' 2>/dev/null)" || fail "cannot reach Docker at ${DOCKER_HOST:-this machine}" "check ssh to that host works and Docker runs there (on the Mac: start Docker Desktop)"
if [[ $arch != x86_64 ]]; then
  [[ ${ALLOW_EMULATED_BUILD:-} == 1 ]] || fail "the Docker host is $arch" "build on an x86_64 Linux host: the image is built where it runs (last resort on this Mac: ALLOW_EMULATED_BUILD=1)"
  echo "! building x86_64 under emulation on $arch — slow (10–30 min), may crash, may not match GitHub's bytes; use only when no Linux host is available" >&2
fi
git diff --quiet HEAD || fail "there are uncommitted changes" "commit them: a release is a commit"
sha="$(git rev-parse HEAD)"
git fetch -q origin dev && git merge-base --is-ancestor "$sha" origin/dev || fail "commit ${sha::8} is not on GitHub's dev branch" "git push origin HEAD:dev first"

echo "▸ every check"; scripts/check-all.sh
tag="dev-$(date -u +%Y%m%d)-${sha::8}"
echo "▸ build $tag on $DOCKER_HOST ($arch)"
docker buildx inspect sa-release >/dev/null 2>&1 || docker buildx create --name sa-release --driver docker-container >/dev/null
out="$(mktemp -d)/engine.oci.tar"
ctx="$(mktemp -d)"; git archive HEAD | tar -x -C "$ctx"
docker buildx build --builder sa-release --platform linux/amd64 --build-arg "BUILD_ID=$sha" --provenance=false --output "type=oci,dest=$out" "$ctx" \
  || fail "the build failed" "the log above says which step; see docs/deploying-the-engine.md"
echo "▸ into the registry"
digest="$(scripts/registry-push.sh "$out" superatom-engine "$tag" dev)"
echo "▸ pulled back through registry.superatom.ai"
ref="registry.superatom.ai/superatom-engine@$digest"
docker pull -q "$ref" >/dev/null || fail "the published image cannot be pulled: $ref" "see docs/deploying-the-engine.md, 'registry.superatom.ai does not serve'"
[[ "$(docker run --rm --entrypoint cat "$ref" /app/BUILD_ID)" == "$sha" ]] || fail "the image is not build $sha" "a tag was overwritten by another release; run again"
echo "✓ released $tag — $ref"
