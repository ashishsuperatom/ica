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

A program is **always a Node.js bundle and a React bundle together** (Python runs through a Node wrapper). Programs are
**immutable**: every version is linked by its hash, never edited in place.

- **Node side:** functions that can do more than the agent can — read sources, compute, write, call other services.
  It runs on the engine (on-prem) or in a Worker (cloud).
- **React side:** loaded lazily; it gives the UI **one or more blocks**.
- **Attached to the org knowledge index** at a path in its tree (`procurement.contract`, deeper as needed), so it is
  known what each program serves and within what.
- **Its contract:** it declares the **slice of STATE it provides** (which can be verified) and the **functions** that
  can be called. A call produces data, takes an action, or produces another view — a partial appended to the session.
- **Scoped** global / group / user, with one owner.
- Used by an agent through a concept that says how to use it.

```jsonc
// program manifest
{
  "id": "prg_trips_settlement", "name": "trips-settlement",
  "scope": "group:operations", "owner": "user:ashish",
  "attachesTo": "operations.vehicle-trips",              // path in the org knowledge index tree
  "state": { "provides": { "branch": "string", "completed": "boolean", "settled": "boolean" } },  // its slice of STATE
  "functions": [{ "name": "trips", "returns": "data" }, { "name": "settle", "returns": "action" }, { "name": "openTrip", "returns": "view" }],
  "node":  { "bundle": "r2://programs/<hash>/node.mjs", "runtime": ["on-prem", "worker"] },
  "ui":    { "bundle": "r2://programs/<hash>/web.js", "blocks": ["unsettled-trips", "trip"] },
  "reads": ["datasource:TOTALGROUP/trip"],               // datasource index nodes
  "version": 3, "hash": "…"
}
```

**Where programs live.** The bundles are in **R2**; their metadata is in the **project DO**. A program a user made and
has not published lives only in their **user DO**; once submitted and accepted it is added to the project DO, and the
user DO marks it published. Programs are created in the engine, so they are also in its file system.

**Where programs run.** Now: in the engine on the VM. Later, as users grow: in a **dynamic worker**, reaching data
sources through our WebSocket datasource bridge. Running locally in the VM stays an option. (The dynamic worker is not
started yet.)

**Build and isolation.** We compile programs ourselves (TypeScript, `tsc`). They are not sandboxed now; when a
sandbox is needed it is only ever the dynamic worker.

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
3. **One STATE** — a mutable singleton JSON: the state of the **last block**. It holds everything needed to draw it and
   is not path dependent. Earlier blocks are never changed: changing something in an earlier block **creates a new
   branch** from it (the thread is a tree, as in the SLOB build), and that branch's last block has the STATE.
4. **Partial org state** — the **session output**: each turn's answer, appended. Each entry is a slice of the
   organisation's whole, ever-changing state (tables, JSON, markdown, artifacts: files, dashboards, reports).
5. **Blocks** — the thread on screen, a tree; each block shows partial org state.

```jsonc
// STATE (one per session; shape given by the agent's state schema)
{ "agent": "agt_vendors_hire", "branch": "HYDERABAD", "completed": true, "settled": false,
  "window": { "kind": "fy", "year": "FY 2026-27" }, "view": "unsettled-trips", "page": 1 }

// partial org state entry
{ "id": "pos_17", "at": "2026-10-04T10:12:03Z", "block": "blk_4", "cause": "intent:int_9",
  "stateHash": "…",                                // the STATE it was made from
  "kind": "table", "ref": "data/unsettled-trips.json", "markdown": "365 trips … :::table data/unsettled-trips.json" }
```

**Later:** borrowing from another agent — details to surface after the base version.

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
changes STATE and **replaces** that (last) block's partial org state — no new history entry. If it asks for something the
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

- **The platform is the source of truth; the engine is a replica.** Sync runs immediately whenever the engine is
  connected, and everything important is always synced to the local system as well.
  - **Engine → platform** (made in the engine): sessions and conversations, programs, dashboards.
  - **Platform → engine** (made in the platform): domains and their concepts.
  - Later, local copies may be evicted (long-unused users' sessions) and synced back when needed. Not now.
- **Durable Objects, in a hierarchy: org → project → user.**

  | DO | Holds |
  |---|---|
  | org DO | the organisation |
  | project DO | the project's published things: domains, concepts, program metadata, agents, governance log |
  | user DO | everything of one user: their sessions (a list of every one), their agents and programs not yet published. An admin promotes them to the project/org. |
  | session DO | one per session: every intent, output and log, in DO SQLite |
  | state DO | the **decision state** (below) |

- **Two builds of everything:** **cloud** (Cloudflare Worker + Durable Object) and **on-prem** (a Linux, Windows or Mac
  machine, as the engine runs today).
- **Transport:** our own WebSocket through the Durable Object (not a direct socket to the engine).
- **R2** holds program bundles and artifacts.

### Decision state

Not the session's STATE: the core of decision intelligence, to be expanded later. For now:

- A state keeps a **memory of the data that has passed through it**.
- A state is a **collection of other states** that can be part of it (what we first thought of as selectable programs
  are really states).
- For each, it holds the **possible outcomes, functions, actions or paths** the user can take, and the **reasoning**
  behind each.

### Running it: with and without Docker

- **Primary:** a Linux machine running Docker.
- **Also:** without Docker, on Windows, macOS or Linux, and inside an Electron application.
- In Docker nothing changes: the container isolates the project, and the project id is all there is.
- Without Docker, projects share one machine, so the **engine side** gives each project its own addresses — nothing
  changes on the platform. The rule is consistency and safety:
  - **Allocate on create/start:** every service a project needs (engine, data source manager, a Postgres, …) gets an
    address from a **registry** of allocations on the machine.
  - **Never collide:** before using an address, check nothing is listening there (and it is not allocated); otherwise
    take the next one.
  - **Release on shutdown:** stopping the project frees its addresses in the registry.
  - **No hand-picked ports:** nobody opens or changes a port per project by hand.
- Two ways to give addresses, both acceptable:
  - **A loopback IP per project** with default ports: `127.0.0.2:4001`, `127.0.0.3:4001`, Postgres at `127.0.0.3:5432`.
    Nothing conflicts with default installs. Works on Windows and Linux (all of `127.0.0.0/8` is loopback); **macOS only
    answers on `127.0.0.1` unless each alias is added (`ifconfig lo0 alias`, needs admin).**
  - **Ports from the registry** on `127.0.0.1` (project 1's data source manager at `127.0.0.1:4008`, …). Works everywhere
    without admin rights. *Recommended for that reason.*

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

## Details from the discussion (kept so nothing is lost)

**What STATE must be able to do — the four systems we have built:**
- *Procurement (proc):* "what if we change the rate to 5% and run the optimisation again" — a STATE change that re-runs
  a program.
- *SLOB:* "filter SLOB by plan A for last month" — only a STATE change.
- *Fusion5:* start from a STATE `{}`; a natural-language intent goes to the composer, which returns a new STATE and a
  partial org state.
- *Total Group:* ask questions, and also change STATE through the controls of a deterministic UI.

**The organisation's state:** the organisation has one big state that keeps changing over time. Each user has a partial
view of it; in a session, a smaller view still ("the top 10 customers by revenue" is one such slice). Partial org state
appears after every intent — structured or in words — many times in a session.

**The starting UI** is designed in advance for each agent; its controls are hard-coded structured intents
(set / add / remove on STATE).

**The ICA** (the composer) takes words, runs analysis or finds the answer, and replies with markdown (programs and
components embedded) and a partial org state.

**Same view or new block, in the user's words:** a structured intent sometimes does not make a new block — a filter
changed inside a dashboard just modifies it, with no history; it replaces the previous partial org state. A question
asked only to change a filter also stays in the view. A very different question, outside what the view shows,
makes a new block — still within the same agent.

**Agents and the user UI:**
- From the user UI a person can add concept nodes and create agents; agents are used inside the user UI or a
  dashboard.
- A dashboard is something done more often, so it is a more specialised version of the user UI — maybe extra code and
  UI, but the same application. Nothing is called a dashboard any more: it is an agent with a dashboard attached.
- Dashboards can be built from the user UI and published.
- Today's `app/server` and `app/web` must exist for each dashboard — and first for the main application, the user UI.
- A project has global / group / user programs and many dashboards (agents), each scoped global / group / user too.
  The composition graph is filtered by the same scopes.
- Everything starts from an intent → pick a domain → that gives the domain's concepts and its programs, both filtered
  by global / group / user. Starting from a dashboard, the domain is already picked; its contents and queries are
  appended to the domain. A report, a file or any artifact is likewise a node in the domain's composition graph.

**Programs, in the user's words:** a program attaches at a path of the org knowledge index — e.g. in procurement,
`procurement.contract`, deeper as needed (always a tree). It provides "this part of the state", which can be verified,
and "these functions you can call"; it produces data, does an action, or generates another view — a partial appended
to the session. Groups (finance, marketing, any name the organisation gives) have a function that assigns users.

**Governance, in the user's words:** there is an owner for each thing, and admins — one for each program, each group,
and the global level — hierarchical, granting access to others; few dependencies. Even with several admins in a group
or globally, each item is attached to exactly one person, so it is always known who may edit and who may grant;
never a conflict over who approved or who created it. Others suggest; the owner approves or rejects. Everything can be
time travelled: nothing removed, an immutable append-only log.

**Storage, in the user's words:** today sessions are stored in the VM's file system, which is fine, but it will not
scale: users who stop using it keep their sessions while new users run out of space. At some point (not now) local
files can be deleted and synced back when needed. Sessions, conversations, programs and dashboards go engine →
platform (they are made in the engine); domains and concepts go platform → engine (made in the platform). Programs also
stay in the VM's file system, where they are made.

**Running programs:** best is to run them in the VM, but with many users that hits the same limit — hence dynamic
workers later, reaching data sources through the WebSocket datasource bridge, with running in the VM always an option.

**Rules:** the rules taken from SLOB and procurement must be general. Units (crore with decimals) and whether zero cells
show are per-project; and the builder must know what agents usually get wrong.

## Operations today (inventory, 2026-10-04)

What each built system lets a person do — the names as they are in the code.

### SLOB (Dabur) — `app/server/src/model/state.ts`, `app/web/src/runtime/thread.tsx`

*Question:* `{ focus, where: [{dim, op: is | is not, value}], by?, as?: table | ring | bars | tree }`.

| Operation | Does |
|---|---|
| `push {dim, value, not?}` | add a filter (or "is not") |
| `pop {dim}` | remove a dimension's filter |
| `clear` | remove all filters |
| `by {dim?}` | break down by a dimension (none = the whole) |
| `as {lens}` | draw as table / ring / bars / tree |
| `focus {on}` | look at something else, keeping the filters it honours |
| `drill` | one level down what is broken down |
| `up` | undo the innermost narrowing |

*Thread:* `start(type, props)` · `open(fromId, type, props, cause)` (new block below) · `update(id, props)` (same block)
· `become(id, type, props)` (block turns into another type) · `remove(id)` · `openAsked(question, ops, cause)` ·
server `model.ask {question, ops}`. Rule: looking closer at the same thing stays in the block; moving to another thing
or taking a decision opens a block. Linear thread (no branches).

*Commands (writes):* `plans.create` · `plans.update` · `plans.setStatus` · `plans.review` · `plans.reply` ·
`reasons.set` · `master.save` · `master.setActive` · `master.setting` · `master.assign` · `master.delete` · `users.save` ·
`users.setActive` · `users.setPassword` · `sources.switch` · `pipeline.refresh` · `drops.apply` · `drops.setKey` ·
`backups.now` · `system.upgrade` · `system.rollback`. *Reads:* `queries.run` · `model.ask` · `meta.get` ·
`master.lists` · `master.settings` · `master.usage` · `users.list` · `users.planners` · `definitions.list` ·
`pipeline.lineage` · `sources.list` · `backups.status` · `backups.read` · `system.status` · `drops.status` ·
`explorer.catalog | rows | values | locate | profile | spread`.

### Procurement (Tata Chemicals) — `data-system/src/model/state.ts`, `app/src/runtime/{thread,intent}.ts*`

*Question and operations:* the same as SLOB (`push · pop · clear · by · as · focus · drill · up`).

*Intent:* `drill(open, question, ops)` — the server picks the block that answers and opens it below · `refine(update,
question, ops)` — change the current block in place · `nextActions(question)` (server `intent.next`) — the moves that
advance the goal, shown under every block.

*Thread:* `start` · `open` · `update` · `remove` · `switchBranch(childId)` — a tree: opening from an earlier block forks,
the old branch kept as a sibling.

*Optimizer transforms (STATE changes that re-run a program):*
- award: `setWeights` · `capSupplier` · `uncapSupplier` · `floorSupplier` · `forceInclude` · `excludeSupplier` ·
  `setMinSuppliers` · `setMaxSuppliers` · `setMaxHighRiskPct` · `overrideBid` · `setCapacity` · `setDemand` ·
  `setCompliantOnly`
- buy or defer: `setPriceForecast` · `setHoldingRate` · `setHorizon` · `setStockoutPenalty` · `setOrderQty`
- then `optimizer.run(kind, params, actions)` replays the actions and runs; `options()` gives the next choices.

*Commands:* through the governance kernel (`award.recommend` and others), each with permission, resource and effects.

### Fusion5 and Total Group dashboards — `app/server/state.mjs`, `app/web/src/runtime/thread.tsx`

*Question:* `{ focus, where, by?, as?, window?, assume?, pages? }`.

| Operation | Does |
|---|---|
| `push · pop · clear · by · as · drill · up` | as SLOB |
| `focus {on}` | another view, keeping the filters it honours; the window travels where it means the same (a drill keeps its time span) |
| `window {window}` | the time the view is over (a parameter, not a filter): months, weeks, a financial year, a range, … |
| `assume {name, value}` | a what-if, recorded with the answer |
| `page {table, page, order}` | which page of a table, in which order |

*Messages to the app:* `app:catalog` · `app:start` · `app:move` · `app:ask` · `app:members` · `app:about` · `app:say`
(a question in words, answered by the thread's reader) · `app:reload`.

*Thread:* `start(focus, where)` · `home()` · `open(fromId, ops, cause)` · `edit(id, ops)` (same block) · `say(text)` ·
`openAbout()` · `remove(id)` · `switchBranch(childId)` · `siblingsOf(id)` — a tree, like procurement.

## Migration from today

| Today | Becomes |
|---|---|
| composition-graph `part` | concept |
| composition-graph `file` (programs like `trips.mjs`) | the node side of a program |
| `app/server` capabilities / views | programs and the agent's starting UI |
| dashboard (separate app) | an agent with a dashboard attached |
| user UI chat | the user UI with the block · card · thread system |
| `vm/packages/project-template` | replaced by the template above |
| engine as the store | platform is the truth, the engine a replica; sessions and programs synced up, domains and concepts synced down |
| a port per project (data source manager, engine) | one set of ports, every request scoped by project |

## Order of work (proposed)

1. Agree this document (the OPEN points).
2. Define the JSON schemas: STATE operations, partial org state, program manifest, agent, governance log.
3. The template: user UI with block · card · thread, our transport, plain CSS — lifting the generic parts of the SLOB
   and procurement code.
4. Move one agent (Total Group vendors and hire) onto it end to end.
5. The builder agent; the org knowledge index; governance.
6. The DO hierarchy (user, session, state) and engine ↔ platform sync; the optional warehouse.
7. Project scoping on shared ports, so the system runs without Docker (Windows, macOS, Linux, Electron).
8. Programs in dynamic workers (later).
