# Superatom engine — Linux deploy

Run the engine on any Ubuntu host (EC2 / GCE / Azure VM, or bare metal) — no Docker. This is the
same engine as the Fly image, just bootstrapped onto a host instead of baked into a container.

## Deploy
1. Copy the zip to the host and unzip it, then `cd` in.
2. `./setup.sh` — installs Node (nvm), pnpm, pm2, build tools, and the workspace deps. Idempotent; safe to re-run.
3. Edit `.env` — fill `ICA_PROJECT` / `ICA_KEY` / `ICA_HUB` (the same values a Fly machine gets).
4. `claude login` — authenticate the coding agent once (or set `CLAUDE_CODE_OAUTH_TOKEN` in `.env`).
5. `./run.sh` — starts everything under pm2 (and `pm2 save`, so it survives reboot).

Watch it connect: `pm2 logs sa-engine` — look for `ENGINE FULLY READY`.

To have it come back after a machine reboot: run the command `pm2 startup` prints, once.

## What runs (all under pm2)
- `sa-opencode` — the reflex model server (`:4096`, localhost only)
- `sa-manager`  — the datasource manager (`:4000`, localhost only)
- `sa-engine`   — the engine; connects **out** to the hub over WebSocket (no inbound ports)

## State & data sources
- Everything the engine generates lives in `./state/<project>/` (workspace + `project.sqlite` /
  `grounding.sqlite` / `answers.sqlite`) — the same unified layout as Fly.
- Data sources are connected at runtime via the admin's **connector agent**, or by dropping a bridge
  into `./datasources/` and registering it. This zip carries **no secrets and no specific project**.

## Rebuild the zip (maintainers)
From the repo root: `node deploy/linux/build-zip.mjs` → writes `dist/superatom-engine-linux-<stamp>.zip`.
The zip excludes `node_modules`, state, DBs, and any `.env`/`.pem` — it's just the source + these scripts.
