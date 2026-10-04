# Superatom — project guide

A decision-intelligence platform. A person works with an **agent**: a domain of the **composition graph** (its
concepts, composed into the agent's system prompt), the **programs** it may run, one **STATE**, a starting UI, and an
ICA (the composer) for questions in words. Answers are markdown with marker lines naming the blocks they show.

## The four "systems" (Kahneman framing)

The agents that produce/maintain computation are named by thinking speed:

- **System 1 — fast thinking (the composer).** One per conversation: the domain's agent. Answers from the domain's
  knowledge and programs, in markdown with markers. The model behind it is swappable — do not assume a specific LLM.
- **System 2 — medium thinking.** **Not built yet** — parked.
- **System 3 — slow thinking.** Explores the data for what the agents cannot answer, and extends their knowledge.
  To be rebuilt on the composition graph.
- **System 4 — consolidation ("sleep").** Offline. Consolidates, de-duplicates and abstracts — including variations
  of programs that agents keep re-implementing. (Not built.)

## Core principles

- **Everything is an agent.** A dashboard is an agent with a dashboard attached; a report or file is a node of its
  domain.
- **Concepts are text** in the composition graph, composed in order into an agent's context. Changes go through the
  `composition-graph` CLI; everything is stored by hash with an append-only change log.
- **Programs are a Node.js bundle and a React bundle**, immutable by hash, scoped global / group / user with one
  owner. Each declares the slice of STATE it owns and the functions it offers; it can change only its own slice.
- **STATE is the last block's**, a singleton JSON; earlier blocks never change (editing one branches the thread).
  The session's **answer history** keeps every answer.
- **Nothing domain-specific is hard-coded** in the platform. Parameters are settings, free and context-dependent,
  their defaults learned from usage — never constants.
- **Data only through the datasource manager**, so every call's record is complete.
- **Correctness before efficiency.**

## Checks

`scripts/check-all.sh` runs every typecheck and test suite and stops at the first failure. Run it before every
deploy and push.

## Where the design lives

- **`docs/features.md`** — one line per major feature: what is built, and what is planned (partly done counts as planned).

- **`docs/platform-architecture.md`** — the platform: agents, concepts, programs, STATE and intents, sessions, the
  answer history, governance, storage (platform first, engine a replica), Durable Objects, the template, migrations.
- **`docs/composition-graph.md`** — the composition graph's mechanics.
- **`vm/apps/engine/PLAN.md`** — what is built in the engine and what is next.
