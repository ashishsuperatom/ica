# Superatom engine — Docker deploy (Linux)

Run the engine in Docker on any Linux host. Same image as Fly, but self-hosted — with a persistent
volume for state and a clean teardown. Distributed as a zip (not Docker Hub): unzip, build, run.

## Deploy
1. Copy the zip to the host, unzip, `cd` in.
2. `./deploy.sh` — first run creates `.env`; fill `ICA_PROJECT` / `ICA_KEY` / `ICA_HUB`, then run it again.
   (Or manually: `docker compose up -d --build`.)
3. Auth the coding agent once: `docker compose exec engine claude login` (or set `CLAUDE_CODE_OAUTH_TOKEN` in `.env`).

Watch it: `docker compose logs -f engine` — look for `ENGINE FULLY READY`.

## Why Docker (vs the pm2 version)
- **Clean teardown**: `docker compose down -v` removes the container *and* the data — the host stays pristine.
- **Reproducible**: no host Node-version drift; identical to the Fly image.
- Negligible overhead on Linux (host kernel, near-native volume I/O, one outbound connection).

## Data persistence
State lives in the named volume `superatom-data` mounted at `/app/data` (the unified `state/` layout,
plus the datasource registry and the agent's auth). It **survives** container restart, recreate, and host
reboot (`restart: unless-stopped`). `docker compose down` keeps it; `down -v` wipes it.

## Rebuild the zip (maintainers)
From the repo root: `node deploy/docker/build-zip.mjs` → `dist/superatom-engine-docker-<stamp>.zip`.
