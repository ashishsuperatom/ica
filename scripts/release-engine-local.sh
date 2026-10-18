#!/usr/bin/env bash
# THE BACKUP PATH — releases are built by GitHub (.github/workflows/engine.yml) on a push to dev; this is for when GitHub
# cannot. On a Linux x86_64 machine with Docker (the forge), the same steps with the same scripts: every check beside the build,
# scripts/registry-push.sh, the same pull-back test, the installer published — then GitHub copies the release into Fly's
# registry (the engine workflow with copy_to_fly).
#
#   scripts/release-engine-local.sh                       on a Linux x86_64 machine with Docker (the forge)
#   DOCKER_HOST=ssh://<linux box> scripts/release-engine-local.sh     from anywhere else
#
# The R2 key (Object Read & Write on superatom-registry only) is read from ~/.config/superatom/registry.env
# (AWS_ACCESS_KEY_ID=…, AWS_SECRET_ACCESS_KEY=…; only its owner can read it) unless it is in the environment already.
#
# LAST RESORT, on this Mac: ALLOW_EMULATED_BUILD=1 builds the x86_64 image under emulation (Docker Desktop, with Rosetta
# turned on in its settings). It works, but it is slow (native modules compile emulated: 10–30 min), can crash, and is the
# build least likely to match GitHub's bytes — so it is never chosen by accident, and the run says so.
#
# The release must be a commit that is on the dev branch on GitHub, so what was released can be found.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
fail() { echo "✗ $1" >&2; echo "  → $2" >&2; exit 1; }
KEYS="${SUPERATOM_REGISTRY_ENV:-$HOME/.config/superatom/registry.env}"
if [[ -z ${AWS_ACCESS_KEY_ID:-} && -f $KEYS ]]; then set -a; . "$KEYS"; set +a; fi
[[ -n ${AWS_ACCESS_KEY_ID:-} && -n ${AWS_SECRET_ACCESS_KEY:-} ]] || fail "no R2 key" "put it in $KEYS (AWS_ACCESS_KEY_ID=… and AWS_SECRET_ACCESS_KEY=…, chmod 600): a Cloudflare R2 token with Object Read & Write on superatom-registry only"
export R2_ENDPOINT="${R2_ENDPOINT:-https://91e1058d99235b9c34602fb0c28916d3.r2.cloudflarestorage.com}" R2_BUCKET="${R2_BUCKET:-superatom-registry}"

[[ -n ${DOCKER_HOST:-} || $(uname -s) == Linux || ${ALLOW_EMULATED_BUILD:-} == 1 ]] || fail "DOCKER_HOST is not set" "point it at a Linux x86_64 machine with Docker: DOCKER_HOST=ssh://<host> (on this Mac only as a last resort: ALLOW_EMULATED_BUILD=1)"
arch="$(docker info --format '{{.Architecture}}' 2>/dev/null)" || fail "cannot reach Docker at ${DOCKER_HOST:-this machine}" "check ssh to that host works and Docker runs there (on the Mac: start Docker Desktop)"
if [[ $arch != x86_64 ]]; then
  [[ ${ALLOW_EMULATED_BUILD:-} == 1 ]] || fail "the Docker host is $arch" "build on an x86_64 Linux host: the image is built where it runs (last resort on this Mac: ALLOW_EMULATED_BUILD=1)"
  echo "! building x86_64 under emulation on $arch — slow (10–30 min), may crash, may not match GitHub's bytes; use only when no Linux host is available" >&2
fi
git diff --quiet HEAD || fail "there are uncommitted changes" "commit them: a release is a commit"
sha="$(git rev-parse HEAD)"
git fetch -q origin dev && git merge-base --is-ancestor "$sha" origin/dev || fail "commit ${sha::8} is not on GitHub's dev branch" "git push origin HEAD:dev first"

tag="dev-$(date -u +%Y%m%d)-${sha::8}"
t0=$SECONDS
# Every check and the build SIDE BY SIDE, as the workflow runs them: nothing is published unless both pass.
checks_log="$(mktemp)"
echo "▸ every check (beside the build; its log: $checks_log)"
scripts/check-all.sh > "$checks_log" 2>&1 & checks=$!
echo "▸ build $tag on ${DOCKER_HOST:-this machine} ($arch)"
docker buildx inspect sa-release >/dev/null 2>&1 || docker buildx create --name sa-release --driver docker-container >/dev/null
out="$(mktemp -d)/engine.oci.tar"
ctx="$(mktemp -d)"; git archive HEAD | tar -x -C "$ctx"
if ! docker buildx build --builder sa-release --platform linux/amd64 --build-arg "BUILD_ID=$sha" --provenance=false --output "type=oci,dest=$out" "$ctx"; then
  kill $checks 2>/dev/null; fail "the build failed" "the log above says which step; see docs/deploying-the-engine.md"
fi
echo "  built in $((SECONDS - t0))s — waiting for the checks"
wait $checks || { tail -40 "$checks_log"; fail "a check failed — nothing was published" "the lines above say which; fix it, commit, push, release again"; }
echo "  checks passed ($((SECONDS - t0))s)"
echo "▸ into the registry"
digest="$(scripts/registry-push.sh "$out" superatom-engine "$tag" dev)"
echo "▸ pulled back through registry.superatom.ai"
ref="registry.superatom.ai/superatom-engine@$digest"
docker pull -q "$ref" >/dev/null || fail "the published image cannot be pulled: $ref" "see docs/deploying-the-engine.md, 'registry.superatom.ai does not serve'"
[[ "$(docker run --rm --entrypoint cat "$ref" /app/BUILD_ID)" == "$sha" ]] || fail "the image is not build $sha" "a tag was overwritten by another release; run again"
echo "▸ its installer at get.superatom.site/engine/install.sh"
scripts/release.sh engine "$tag" --channel latest --commit "$sha" vm/apps/updater/install.sh || fail "the installer was not published" "the release itself is in the registry; run: scripts/release.sh engine $tag --channel latest --commit $sha vm/apps/updater/install.sh"
echo "✓ released $tag in $((SECONDS - t0))s — $ref"
# Fly holds its own copy of each release (TG's engine runs there): copied by GitHub, which holds Fly's token.
if gh workflow run engine.yml --repo ashishsuperatom/ica --ref dev -f copy_to_fly="$tag" >/dev/null 2>&1; then echo "▸ copying it into Fly's registry on GitHub (a minute): gh run list --workflow engine.yml"
else echo "! not copied into Fly's registry — run it: gh workflow run engine.yml --ref dev -f copy_to_fly=$tag (a Fly engine cannot switch to $tag until then)" >&2; fi
