# fast-router

A per-project **fast search / classification** worker. As a user types, it routes their question in
**milliseconds** — classifying intent, matching prior well-answered questions, and extracting
parameters/entities — so the engine can pick the cheapest correct path. The user never has to use it;
it only ever *suggests*.

**Node/TypeScript only. No Python runtime.** Models run in-process via ONNX.

It is developed and deployed **independently** of the rest of the system (an indirect dependency),
which is why it lives at the repo root, not under `vm/` (that tree is deployed dynamically to fly.io).
Locally it runs as its own pm2 process; in production it's a single 4vCPU/8GB box (one box until we
cross ~100 projects).

## How it connects (WS only, no HTTP for the request path)

fast-router is **not** a new hub or a new protocol. It's a new **server-side role on the same
per-project DO** the code-engine already uses:

```
frontend ──(UI WS)──► code-engine ──(same DO hub, role 'fast-router')──► fast-router worker
                          ▲                                                     │
                          └──────────────── suggestions ◄───────────────────────┘
```

- The worker opens **one WS per project** to `wss://<host>/_ws/<projectId>?key=<apiKey>` and sends
  `{ type:'hello', key, role:'fast-router' }` — the same per-project API key code-engine uses. The DO
  validates it exactly like code-engine, but registers it as a **passive** role (it never wakes the
  fly machine or counts as engine/user liveness).
- Engines relay to it with `{ to:{ type:'fast-router' }, payload:{ t:'suggest', … } }`; the worker
  replies `to` the sender. The **frontend never knows fast-router exists** — it talks only to the
  engine, and the engine consults fast-router.
- Latency note: because the hub is a Cloudflare DO, a keystroke pays `engine → CF → worker`. Accepted
  by design; the frontend time-debounces and the worker drops stale requests so few keystrokes travel.

Qdrant (semantic search) and the ONNX models are **internal datastores/inference**, reached over their
own clients on localhost — not the UI transport — so they don't violate the WS-only rule (same as
SQLite in the engine today).

## Identity model (carried on every hop) — see `src/protocol.ts`

| field | who sets it | purpose |
|-------|-------------|---------|
| `projectId` | connection (the DO) | scope — selects the project's index/collection |
| `userId` | DO-stamped from the verified JWT | trusted scope; **never** client-supplied |
| `inputId` | frontend, on **focus/click** into an input box | a fresh UUID per tab/field — routes the reply to the **exact** input, so two tabs (same user) don't cross |
| `seq` | frontend, on **each change** | debounce + drop-stale: only the highest `seq` per `(projectId,userId,inputId)` matters |

Every layer re-applies the drop-stale rule (`src/router.ts`), because messages cross several hops and
can arrive out of order. The frontend also time-debounces (~100ms) so most keystrokes never leave the
browser. For a *submitted* run (not a keystroke), the rule is one-in-flight per `(projectId,userId)`,
**latest wins** (discard previous) — enforced engine-side.

## What it classifies / returns

1. **Intent** (the first routing decision) — `lookup | analysis | edit | action | unknown`. Generic,
   no dataset nouns, no hardcoded trigger phrases; a per-project model tuned by the consolidation
   agent. Lets the engine route: lookup→fast replay, analysis→full program, edit→refine last program,
   action→command handler.
2. **Matched prior questions** — semantic nearest-neighbour over previously well-answered questions
   (**Qdrant**, a collection per project), returned as ready-to-run suggestions.
3. **Parameters / entities** — GLiNER2 extraction + typo-tolerant entity/prefix search.

All three are stubs today (the WS path round-trips end-to-end; models wire in next).

## Stack (all Node)

- transport: `ws`
- semantic search: **Qdrant** (`@qdrant/js-client-rest`), a co-located service, collection per project
- embeddings + GLiNER2: ONNX via `onnxruntime-node` / `@huggingface/transformers` (added when wired)
- typo-tolerant search: in-memory JS fuzzy index

Model weights, Qdrant storage, per-project corpora/indexes, and project API keys are all **gitignored**.

## Run (local)

```bash
pnpm install
# provide the projects this worker serves (holds API keys — gitignored):
#   projects.local.json  →  [{ "id": "totalgroup", "key": "sk-proj-..." }]
# or env FR_PROJECTS='[{"id":"totalgroup","key":"sk-proj-..."}]'
pnpm start          # or: pnpm dev  (watch)
```

`FR_HUB_HOST` overrides the hub (default `wss://superatom.site`).

> The DO must accept `role:'fast-router'` (added in `cloudflare/superadmin/src/project-do.ts`) —
> deploy that before the worker can register live.
