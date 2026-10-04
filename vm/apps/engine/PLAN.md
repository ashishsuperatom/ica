# Engine — plan (reference)

The engine runs one project: it connects out to the hub (the project's Durable Object) over WebSocket and drives the
coding agents (ICAs) that answer for it. A conversation is one **agent**: a domain of the composition graph, chosen by
the person or picked by the first question's words. The design is **`docs/platform-architecture.md`**; this file is
what is built and what is next.

---

## Knowledge (`vm/packages/composition-graph`, `knowledge.ts`)

- A project's knowledge is written in its home's `knowledge/index.mts` (settings and domains: their parts, files and
  settings) and imported into `db/composition.sqlite` with `composition-graph import`; `composition-graph verify
  --against` checks the graph holds what the knowledge writes.
- A conversation's domain is composed into its agent's system prompt; its files (programs, helpers) and
  `settings.json` are placed in the conversation's folder (`knowledge.ts`).

## Agents (`agents/`)

| agent | job |
|---|---|
| composer | one per conversation: the domain's agent. Answers in markdown; marker lines (`:::table x.json`) name the blocks it wrote |
| narrator | one line of live narration while work runs |
| analyst | a terminal in the shared workspace with the data tools (and where a person logs the harness in) |
| connector | the admin's agent for connecting a data source (writes, tests and registers a bridge) |
| grounding | builds value → id resolution for a source |

Harness, provider and model per agent: `config/default.json`, overridable per project.

## Tools

Generated into each working directory by `ica/workspace.ts`; each explains itself with `--help`:
`./sources ./query ./introspect ./find-schema ./resolve`. A domain's own programs are placed beside them.

## State

Everything that belongs to one project lives in its **home**, `~/.superatom/state/<projectId>/` (`ENGINE_STATE_DIR`);
the repository holds only the platform.

- `.env` (hub, key, source credentials), `settings.json`, `secrets/`, `datasources/` (bridges, registry, index seeds),
  `knowledge/` (what the composition graph imports), `app/` (the project's application).
- `db/` — `composition.sqlite`, `datasource-index.sqlite` (read by `./find-schema`), `grounding.sqlite`,
  `agent-sessions.sqlite`. Outside every agent's cwd.
- `workspace/` — the analyst, connector and grounding agents' directory.
- `sessions/<sessionId>/` — one conversation's directory, the composer's; a turn's files in `out/<qid>/`.

## Surfaces

The engine emits `analyst:answer` (the answer in the shape every surface renders) and the live narration. Surfaces
talk only to the project's Durable Object.

---

## Next

The order of work is in `docs/platform-architecture.md`: schemas, the STATE engine, programs, the user UI shell,
agents and sessions, one agent end to end, the platform side, the builder agent.
