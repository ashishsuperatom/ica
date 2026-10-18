# world-model — what we want

A design of intent, not of mechanism. It will change as practical limits show up; when it does, this page changes with
it (what it replaces is removed, not kept beside).

## Understanding

An internal model of a system that can

1. **predict** — what will happen, given a situation or an input;
2. **explain** — itself, and why it thinks something will happen;
3. **act** — prediction + a goal + a preference → a policy that chooses;

and that **learns**, and can answer **counterfactuals** (what if we had done otherwise).

The package is that model, used as `model.<fn>`: `model.predict(…)`, `model.explain(…)`, `model.decide(…)`,
`model.whatIf(…)`, `model.learn(…)`.

## A core of its own

- **Standalone.** It works without Superatom: its own package, its own tests, no import of anything of ours.
- **It needs infrastructure, through interfaces it declares** — a log to append to and read back, a store for what it
  computes, a clock, word that something changed, a way to be run later. Superatom implements them in **one adapter**;
  tests and standalone use pass in-memory ones.
- **Removable.** If it proves not practical yet, deleting the package and its one adapter breaks nothing else.
- **No domain.** Situations, actions, goals and rewards are given to it; it knows none of its own.

## In Superatom

- **The engine runs it** — near the data (read only through the datasource manager).
- **The platform remembers** — the record of situations, choices and outcomes is the truth, kept in the project's
  Durable Object (today's DecisionDO, renamed for this); the engine keeps what it computes from it as a cache, rebuilt
  from the record whenever needed.
- **It runs when asked, when something changes, and from time to time** — a question or an intent; a source's data or an
  outcome arriving; a schedule. Long-running work is an engine workload like any other.

## Models: many small ones now

- **Now: many small, independent models** — each for an intent or a category of things.
- **Later:** models of whole subsystems, then of the whole organisation.
- **No composition now.** We do not know yet how models will compose, and building for composition early makes the
  task at hand less expressive. Each small model is free to be what its problem needs.
- **Referential integrity instead.** Everything is said once and referred to by its identity — a model, a signal, an
  action, a thing in the world (a supplier, a requisition) — so that when a better system arrives, a change is made in
  one place, not in many.

## Learning

- **From what people do (imitation)** — a person starts with an intent, sees a situation and its signals, takes a path,
  and keeps taking paths. What they pick is itself the output of a model; we learn it from their trajectories.
- **From rewards, where they exist** — a computational model that scores an outcome, in the fields that have one; and
  real outcomes, which arrive late, because the world has to change and effects take time. A decision opens an episode
  with an identity; its outcome attaches to it whenever it comes, or never.
- **A learning loop of its own** — learning runs separately from people using the system: usage records, the loop
  learns, the model improves.

## Start simple

The first version is deliberately small — one kind of small model, learning from recorded trajectories — and grows
only when a real use needs more. The code from `~/try/decision-engine` (signals, state as the output of signals,
fingerprints, Beta statistics with confidence, the record as the truth, promotion) is brought in here as the starting
point, with its lessons kept; that folder is then deleted.

## Open

- Where goals and preferences come from — stated by people, learned from what they do, or both.
- How models compose into subsystem and organisation models.
