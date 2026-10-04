# Platform architecture

Status: **design, agreed direction (2026-10-04), not built.** The starting point for the project template. Builds on
`composition-graph.md` (the graph's mechanics) and `identity-and-access.md` (principals, tokens). Marked **OPEN** where
a decision is still to be made.

## In one paragraph

Everything a person uses is an **agent**. An agent is a domain of the composition graph (concepts, composed into its
system prompt), the **programs** it may run, one **STATE**, a starting UI whose controls change that STATE, and an ICA
(the composer) for questions in words. A person works in a **session** with an agent: one STATE that keeps changing,
and a history of what they were shown (**partial org state**). The **user UI** is the one application every project
starts from; what we called a dashboard is an agent with more programs attached, built by the **builder agent**.
Everything is scoped global / group / user, has one owner, and is kept as an append-only log. It is stored in the
platform first and synced to the engine; every part has a cloud build and an on-prem build.

## The things

### Scope

Every concept, program, agent and artifact belongs to one scope:

| Scope | Who sees it |
|---|---|
| `global` | everyone in the project |
| `group:<name>` | members of a group the organisation names (finance, marketing, …); a function assigns users to groups |
| `user:<id>` | one person |

What a person can use is the union of global, their groups, and their own — always a partial view.

### Concept

A concept is a **node of text** in the composition graph. Concepts are composed, in order, into an agent's context
(its system prompt). Nothing more than that. The text can hold anything: a definition, a rule, a program to run, an SQL
query, a worked example. Concepts differ by what they are about:

| About | Example |
|---|---|
| knowledge | what a booking is; how revenue is counted |
| a program | how and when to use a program, and what it returns |
| UI | the components an answer can use (`:::table`, `:::bar`, …) — one global concept lists them |
| formatting | numbers, units, dates, wording for this project |
| a query | an SQL statement or script the agent runs |

Today's graph has `part` (text), `file` (code placed beside the agent), `setting` (a value) and `domain`. A part is a
concept; the rename and any sub-kinds are part of the migration (below).

### Program

A program is **always a Node.js module and a React module together** (Python runs through a Node wrapper).

- **Node side:** functions that can do more than the agent can — read sources, compute, write, call other services.
  It runs on the engine (on-prem) or in a Worker (cloud).
- **React side:** a `.tsx` component loaded lazily into the user UI when a block or card needs it.
- **Attached to the org knowledge index** at the place it serves, so the builder knows what exists.
- **Scoped** global / group / user, with one owner.
- Used by an agent through a concept that says how to use it.

```jsonc
// program manifest
{
  "id": "prg_trips_settlement", "name": "trips-settlement",
  "scope": "group:operations", "owner": "user:ashish",
  "attachesTo": "org:operations/vehicle-trips",          // node of the org knowledge index
  "node":  { "entry": "server/index.mjs", "exports": ["trips", "settle"], "runtime": ["on-prem", "cloud"] },
  "ui":    { "entry": "web/TripsCard.tsx", "blocks": ["unsettled-trips"] },
  "reads": ["datasource:TOTALGROUP/trip"],               // datasource index nodes
  "version": 3, "hash": "…"
}
```

**OPEN:** who compiles a program, where its node side runs in each build, how it is sandboxed (to be discussed).

### Org knowledge index

A graph of how the organisation is organised: **entities → properties → connections**, and where every capability
(program) attaches. It is for the **builder**, so what it builds stays consistent with what exists. Users never browse
it — they go from an intent straight to an agent.

The **datasource index** sits beside it: which sources exist, what each holds, its type and description, where each
thing comes from.

### Agent

```jsonc
{
  "id": "agt_vendors_hire", "name": "vendors and hire", "scope": "global", "owner": "user:ashish",
  "domain": "dom_vendors_hire",                 // composition-graph domain: its concepts, filtered by scope
  "programs": ["prg_hire", "prg_trips_settlement"],
  "state": { "schema": "…json schema…", "start": { "branch": null, "window": { "kind": "fy" } } },
  "ui":    { "start": "web/Start.tsx", "intents": ["set:branch", "set:window", "add:filter", "remove:filter"] },
  "ica":   "composer"
}
```

A **dashboard is an agent** with more programs and a richer starting UI. A report, a file, a dashboard's contents and
queries are nodes of that agent's domain. Starting from a dashboard means the domain is already picked.

### Session

A session belongs to **one user**. It has:

1. **An agent** to start with. It mostly stays there; it can hop to, or borrow knowledge from, another agent.
2. **The programs** it can use — the agent's, filtered by the user's scope.
3. **One STATE** — a mutable singleton JSON. It holds everything needed to draw what the user sees now. It is not path
   dependent: the same STATE always draws the same view.
4. **Partial org state** — the history of what the user was shown: tables, JSON, markdown, artifacts (files,
   dashboards, reports). Each entry is a slice of the organisation's whole, ever-changing state.
5. **Blocks** — the thread on screen; each block shows partial org state.

```jsonc
// STATE (one per session; shape given by the agent's state schema)
{ "agent": "agt_vendors_hire", "branch": "HYDERABAD", "completed": true, "settled": false,
  "window": { "kind": "fy", "year": "FY 2026-27" }, "view": "unsettled-trips", "page": 1 }

// partial org state entry
{ "id": "pos_17", "at": "2026-10-04T10:12:03Z", "block": "blk_4", "cause": "intent:int_9",
  "stateHash": "…",                                // the STATE it was made from
  "kind": "table", "ref": "data/unsettled-trips.json", "markdown": "365 trips … :::table data/unsettled-trips.json" }
```

**OPEN:** with several blocks on screen, does STATE hold each block's sub-state (`state.blocks[id]`, only the active
one changing), or describe only the latest view while older blocks are frozen partial org state? *Best guess: STATE
holds `blocks[id]` so any block can still be changed in place; history lives only in partial org state.*

**OPEN:** when a session borrows from another agent, does that agent's STATE shape join the session's STATE, or only
its knowledge? *Best guess: knowledge only; hopping starts a new agent's STATE inside the same session.*

### Intent

| Kind | From | Does |
|---|---|---|
| structured | a control in the agent's UI | `set` / `add` / `remove` on STATE — deterministic, no model |
| natural language | the user's words | the ICA reads STATE and the domain, answers with markdown (programs and components embedded by markers), and may return a STATE change and new partial org state |

```jsonc
{ "id": "int_9", "session": "ses_…", "kind": "structured", "ops": [{ "op": "set", "path": "branch", "value": "HYDERABAD" }] }
{ "id": "int_10", "session": "ses_…", "kind": "language", "text": "only last month", "result": { "ops": [{ "op": "set", "path": "window", "value": { "kind": "month", "month": "2026-09" } }] } }
```

**Same view or new block.** If an intent stays within what the current block shows (a filter, a window, a page), it
changes STATE and **replaces** that block's partial org state — no new history entry. If it asks for something the
block does not show, it opens a **new block**. This holds for both kinds: a question can just change a filter, and a
control can open a new block.

### Answer format

The agent answers in **markdown**; rich content is a marker line naming a file or a component:
`:::table data/revenue-for-fy2026.json`. The components a marker may name are listed in one global concept. A
program's React side is a component too.

### Governance

- Every item (concept, program, agent, domain, artifact) has **exactly one owner**, who can edit it.
- **Admins** — global, per group, per program — are hierarchical; they grant access. Even where a scope has several
  admins, each item names one admin, so it is always known who may edit and who may grant.
- Others **suggest**; the owner approves or rejects.
- Nothing is removed. Every change is an entry in an **append-only log**; any past state can be rebuilt (time travel).

```jsonc
{ "seq": 1042, "at": "…", "by": "user:ravi", "item": "prg_trips_settlement", "action": "suggest",
  "from": "hash:a1…", "to": "hash:b7…", "reason": "add broker column", "decidedBy": null }
```

### Storage and builds

- **Platform first.** The composition graph, its concepts, programs, agents and governance log live in the platform
  and are synced to the engine; when the engine is connected both hold them.
- **Two builds of everything:** **cloud** (Cloudflare Worker + Durable Object) and **on-prem** (a Linux, Windows or Mac
  machine, as the engine runs today).
- **Transport:** our own WebSocket through the Durable Object (not a direct socket to the engine).
- **OPEN:** "platform" as system of record = Durable Object storage / D1 / R2? *Best guess: DO storage for logs and
  graph, R2 for program bundles and artifacts.*

### Data warehouse (optional)

Not every project needs one. When it does, one of two, never both at once:

- **Cloud:** Cloudflare R2 (Basin).
- **Local:** a warehouse on the on-prem machine.

Sources land as dated raw snapshots; the warehouse is rebuilt beside the live one and swapped in whole; the app reads
a fixed set of tables; definitions, lineage and coverage are declared once in code.

## The flow

```
intent ──► agent (domain picked; from a dashboard it is already picked)
             │  concepts of the domain  ┐ filtered by
             │  programs of the agent   ┘ global / group / user
             ▼
          session: STATE ◄── structured intent (set/add/remove)
             │        ◄── language intent → ICA → STATE change + markdown
             ▼
          view: same block (replace) or new block ──► partial org state (history)
```

## Applications

- **User UI — the base application, the same for every project.** It gets everything the dashboard has today, plus
  the block · card · thread system (from the SLOB build). From it a person adds concepts, creates agents, and builds
  and publishes dashboards (agents with UIs).
- **Dashboards** extend the user UI with more programs (node + React), built by the builder agent. Same application,
  more specialised.
- Each application is web + backend. Today's `app/server` and `app/web` become the user UI's backend and web, then
  each dashboard's additions.

## The builder agent

Builds programs: writes the node module and the React module, registers the manifest, attaches it to the org
knowledge index, and writes the concept that tells an agent how to use it. It checks what exists in the index first so
it extends rather than duplicates.

## The template (what every project starts with)

Taken from what worked in the SLOB and procurement builds, on our transport and plain CSS:

**Backend**
- one message channel (request / response / event); handlers named `collection.operation`
- named reads only — queries and SQL stay on the server; sort, search, group and page run in the database
- one write path: who → may they → approval if needed → saved as a new version with what it was decided against →
  event to every open screen → log
- the STATE machine: pure operations, a refusal said in a sentence, the next moves derived from STATE
- migrations of two kinds (shape changes every start, dated data changes once), backups, health and version
- users, groups, roles; access checked on every request

**Web**
- the thread of blocks (a tree: going back and choosing differently branches; the URL names the block)
- a block registry: each block says when to use it and what it takes, for clicks and agents alike
- block → cards; filters belong to the block and apply to every card in it
- one data hub with a bounded cache refreshed by server events
- a design system named by meaning (tokens, colour by meaning, no raw colours in components), plain CSS
- one table component (sort, group, search, page built in), charts on library defaults, a loader that waits before
  it shows, empty states that say why

**Rules for agents that build** (template-wide)
- apply a change everywhere it belongs, as a framework, not in one place
- change only what was asked; never remove features — hide them
- click through every flow before handing over; no runtime errors
- no dead ends: every figure, row and chart opens something
- every number comes from the data and reconciles across views
- discuss before building; build only what was approved; answer what was asked
- never work silently for long; keep steps short

**Per-project settings, not rules:** units and scale, rounding, whether zero cells show, money first or quantity
first, wording.

**What agents usually get wrong** (the builder's checklist): applying a change in one place only; removing or
rewriting what worked; handing over flows nobody clicked through; numbers without a source or that disagree; building
more than asked; long silent work; answering a different question; fixing the symptom, not the cause.

## Migration from today

| Today | Becomes |
|---|---|
| composition-graph `part` | concept |
| composition-graph `file` (programs like `trips.mjs`) | the node side of a program |
| `app/server` capabilities / views | programs and the agent's starting UI |
| dashboard (separate app) | an agent with a dashboard attached |
| user UI chat | the user UI with the block · card · thread system |
| `vm/packages/project-template` | replaced by the template above |
| engine as the store | platform first, synced to the engine |

## Order of work (proposed)

1. Agree this document (the OPEN points).
2. Define the JSON schemas: STATE operations, partial org state, program manifest, agent, governance log.
3. The template: user UI with block · card · thread, our transport, plain CSS — lifting the generic parts of the SLOB
   and procurement code.
4. Move one agent (Total Group vendors and hire) onto it end to end.
5. The builder agent; the org knowledge index; governance.
6. Platform-first storage and the cloud build; the optional warehouse.
