# Engine — plan (reference)

The engine turns a person's question into an answer over their organisation's data. It runs one project, connects
out to the hub over WebSocket, and drives coding agents (ICAs) that answer with **programs on the semantic graph**.
The design is **`docs/semantic-graph.md`**. This file is what is built and what is next.

---

## The semantic graph (`vm/packages/semantic-graph`)

- A project commits its model in `vm/projects/<id>/semantic/`: `schema.json` (entities, calendars, facts, arrows,
  measures), `sources.json` (where each object's rows are), `settings.json`, and producing programs.
- A **question** — measures, grouped by where arrows lead, kept to records, over a span — is checked by the graph's
  rules, compiled to the source's own SQL and run through the datasource manager.
- Every answer is recorded: **memory**, **expectations**, **decisions**. Each conversation has a **data session**:
  its steps, each with its answer.
- An **answer program** (`programs.ts`) asks the graph with `ctx.ask` and returns headline, data, views, narration
  citing cells, and next steps. Rows carry record ids beside their names.

## Agents (`agents/`)

| agent | job |
|---|---|
| composer | one per conversation. Reads the question in the graph's terms, answers with a program (`./run-program`), or `./escalate`s |
| analyst | takes escalated questions: explores the data, answers on the graph when it can, else says what the graph is missing |
| narrator | one line of live narration while work runs |
| connector | the admin's agent for connecting a data source (writes, tests and registers a bridge) |
| grounding | builds value → id resolution for a source |

Harness, provider and model per agent: `config/default.json`, overridable per project.

## Tools

Generated into each working directory by `ica/workspace.ts`; each explains itself with `--help`.

- the semantic graph — `./resolve-terms ./find-measure ./find-dimension ./find-record ./describe ./group-paths ./overview
  ./check-question ./try-question ./run-program ./source-records ./trace-answer` (composer, analyst)
- the data — `./sources ./query ./introspect ./find-schema ./resolve` (analyst, connector, grounding)
- hand-off — `./escalate`

## Verbs (`graph/semantic-verbs.ts`, `graph/semantic-turns.ts`)

`view: <Entity> <id>` · `run: [qid]` · `check: [qid]` · `program: [qid]` · `explain:` · `edit: <change>` — on the
answer on screen. Run, check, program and a kept view need no model.

## State

Under `~/.superatom/state/<projectId>/` (`ENGINE_STATE_DIR`):

- `db/` — `semantic-graph.sqlite` (definitions, memory, data sessions), `datasource-index.sqlite` (read by
  `./find-schema`), `grounding.sqlite`, `agent-sessions.sqlite`. Outside every agent's cwd.
- `workspace/` — the analyst, connector and grounding agents' directory.
- `sessions/<sessionId>/` — one conversation's directory, the composer's; a turn's files in `out/<qid>/`
  (`step.json`, `program.mjs`, `params.json`, `explain.md`).
- `views/` — the kept view programs, one per kind of record and lens.

## Surfaces

The engine emits `session:step` to surfaces, and `analyst:answer` (converted from the step) beside it. Surfaces
talk only to the project's Durable Object.

---

## Next

1. **The conversation's state as coordinates** — each step records measures, groups, records, span and context,
   taken from the program's graph questions; a follow-up or a click is a change to that state.
2. **The graph builder** — an agent that extends the semantic graph from feedback and the data.
3. **Budget on NetSuite** — the BudgetLine source, fast enough to load.
