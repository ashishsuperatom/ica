# Agents

Each agent is **one folder = one module**, and every agent folder has a **`SYSTEM.md`** — the system
prompt that gets loaded into its ICA. Same shape for all of them:

```
agents/
  <agent-name>/
    SYSTEM.md     ← the system prompt loaded into the ICA (the agent's job, rules, method)
    index.ts      ← the module: createXxx({ ica, … }) → drives an ICA using SYSTEM.md
```

Rules for every agent:

- **One job.** An agent does exactly one thing (the semantic-model agent *only* models; a QA agent
  *only* answers). They hand work to each other; they don't do each other's jobs.
- **ICA is passed in, harness + model separate.** Default is `claude-code:sonnet5`; any harness
  (`opencode` / `pi` / `codex` / `claude-code`) and model can be swapped via `opts.ica`.
- **Data only through the seam.** Agents reach data via `query(dataSourceId, sql, params)` /
  `sources()` (the datasource-manager) — never a database directly.

## Agents

| Agent | Folder | Job |
|---|---|---|
| Semantic model | `semantic-model/` | Build + refine the semantic-model DAG. Never answers questions. |
| *(QA)* | *(later)* | Answer a user question using the model + data; hands its result back to the semantic-model agent to refine. |
