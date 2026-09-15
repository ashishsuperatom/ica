# Superatom — project guide

A decision-intelligence system: a question becomes an answer by a **program** that asks the
**semantic graph** (`vm/packages/semantic-graph`), and the answer carries its views, narration and
next steps. The graph gives the guarantees (checked questions, native SQL, recorded memory); the
program shapes what a person reads.

## The four "systems" (Kahneman framing)

The agents that produce/maintain computation are named by thinking speed:

- **System 1 — fast thinking (the composer).** One per conversation. Reads the question in the
  graph's terms, writes one program on the graph and runs it as the conversation's next step.
  Cheap, immediate. Escalates when the graph does not hold what the question needs. The model
  behind it is swappable — do not assume a specific LLM.
- **System 2 — medium thinking.** More capable than System 1, less than System 3.
  **Not built yet** — parked.
- **System 3 — slow thinking (the analyst).** Takes escalated questions: explores the data,
  answers on the graph when it can, else says what the graph is missing. Extending the graph
  from feedback and the data is the next part to build.
- **System 4 — consolidation ("sleep").** Offline. Consolidates, de-duplicates, and
  abstracts work in the graph — like memory consolidation during sleep. (Not built.)

## Core principles

- **The semantic graph is established mathematics, engineered.** A schema is a finitely
  presented category (objects, arrows as functions, path equations); questions are checked by
  its rules (summarizability, conformed dimensions, time, units, versions) before any SQL runs,
  and a refusal says what to change. Definitions are stored by hash; names point at them.
- **Programs are full JavaScript — never a DSL — and read only the graph** (`ctx.ask`). They
  transform, decide, verify, caveat and narrate; every step is recorded. One whole program per
  answer, kept in the conversation's session.
- **The agent sees a graph, never SQLite or SQL.** Its tools read nodes, arrows and paths.
- **Records carry their ids** everywhere, so any record can be opened (`view:`) and followed.
- **Nothing domain-specific is hard-coded.** A program's *structure* is canonical (single
  source of truth), but its *parameters* (e.g. a dead-stock cutoff) are free, can be
  conditional by context, are used for counterfactuals, and their defaults are LEARNED
  from usage — never constants. There can be multiple coexisting "right" values that
  drift over time. We figure truth out from usage; we do not define it up front.
- **Data only through the datasource-manager**, so every call's record is complete.
- **Correctness before efficiency.** (Freshness/caching/monitoring are deferred.)

## Where the design lives

- **`docs/semantic-graph.md`** — the semantic graph: foundations, schema, rules, questions,
  state, memory, programs, running where the data is.
- **`vm/apps/engine/PLAN.md`** — what is built (agents, tools, state layout) and what is next.
