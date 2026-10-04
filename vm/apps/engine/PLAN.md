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

## Programs (`vm/packages/programs`, `vm/packages/state`)

- A program's source is a folder — `manifest.json`, `server/` (its Node side), `web/` (its React side), `doc.md` —
  kept in the project home under `programs/src/`. `programs build` compiles both sides with TypeScript and keeps the
  result in `programs/store/<hash>`: the same source, the same hash; any change, a new program beside the old one.
- `programs run <name|hash> [--set path=json] [--call fn] [--act id]` loads its Node side into the STATE engine and
  runs it against the project's data (only through the datasource-manager); `list`, `doc`, `inspect`, `verify`.
- Agents: `agents/<id>.json` in the project home (domain, programs, tools, start, ui). `thread-seam.ts` runs `thread:*`
  messages — open, intent (ops, action, call; to current or new; from any block), goto, get (as of a moment) — on the
  agent's programs; each view carries the answers as cards (`answer-card.ts`, shared with the chat) and the intents the
  programs offer. The user UI shows it at `/t/<agent>` (`control-plane/user-ui/src/Threads.tsx`).
- First real program: Total Group `unsettled-trips` — completed trips not settled, by branch, with the balance left.

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
`./sources ./find-schema ./get-schema ./query` (`./resolve` is kept but not given for now). A domain's own programs are placed beside them.

## State

Everything that belongs to one project lives in its **home**, `~/.superatom/state/<projectId>/` (`ENGINE_STATE_DIR`);
the repository holds only the platform.

- `.env` (hub, key, source credentials), `settings.json`, `secrets/`, `datasources/` (bridges, registry, index seeds),
  `knowledge/` (what the composition graph imports), `app/` (the project's application).
- `programs/` — `src/` (program sources) and `store/` (built programs by hash). `agents/` — the project's agents.
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
