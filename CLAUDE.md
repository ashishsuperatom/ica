# Superatom — project guide

A decision-intelligence system: a question becomes an answer by writing/running a
**program** built from **small units of computation**, then generating UI from the
result. Programs are the deterministic, reusable, instrumented artifact.

## The four "systems" (Kahneman framing)

The agents that produce/maintain computation are named by thinking speed:

- **System 1 — fast thinking (the pi agent).** Reuses the existing computation-unit
  graph: composes/lightly-adapts existing units, runs, returns. Cheap, immediate.
  (Today: exact-run re-execution + the pi-agent adapt path.) The model behind pi is
  swappable — do not assume a specific LLM.
- **System 2 — medium thinking.** More capable than System 1, less than System 3.
  **Not built yet** — parked.
- **System 3 — slow thinking (Claude Code).** Writes genuinely new computation from
  scratch when nothing reusable exists. Expensive, high-intelligence. (Built.)
- **System 4 — consolidation ("sleep").** Offline. Consolidates, de-duplicates, and
  abstracts provisional work into the library — like memory consolidation during
  sleep. This is where "no duplicate definitions" is actually enforced. (To build.)

## Core principles

- **Programs are full Node.js/TypeScript — never a DSL.** Units (`@superatom/scaffold`)
  are instrumented (`read/transform/decide/explain/finish`) only to build a provenance
  graph; they never restrict what code can do.
- **Units are generic, LLM-authored function-nodes — we do NOT define concepts.** A
  unit is just one function (a full little program) that the LLM writes while solving
  the task; any complexity lives inside it. We never hand-build a library of named
  concepts. Identity ("which node is the right one for X") is *discovered* (entity
  resolution / stable attractors), never assigned. Closures keep everything one script
  so units reuse shared state/helpers freely.
- **Nothing domain-specific is hard-coded.** A unit's *structure* is canonical (single
  source of truth), but its *parameters* (e.g. a dead-stock cutoff) are free, can be
  conditional by context, are used for counterfactuals, and their defaults are LEARNED
  from usage — never constants. There can be multiple coexisting "right" values that
  drift over time. We figure truth out from usage; we do not define it up front.
- **Data only through the datasource-manager** (`read()`), so provenance is complete.
- **Correctness before efficiency.** (Freshness/caching/monitoring are deferred.)

## Where the design lives

Design direction & build plan for the current engine:
**`vm/apps/engine/PLAN.md`**. (The earlier `code-engine/ARCHITECTURE.md` vision doc — units of
contested knowledge, concepts as stable attractors, epistemic self-correction — was retired with that
app; recover it from git history if that direction is needed again.)
