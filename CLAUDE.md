# Superatom — project guide

A decision-intelligence system: a question becomes an answer by calling **programs** in a
**program graph** (`vm/packages/graph`), and the answer carries its views, narration and next
steps. Programs are the deterministic, reusable, recorded artifact.

## The four "systems" (Kahneman framing)

The agents that produce/maintain computation are named by thinking speed:

- **System 1 — fast thinking (the composer).** One per conversation. Uses the existing
  graph: turns a question into a message on the person's data session, or defines a program
  on programs that exist, runs, returns. Cheap, immediate. Escalates when a concept is
  missing. The model behind it is swappable — do not assume a specific LLM.
- **System 2 — medium thinking.** More capable than System 1, less than System 3.
  **Not built yet** — parked.
- **System 3 — slow thinking (the analyst).** Builds what the graph lacks: explores the
  data, writes the concepts and programs, then answers. Expensive, high-intelligence. (Built.)
- **System 4 — consolidation ("sleep").** Offline. Consolidates, de-duplicates, and
  abstracts work in the graph — like memory consolidation during sleep. (Not built.)

## Core principles

- **Programs are full JavaScript and SQL — never a DSL.** Structure is kept by convention
  and by the engine recording every call; it never restricts what code can do.
- **Everything is a program, identified by hash.** A *concept* is a program that reads a
  data source; a *program* reads other programs. Each returns a value, rows, a relation (with
  a shape: dimensions, measures, time) or an answer. Names point at hashes; a change is a new
  program. One program per idea, referenced everywhere, fixed once.
- **Concepts are defined — by the analyst, from the data, not hand-built by us.** They are
  named for the idea, not the question, so the next question finds them.
- **Nothing domain-specific is hard-coded.** A program's *structure* is canonical (single
  source of truth), but its *parameters* (e.g. a dead-stock cutoff) are free, can be
  conditional by context, are used for counterfactuals, and their defaults are LEARNED
  from usage — never constants. There can be multiple coexisting "right" values that
  drift over time. We figure truth out from usage; we do not define it up front.
- **Data only through the datasource-manager**, so every call's record is complete.
- **Correctness before efficiency.** (Freshness/caching/monitoring are deferred.)

## Where the design lives

- **`docs/program-graph.md`** — the engine design: programs, concepts, shapes, memory,
  expectations, sessions; decided vs open.
- **`vm/apps/engine/PLAN.md`** — what is built (agents, tools, state layout) and what is next.
