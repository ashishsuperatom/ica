# Agents

Each agent is **one folder = one module**: `index.ts` exports `createXxx({ ica, … })`, which starts an ICA session
with the agent's instructions.

Rules for every agent:

- **One job.** Agents hand work to each other (the composer escalates to the analyst); they don't do each other's jobs.
- **ICA is passed in, harness + model separate.** Defaults per agent are in `config/default.json`; any harness
  (`claude-code` / `pi` / `opencode` / `codex`) and model can be swapped via `opts.ica`.
- **Data only through the seams.** Agents reach data with the tools in their working directory (`./query`,
  `./introspect`, …), which go through the datasource-manager — never a database directly.

## Agents

| Agent | Folder | Job | Instructions |
|---|---|---|---|
| Composer | `composer/` | One per conversation: turns a question into a message on the person's data session (`./ask`), defines programs on existing ones, or `./escalate`s | `ROLE` in `index.ts` + `shared-prompts/graph-reference.ts` |
| Analyst | `analyst/` | Builds the concepts and programs the graph lacks, then answers with `./ask` | `ROLE` in `index.ts` + `shared-prompts/graph-reference.ts` |
| Narrator | `narrator/` | One live line of narration while work runs | `NARRATE` in `index.ts` |
| Connector | `connector/` | The admin's agent for connecting a data source: writes, tests and registers a bridge | `SYSTEM.md`, generated from `generate-system.ts` (plus `templates/`) |
| Grounding | `grounding/` | Builds value → id resolution for a source | `SYSTEM.md`, generated from `generate-system.ts` |

Never hand-edit a `SYSTEM.md`; edit its `generate-system.ts`.
