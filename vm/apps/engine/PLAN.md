# Enterprise Engine — build plan (reference)

An abstract engine that **understands an enterprise and can simulate it** — accurately and fast.
Nothing hardcoded for any dataset. This doc is the reference for *what is built* vs *what is not*.
We do NOT build it all at once. We build in order, starting with the **ICA**.

---

## The core loop

A question comes in. The **ICA** (Intelligent Coding Agent) answers it, given four inputs:
- **(a) data sources** — the *world state* (never touched directly; only via `query(dataSourceId, sql|call, params)` over the hub or a localhost http wrapper).
- **(b) knowledge graph** — business rules + tribal knowledge + user preferences.
- **(c) the partial semantic model** — a partial model of the data sources; *always* used with the data sources; improved after every question.
- **(d) the partial UNIT library** — small computations, each a self-sufficient `situation → next-step` (associative memory).

The ICA: **analyse → build the UI → validate it's what's expected → commit the answer.** Then it **improves**:
- the **semantic model** (its DAG + implementation details — code + metadata),
- any **UNIT** (change / merge / replace / split).

When a new question **exactly matches** existing work → the fast **SYS-1** agent answers directly (no ICA).

## One invariant: everything is three things

Every node — a semantic-model concept, a unit, a program — always has:
- **(a) meaning** — for organization / search / human comprehension.
- **(b) computation** — JS code that fetches data or computes.
- **(c) UI** — how the computed data is represented. *This is really part (b.2) of the computation*, not a separate thing.

Everything is **code + metadata**. The metadata is the "semantic model" as normally understood; we *also* keep the code implementation.

## Layers

1. **Data fetching & transformation** — SQL / REST / small transforms. **No abstraction that hides anything.** Raw and inspectable.
2. **Semantic model** — a DAG of the business domain: meaning, business rules, dependencies, actions, effects.
3. **Superatom model** — UNITs and PROGRAMs (as designed). Later: a **simulation engine**.

## Storage (SQLite)

- **users.sqlite** — users of the system: roles, permissions, everything user-related. Kept **separate** from project data.
- **project.sqlite** — everything about one project: UNITs, the semantic-model DAG, programs, knowledge, runs. (We already have a start: `engine.db` = messages/programs/sessions — evolve it.)
- **DAG + data live in SQLite.** When a node needs code to run, store the **code path/id** in a column (code on disk = truth, SQLite = the findable index).
- **Data sources** may be SQLite files in a `datasources/` folder — but we **never see or connect to them directly**. Same as if hosted elsewhere. Access is *only* `query(dataSourceId, …)` over the websocket hub or a localhost http wrapper. This is the *world-model* database.

---

## The ICA module (start here — most important, most complex)

A module that runs an agent, with **harness and model passed separately**:

| variant | harness | model | auth default | override |
|---|---|---|---|---|
| `cc-sonnet-5` | Claude Code | sonnet-5 | **subscription** | apiKey → OpenRouter |
| `opencode-sonnet-5` | opencode (server module, no TUI) | sonnet-5 | **go/zen subscription** | apiKey → OpenRouter |
| `pi-sonnet-5` / `pi-deepseek-v4-flash` | pi agent (headless SDK) | any | OpenRouter | — |

- **Claude Code** has no JSON mode → we **drive it through a terminal/PTY** and emulate everything: feed the prompt, parse the stream, detect when it **asks a question** (answer it), detect **completion**. Subscription by default; an apiKey routes via OpenRouter (`ANTHROPIC_BASE_URL`). *This is the hard part.* (Note: CC's `-p --output-format stream-json` headless mode exists as a possible simpler path — evaluate, but the user's call is terminal-emulation first.)
- **opencode** & **pi** have proper headless SDKs → use them directly. For opencode, discard the terminal UI and use the **server module**.

Uniform interface (all adapters implement it): `createICA({harness, model, apiKey?}).run(prompt, {cwd, onEvent, answer})`.

---

## Build status

**Reusable from the current repo (port, don't rewrite):**
- `query(dataSourceId, sql, params)` datasource seam (`@superatom/scaffold` datasource.ts) — the ONLY data access.
- The websocket hub (Cloudflare DO) + localhost http datasource-manager.
- SQLite project store (`engine.db`) — evolve schema to hold the semantic-model DAG + units.
- The pi harness pattern (`unit-author.mjs` / `pi-engine.ts` via `@earendil-works/pi-coding-agent`).
- fast-router (SYS-1 search/match) — the exact-match fast path.

**To build (in order):**
1. **ICA module** — harness×model abstraction. **Claude Code adapter first** (PTY), then pi, then opencode. ← *starting now*
2. Semantic-model layer — the DAG (meaning/rules/deps/actions/effects) in SQLite, code+metadata+UI per node.
3. Superatom layer — UNITs + PROGRAMs on the new store; associative `situation → step` memory.
4. SYS-1 fast path — exact-match → run without ICA (wire fast-router).
5. UI layer — each compute node carries its UI element; programs compose them.
6. users.sqlite — roles/permissions.
7. (later) simulation engine.

**Disposition of current code:** keep the seams above; everything dataset-specific or superseded is deleted as it's replaced (git holds it). We delete *as we port*, not up front, so the branch always builds.

---

## Working agreement
- Nothing hardcoded per dataset — the engine is generic; TotalGroup is just one connected world.
- Build one layer at a time, starting with the ICA (Claude Code first).
- Every node: meaning + computation + UI. Everything is code + metadata, indexed in SQLite.
