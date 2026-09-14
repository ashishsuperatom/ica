# Engine — plan (reference)

The engine turns a person's question into an answer over their organisation's data. It runs one project, connects
out to the hub over WebSocket, and drives coding agents (ICAs) that write and call **programs** in the program graph.
The design — programs, concepts, shapes, memory, expectations, sessions — is **`docs/program-graph.md`**. This file
is what is built and what is next.

---

## The graph (`vm/packages/graph`)

- A **program** is JavaScript, identified by the hash of its content; a **name** points at a hash.
- A **concept** is a program that reads a data source. A program reads other programs.
- Every program returns a `value`, `rows`, a `relation` or an `answer`. A relation has a **shape**: its dimensions,
  measures and time.
- Every call is recorded: **memory**, **expectations**, **decisions**.
- Each conversation has a **data session**. Its steps are states and the answers on them.

## Agents (`agents/`)

| agent | job |
|---|---|
| composer | one per conversation. Turns a question into a message on the person's data session (`./ask`), defines programs on existing ones, or `./escalate`s |
| analyst | builds the concepts and programs the graph lacks, then answers with `./ask` |
| narrator | one line of live narration while work runs |
| connector | the admin's agent for connecting a data source (writes, tests and registers a bridge) |
| grounding | builds value → id resolution for a source |

Harness, provider and model per agent: `config/default.json`, overridable per project.

## Tools

Generated into each working directory by `ica/workspace.ts`; each explains itself with `--help`.

- the graph — `./catalog ./define ./try ./ask ./find ./members`
- the data — `./sources ./query ./introspect ./find-schema ./resolve`
- hand-off — `./escalate`

## State

Under `~/.superatom/state/<projectId>/` (`ENGINE_STATE_DIR`):

- `db/` — `graph.sqlite` (programs, memory, sessions), `datasource-index.sqlite` (the datasource schema index read
  by `./find-schema`, `vm/packages/datasource-index`), `grounding.sqlite`, `agent-sessions.sqlite` (which harness
  session each agent resumes). Outside every agent's cwd.
- `workspace/` — the analyst, connector and grounding agents' directory.
- `sessions/<sessionId>/` — one conversation's directory, the composer's.

Committed per project: `vm/projects/<projectId>/datasources/`.

## Surfaces

The engine emits `session:step` to surfaces, and `analyst:answer` (converted from the step) beside it. Surfaces
talk only to the project's Durable Object.

---

## Next

5. **Surfaces render `session:step`** — web and iOS draw the step's state and answer directly.
6. **End to end on local NetSuite** — a question through composer → escalate → analyst → graph → surface.
7. **The Fusion5 scenarios** — the questions in `docs/program-graph.md` §17, answered and checked.
