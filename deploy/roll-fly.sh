#!/usr/bin/env bash
# Publish a new ENGINE image to Fly, so newly-created projects get current code.
#
# WHY THIS SCRIPT EXISTS — the trap:
#   Machines in this app are NOT Fly Launch machines. The worker creates one per project
#   (fly.ts createMachine), naming it proj_<projectId> and passing that project's
#   ICA_PROJECT / ICA_KEY / ICA_HUB. Fly does not know that, so a plain `flyctl deploy` sees an
#   app with "no Fly Launch machines" and helpfully creates one — plus a standby. Both start the
#   engine with no project env, do nothing useful, and bill by the hour. That happened once; this
#   script is how it stops happening.
#   `--update-only` is the fix: create the release, update machines that exist, create none.
#
# WHAT A NEW PROJECT ACTUALLY PICKS UP:
#   createMachine resolves the app's CURRENT RELEASE image (getAppImage → currentRelease.imageRef).
#   So pushing an image is not enough — there must be a RELEASE pointing at it. Build, then release.
#
# EXISTING projects are untouched: their machines keep running the image they were created with
# until they are recreated. This publishes what the NEXT project will start from.
#
#   deploy/roll-fly.sh            # build, push, release
#   deploy/roll-fly.sh --check    # just show what a new project would get right now
set -euo pipefail
APP="${FLY_APP:-superatom-code-engine-vm}"
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--check" ]]; then
  echo "app:      $APP"
  echo "release:  $(flyctl releases -a "$APP" 2>/dev/null | sed -n '2p' | awk -F'│' '{print $1 $5}')"
  echo "machines:"
  flyctl machines list -a "$APP" 2>/dev/null | grep -E "^ [0-9a-f]{12,}" | awk -F'│' '{print "  "$2" ("$3")"}'
  exit 0
fi

echo "== building + pushing the engine image (remote builder) =="
IMAGE=$(flyctl deploy --remote-only --build-only --push 2>&1 | tee /dev/stderr | awk '/^image: /{print $2}')
[[ -n "$IMAGE" ]] || { echo "no image ref in the build output — nothing released"; exit 1; }

echo
echo "== releasing $IMAGE =="
# --update-only: create the release, do NOT let Fly launch machines of its own (see the note above).
flyctl deploy --image "$IMAGE" --strategy immediate --update-only -a "$APP"

echo
echo "== what a NEW project will now start from =="
flyctl releases -a "$APP" 2>/dev/null | sed -n '1,2p'
echo
echo "Machines (each proj_* belongs to one project; anything else should not be here):"
flyctl machines list -a "$APP" 2>/dev/null | grep -E "^ [0-9a-f]{12,}" | awk -F'│' '{print "  "$2" ("$3")"}'
