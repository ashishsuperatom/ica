# Local end-to-end test rig — TEST-ONLY, never production

This folder lets a developer drive the engine end-to-end on **localhost only** — ask a question, watch the
agents run, and inspect the answer file + agent transcript — with **no cloud, no Durable Object, no auth key**.

## The one hard rule

**None of this may ever run in, or influence, production.** It exists solely to test locally.

- **The engine has ZERO knowledge of this rig.** It connects to whatever `ICA_HUB` says. Production sets
  `ICA_HUB=wss://superatom.site` (the real Durable Object); this rig sets `ICA_HUB=ws://localhost:5174` in a
  throwaway env it constructs itself. No engine/production source imports anything here.
- `hub.mjs` binds `127.0.0.1` **only** and refuses any non-loopback bind. It is a standalone script — never
  imported by the engine, never added to a production `package.json` script, never deployed.
- The rig uses a **throwaway project** (`e2e-local`) on a **local SQLite** datasource in a temp state dir, so it
  can never touch a real project, the production hub, or a real data source.

If you are reading this file anywhere outside a developer's laptop, something is wrong — delete it.

## What's here

- `hub.mjs`     — a ~70-line stand-in for the Durable Object: welcomes the engine, relays a question from the
  test client to the engine and the engine's answer back. No auth. Loopback only.
- `bridge.mjs`  — a local SQLite data source (a tiny seeded employees table) so a real question has real data.
- `run.mjs`     — the orchestrator + test client: boots the hub + manager + engine against the local hub +
  throwaway project, waits for READY, sends one question, prints the answer, then points at `out/<qid>/` and the
  agent transcript. Pass `--keep` to leave the services running for inspection.

## Run it

```
node test/e2e/run.mjs "How many employees are in each department?"
```
