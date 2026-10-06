#!/usr/bin/env bash
# Both UIs locally with hot reload, against the live platform (their sockets go to wss://superatom.site; /api is
# forwarded there). Edit a file, the page updates — no deploy.
#   user app:  http://localhost:5174/?project=<project id>
#   console:   http://localhost:5175/admin/
set -euo pipefail
cd "$(dirname "$0")/.."
export VITE_API_PROXY=https://superatom.site
VITE_HUB_URL=wss://superatom.site pnpm -C control-plane/user-ui exec vite --port 5174 --strictPort &
pnpm -C control-plane/superadmin exec vite --port 5175 --strictPort &
trap 'kill 0' EXIT
wait
