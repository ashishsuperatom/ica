# Platform architecture

Status: **design, agreed direction (2026-10-04), not built.** The starting point for the project template. Builds on
`composition-graph.md` (the graph's mechanics) and `identity-and-access.md` (principals, tokens). Marked **OPEN** where
a decision is still to be made.

## In one paragraph

Everything a person uses is an **agent**. An agent is a domain of the composition graph (concepts, composed into its
system prompt), the **programs** it may run, one **STATE**, a starting UI whose controls change that STATE, and an ICA
(the composer) for questions in words. A person works in a **session** with an agent: one STATE that keeps changing,
and the **answer history** — every answer they were given, appended. The **user UI** is the one application every project
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

The graph's node kinds are `concept` (text), `file` (code placed beside the agent), `setting` (a value) and `domain`
(built 2026-10-04: what were `part`s are concepts). Every node has a **scope** (global, group:<name>, user:<id>) and
one **owner**; composing a domain for a viewer leaves out what their scopes do not see. The CLI adds and edits concepts
(`concept`), puts a concept into a domain's composition or takes it out (`join`, `leave`), lists nodes by viewer, and
reads everything **as of any moment** (`--as-of`): content, compositions and scopes — every change, scope changes
included, is in the change log.

### Program

A program is **always a Node.js bundle and a React bundle together** (Python runs through a Node wrapper). Programs are
**immutable**: every version is linked by its hash, never edited in place.

- **Node side:** functions that can do more than the agent can — read sources, compute, write, call other services.
  It runs on the engine (on-prem) or in a Worker (cloud).
- **React side:** loaded lazily; it gives the UI **one or more blocks**.
- **Attached to the org knowledge index** at a path in its tree (`procurement.contract`, deeper as needed), so it is
  known what each program serves and within what.
- **Its contract:** it declares the **slice of STATE it provides** (which can be verified) and the **functions** that
  can be called. A call produces data, takes an action, or produces another view — an answer appended to the session.
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

### What the platform provides to programs

- **The platform ships the common UI** — the table component, ECharts and the design system — and **every program
  uses them**, including lazily loaded ones. A program's React bundle does not carry its own copy: React, the table,
  the charts and the design tokens come from the platform (shared at load time), so all programs look and behave the
  same and stay small.
- **Anything else a program needs** (a map library, say) **goes inside that program's own bundle**, loaded lazily with
  it. Whether a library becomes part of the platform is our decision; a map library, for example, stays in the
  programs that use it, not in the platform.

### Org knowledge index

A graph of how the organisation is organised: **entities → properties → connections**, and where every capability
(program) attaches. It is for the **builder**, so what it builds stays consistent with what exists. Users never browse
it — they go from an intent straight to an agent.

The **datasource index** sits beside it: which sources exist, what each holds, its type and description, where each
thing comes from.

**How agents read the data's shape (2026-10-04).** The system builds the datasource index from each source's catalog
(its bridge's `introspect()`), and agents use only the index: `find-schema` searches it (a field or table by name,
type or meaning) and `get-schema` reads one level of it whole (every source; a source's tables with row and field
counts; a table's fields with type, key, nullability, references and description). Introspection stays in the system
— building the index, connecting a source — but is not a tool of the ICA agents.

### Data sources (being agreed, 2026-10-04)

There may be any number of data sources, of kinds the engine has never seen. So **a data source is a module, not
engine code**: each one exports its functions — `query`, `introspect` (its catalog, from which the system builds the
datasource index), and the rest of its contract (`ready`, its kind and dialect, how to tell a passing failure). That is
the shape bridges already have; what changes is that **nothing dialect-specific stays in the platform** (today's
per-dialect helpers in `packages/introspect` move into the data sources of those kinds).

- **Where it lives:** in the project (`datasources/<id>/`), registered and loaded dynamically by the datasource manager
  — a new source is added by writing (or generating, with the connector agent) its module into the project; no engine
  release.
- **Kinds are templates (decided).** A source of a kind seen before (SQL Server, SuiteQL, Postgres, a REST API…) is
  made by **copying the template of that kind** into the project — an instance — and whatever is specific to that
  system is encoded in the instance. Accepted cost: an improvement to a template does not reach instances already
  copied. We cannot know in advance what is common and what is specific, so it stays clean: everything is a template,
  copied and then used.
- **For agents:** a source is read only through the datasource index (`find-schema`, `get-schema`) and `query`;
  introspection is the system's, not an agent tool.

**Agent tools (2026-10-04).** The tools (`sources`, `find-schema`, `get-schema`, `query`) are platform code: the
engine generates them into an agent's folder, each with its usage line, and that usage is appended to the agent's
system prompt. Which tools an agent gets is part of its domain in the composition graph (`tools: [...]`). `resolve`
(a name to ids, via grounding) is kept in the code but not given to agents for now — how a name becomes ids is being
rethought, perhaps by the data source itself.

**Naming convention (system-wide): `find` searches, `get` fetches one thing whole.** `find-schema` / `get-schema` are
the first pair; every new pair follows it.

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

**The default agent (to design).** Every project has one default agent: a question no other agent fits goes to it.
Its concepts are designed like any other agent's.

A **dashboard is an agent** with more programs and a richer starting UI. A report, a file, a dashboard's contents and
queries are nodes of that agent's domain. Starting from a dashboard means the domain is already picked.

### Session

A session belongs to **one user**. It has:

1. **An agent** to start with. It mostly stays there; it can hop to, or borrow knowledge from, another agent.
2. **The programs** it can use — the agent's, filtered by the user's scope.
3. **One STATE** — a mutable singleton JSON: the state of the **last block**. It holds everything needed to draw it and
   is not path dependent. Earlier blocks are never changed: changing something in an earlier block **creates a new
   branch** from it (the thread is a tree), and that branch's last block has the STATE.
4. **Answer history** — the session's output: each turn's **answer**, appended (named for what it is; earlier called
   "partial org state"). Each answer is a slice of the
   organisation's whole, ever-changing state (tables, JSON, markdown, artifacts: files, dashboards, reports).
5. **Blocks** — a tree; each block shows an answer.

**Session and thread (the user's naming, 2026-10-04).** Everything is called a **session**. A **thread** is a sub-part
of a session: one path through its tree of blocks. Going another way from an earlier block makes another thread in the
same session. How a session is cloned, or another path taken as a session of its own, is not designed yet — be careful
with the two words: the session is the thing; a thread is one path in it.

```jsonc
// STATE (one per session; shape given by the agent's state schema)
{ "agent": "agt_vendors_hire", "branch": "HYDERABAD", "completed": true, "settled": false,
  "window": { "kind": "fy", "year": "FY 2026-27" }, "view": "unsettled-trips", "page": 1 }

// an answer (one entry of the answer history)
{ "id": "pos_17", "at": "2026-10-04T10:12:03Z", "block": "blk_4", "cause": "intent:int_9",
  "stateHash": "…",                                // the STATE it was made from
  "kind": "table", "ref": "data/unsettled-trips.json", "markdown": "365 trips … :::table data/unsettled-trips.json" }
```

**Later:** borrowing from another agent — details to surface after the base version.

### Intent

| Kind | From | Does |
|---|---|---|
| structured | a control in the agent's UI | `set` / `add` / `remove` on STATE — deterministic, no model |
| natural language | the user's words | the ICA reads STATE and the domain, answers with markdown (programs and components embedded by markers), and may return a STATE change and a new answer |

```jsonc
{ "id": "int_9", "session": "ses_…", "kind": "structured", "ops": [{ "op": "set", "path": "branch", "value": "HYDERABAD" }] }
{ "id": "int_10", "session": "ses_…", "kind": "language", "text": "only last month", "result": { "ops": [{ "op": "set", "path": "window", "value": { "kind": "month", "month": "2026-09" } }] } }
```

**Same view or new block.** If an intent stays within what the current block shows (a filter, a window, a page), it
changes STATE and **replaces** that (last) block's answer — no new entry in the answer history. If it asks for something the
block does not show, it opens a **new block**. This holds for both kinds: a question can just change a filter, and a
control can open a new block.

## STATE, packages and intents (being agreed)

### The user's design (2026-10-04)

- Nothing about what a STATE change means may be hard coded: a fixed semantic model can run only one function, and a
  program added later must be able to run its own when its part of STATE changes.
- **The block's STATE holds a list of packages** (just names). Each package says which parts of STATE it controls and
  which function to run for them.
- **A path has exactly one package.** If a program contributes `package.action.stateA` (and `setStateA`), no other may.
- **Each package has one function.** Whenever its part of STATE changes, that function runs. A package injected
  lazily later (an optimisation model, say) works the same way: we know its states, a UI made for it changes them, or
  the agent changes them from words; then the same function runs again.
- **Vocabulary:** `set` / `add` / `remove` on a path, plus calling a package's function with parameters, which changes
  the STATE or gives a new sub-state to set: `{ package: {...} }` replaces that package's part, nothing else.
- **Actions a program suggests** (its custom operations) become the session's list of possible actions.
- **Every package has a small doc module** (`package.doc`), injected into the agent's context; without it the agent
  cannot use the package.
- **Every idea gets a name**, so we can always point back to it.
- **Intents in the UI** can be declarative — `<div sa-intent='{"op":"set","path":"pkg.sku","value":"…"}'>` with one
  listener for every `sa-intent` — or an `onClick`; whichever is more reliable. The vocabulary must be enough for
  everything, and for everything there is a function.

### Proposed answers (to agree)

**Names**

| Name | Is |
|---|---|
| **STATE** | the last block's JSON: `{ packages: { <name>: <program hash> }, <name>: <slice>, … }` |
| **package** | a program taking part in STATE |
| **slice** | the part of STATE a package owns, at `STATE.<package>` |
| **`run`** | the package's **default** function. A program may suggest other functions (its actions); each can do anything. Every one is called with **the whole STATE, immutable**: `fn(STATE) → { slice?, answer?, actions? }`; it may change only its own part |
| **op** | `set` · `add` · `remove` on a path — the only way STATE changes |
| **action** | something a program suggests, shown in the session's possible actions: a function of the package (called with the whole STATE), or just ops |
| **command** | a write outside the session (approve, save a plan): goes through the governance path, not STATE |
| **answer** | what a run or the ICA shows: appended to the answer history (new block) or replacing the current block's |
| **`doc`** | a package's small documentation, injected into the agent |
| **`inspect`** | on every package function: where its implementation is (`package.run.inspect()`) |
| **answer history** | the session's answers, appended — the data from the sources attached to the session |
| **`STATE.agent`** | the ICA's own slice: mostly `question` (the canonical question for this STATE) and `seeing` (what the answer history shows), plus any keys it needs |
| **`<Intent>`** | the UI's one way to change STATE: `ops` and `to="new" \| "current"`; logs and traces each intent |

**What else is needed**

1. **When a package runs again (decided).** Its functions see the whole STATE, so nothing has to be passed. A package
   runs when its own part changes or when one of its actions is invoked (a run button). **Who calls `run`:** every
   program comes with its own UI, which knows its program and keeps calling `run` as its part changes; where an agent
   drives it instead, the agent knows from the package's `doc` to call `run` after changing STATE. **If the program's
   author wants automatic runs**, the package declares the paths it **reads**; a change there (a global filter) re-runs it
   without a click — in dependency order, a cycle refused when the package loads.
2. **Actions (decided).** `run` is the default function, not the only one: a program suggests its actions, and an
   action can be a function that does anything. **Every function gets the whole STATE, immutable** (decided): it can
   read everything — a global filter that is not part of the package still reaches it — but it can change only its
   own part. It returns a new slice (which replaces `STATE.<package>`, nothing else), an answer, or more actions. An
   action can also be plain ops followed by `run`. Example: a global filter is changed, then the program's run button
   is clicked; the program reads the filter from STATE and runs.
   **Like React's `setState`:** a package can set only its own part, never anything outside it. The **engine itself
   enforces this** — a function is handed a frozen STATE and a setter scoped to `STATE.<package>`; any attempt to
   change another part is refused. This is a property of the main engine code, not a convention.
3. **Commands are separate.** Writing something (approving, saving) is not a STATE change; it goes through the one
   write path (who → may they → approval → version → event → log). A package can offer commands beside its actions.
4. **Validation.** Each slice has a schema; an op that breaks it is refused with a sentence, never guessed.
5. **Same view or new block.** Every intent says where its result goes: `current` (replace the current block's answer)
   or `new` (a new block). A control declares it; the ICA decides it for words.
6. **Stale runs.** `run` can be slow; only the result for the latest STATE is applied, earlier ones are dropped; the
   block shows that it is running.
7. **Versions.** STATE names each package by its program hash, so the same STATE always runs the same code.
8. **The doc can be partly generated.** The slice schema, reads and actions are listed automatically into `doc`; the
   author adds only what they mean. It cannot drift from the code.
9. **Intent markup.** A typed helper (`<Intent ops={…} to="new" | "current">`) renders the `sa-intent` attribute and is handled by
   one delegated listener: typed in TSX (no JSON in strings), keyboard accessible, and **every intent on screen can be
   listed** by an agent or a test — the advantage of declarative markup.

```jsonc
// STATE of the last block
{
  "packages": { "scope": "sha:1a…", "trips": "sha:9c…" },
  "scope": { "branch": "HYDERABAD", "window": { "kind": "fy", "year": 2026 } },
  "trips": { "completed": true, "settled": false, "page": 1 }
}
// package manifest (part of the program manifest)
{ "name": "trips", "owns": "trips", "reads": ["scope.branch", "scope.window"],
  "schema": { "completed": "boolean", "settled": "boolean", "page": "number" },
  "run": "node:run", "doc": "doc.md",
  "actions": [{ "id": "unsettled", "label": "Completed, not settled", "ops": [{ "op": "set", "path": "trips.settled", "value": false }] }],
  "commands": [{ "id": "settle", "label": "Settle trip" }] }
// intent
{ "ops": [{ "op": "set", "path": "scope.branch", "value": "PUNE" }], "to": "current" }
```

### Freedom beyond the vocabulary (2026-10-04)

A fixed vocabulary of STATE and functions will meet questions it cannot express. Two ideas keep the user free:

1. **`inspect`.** Every package function has an inspect: `package.run.inspect()` returns **where** its implementation
   is (program hash, file, export) — not the source itself. The agent can read the implementation, and can write a new
   implementation and run it for this session. When that happens often, System 4 (later) or a person notices and
   makes it a variation of the package's actions or state.
2. **The agent's own STATE keys.** The ICA may store any keys it wants in STATE, in its own slice (`STATE.agent`).
   Mostly two:
   - `question` — a **canonical question** that represents the current STATE;
   - `seeing` — a **description of what is in the current answer history**, what the user is looking at.
   STATE is a singleton and the view itself, never dependent on the path that led to it; when the packages' keys cannot
   express where the user is (what an answer said, what to follow up), the agent writes it there — from the
   conversation and the answer history — so nothing is lost.

**Naming, in the user's words:** what was called "partial" or "partial org state" is the data from the sources,
attached to the session, and a history — not one item. It is named for what it is: the **answer history**; each entry
is an **answer**. (Not "session state" — that would be confused with STATE.)

**The `<Intent>` component** (`ops`, `to="new" | "current"`) is the one way a UI changes STATE; inside it every intent is
logged and traced.

### The answer component (kept, 2026-10-04)

The user UI's answer card — the component that renders the JSON answer today, mostly black-and-white text rather than
dashboard styling — is **kept, as one component: the answer component**. It has been built for a long time and has much
that is good: tables with their caveats, the time period, different kinds of formatting, tables hidden until clicked
to see more. When the block · card · thread system comes in, this is not discarded: it becomes the one answer
component of the platform. Where it is used and how its CSS is migrated is decided later.

### Migrations (every database, 2026-10-04)

There are many databases: in the engine (composition graph, datasource index, grounding, agent sessions, …) and in the
Durable Objects' SQLite (project, user, session, state DOs). Every one needs proper migrations, so changes never
become hell to manage. **Agreed — a runner of our own over plain SQL:**

- **One migration runner** for every SQLite database — the same code for `node:sqlite` in the engine and for the
  Durable Objects' SQLite (both are SQLite; we write plain SQL).
- **Migrations are numbered files per database** (`<db>/migrations/0007-add-owner.sql` or `.ts` for a data change),
  applied in order on open, each recorded in the database's own `_migrations` table (id, name, hash, applied at).
- **Never edited once shipped**; a change is a new migration. No down-migrations: a backup is taken before pending
  migrations run, and restoring the backup is the way back.
- **A database written by newer code is refused** with a sentence, so an old engine never corrupts it.
- **A test** opens an empty database and an old fixture of each, runs every migration, and checks the result.
- **Never per request (built 2026-10-04, `@superatom/migrate`).** The engine migrates a database once, when it opens
  it; a Durable Object migrates in its constructor inside `ctx.blockConcurrencyWhile`, once per wake. When nothing is
  pending that once is a single-row read (the last applied migration's id and fingerprint against the code's last);
  the full record is compared only when something is pending, and by `verifyMigrations` in tests.
- The alternative is a standard tool (Drizzle's migrations work for both SQLite and Durable Objects, but bring an ORM
  and its schema language); a small runner of our own over plain SQL is the recommendation.

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

### Programs: from source to every engine (built 2026-10-04)

1. **Source in, built once.** A person or agent sends a program's source (`program:build`); the engine — the one place
   that compiles — builds it (TypeScript, per file) and sets the manifest's owner to whoever asked.
2. **Kept by the platform.** The engine uploads the built program as one **bundle** (its files and hash) with the
   project's key; the platform recomputes the hash with the same code (`programs/src/bundle.ts`, no file system), keeps
   the bundle in R2 at `programs/<project>/<hash>.json` and records it in the project's **catalogue** (ProjectDO).
3. **Draft, then published.** A new program is its builder's draft; its owner (or an admin) publishes it, once.
   Uploads and publishing are in the audit history.
4. **Run anywhere.** An engine runs only programs in its store; one it lacks it fetches from the platform — by hash, or by
   name the newest published — and checks against the hash before keeping it. A damaged bundle never runs.

**One engine per project (the user, 2026-10-05):** a project has one engine, and programs are built inside it, because
that is where the agent is. Building a program anywhere else is not designed for now. Fetching a program by hash from
the platform is for that one engine when its machine is replaced (a new box, a lost disk), not for several engines.

*To agree:* the earlier design kept unpublished programs in the user's DO; drafts are in the project's catalogue instead
(one place to check, publish and audit), with the owner on every row. The user DO can list a person's drafts from it.

### Usage, credits and payment (built 2026-10-05, payment planned)

- **Metered where it happens:** the model proxy reads every call's tokens (streamed or not) and the project's DO keeps
  each as a usage event, append-only, priced at that moment.
- **Prices are data:** the platform's price list (credits per million tokens, per provider and model, `*` for a
  provider's other models) lives in the GlobalDO, every version kept with who set it; a superadmin edits it. A call
  with no price is recorded at no cost and counted as unpriced, so the gap shows.
- **Credits per organisation:** an append-only ledger in its OrgDO — grants (+, by the platform only) and its projects'
  usage (−), in integer micro-credits. An organisation never given credits is not on a plan and is not limited; one
  that has used them all is refused new questions and session intents with a sentence, recorded in the audit history.
- **Payment through Stripe (the user, 2026-10-05).** *Planned:* a Stripe checkout that adds credits (its webhook
  writing a grant to the organisation's ledger, recorded in the audit history), invoices, per-plan limits, and metering
  beyond model tokens (engine time, queries).

### Work in the background, visible (built 2026-10-05)

In the user's words, the data protocol must show people what an agent is doing in the background. Anything long the
engine does — a program build, a session's run, later the builder agent's work — is an **activity**: what it is, whose
it is, its state (running, done, failed) and progress. The hub keeps each activity's latest state and sends it to its
owner's connections and the project's admins; anyone connecting in the middle asks `activity:list` (theirs; an admin's,
everyone's). `sacli activity` shows it; the user UI is next.

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

### Customer data warehouse — stopped (2026-10-05)

**Flagged and stopped, in the user's words:** if a proper, Fabric-like warehouse per customer cannot be built on
Cloudflare, it is not built half-heartedly; something else will be thought of. The limitation: an account has at most
20 Pipelines streams/sinks/pipelines, so per-customer streams do not scale. The proposal below is kept for reference
only.

### The platform's own data warehouse (being built, 2026-10-05)

**In the user's words:** for our own system, a full data warehouse of everything that happens — in one place, so it can
be queried, agents can be trained on it, and analysis done that is impossible while every Durable Object keeps its own
data separately. One recorder in the platform's code, one stream (`platform_records`: kind, project, key, time, the
record as JSON) fed by every DO — audit, usage, sessions, graph records, activities, programs, credits — into Iceberg
tables in the platform's Basin Catalog, read with Basin SQL. One stream for all kinds stays far inside the 20 limit.

### Data warehouse — design proposal (2026-10-05, kept for reference)

- **Engine side first:** a per-project warehouse (DuckDB, columnar) that materialises source queries into tables — fast,
  and available when a source is slow or down. It is a **data source template** copied into the project home
  (`datasources/warehouse/bridge.mjs`), so it is queried through the datasource manager like any source: the same SQL
  rewrite, data access policies and audit.
- **Lineage and policies, fail closed:** every warehouse table records the source and query it came from. A reader with
  any policy on that source cannot read the copy unless the warehouse table has policies of its own — otherwise a copy
  would be a way around a row filter.
- **Size:** agent reads stay capped (≤ 100 shown, the manager's 5,000 cap); materialising reads the source in pages
  through the checked path (SELECT-only), never the uncapped system path with someone's SQL.
- **Who refreshes:** a project admin or an agent key with a `warehouse` scope; each refresh is an activity and audited.
- **Platform side (Basin):** one Basin Catalog namespace per organisation, Iceberg tables per project; the engine's
  DuckDB writes them (Iceberg extension) and the platform reads them with Basin SQL. Needs a Basin Catalog API token
  (made once in the dashboard); and since an account has at most 20 Pipelines streams, tables are written directly, not
  through a stream per customer.

### Data warehouse (optional)

Not every project needs one. When it does, one of two, never both at once:

- **Cloud:** Cloudflare R2 (Basin).
- **Local:** a warehouse on the on-prem machine.

Sources land as dated raw snapshots; the warehouse is rebuilt beside the live one and swapped in whole; the app reads
a fixed set of tables; definitions, lineage and coverage are declared once in code.

### The Superatom CLI and agent API keys (2026-10-04)

**In the user's words:** the engine no longer runs a local WebSocket, which is right — nothing will use one. Instead
there is a **Superatom CLI** (`sacli`), so an agent can connect to our system. On the backend it has **its own
WebSocket connection**, just as the engine, the data bridge, and the runtime (the user from the front end and from
iOS) connect: another kind of connection, where an agent connects and we run commands through it. Codex or any coding
agent — or any human — can run this CLI and do a lot on behalf of the **agent API key**. Agent API keys are generated
from **the project admin, for each project**. Everything about creating keys and their security is taken care of.

The CLI is for agents outside the Superatom platform: a person with their own agent uses the CLI to do things. We use
it too: instead of connecting directly, our own agents launch the CLI as a package. It is a separate part of the
system — a proper, production CLI with the features CLIs normally have — called the Superatom CLI, `sacli`.

### Data access per reader (built 2026-10-05)

In the user's words: we need to know the user, or there is no authorization; every user has an authorization attached,
enforced through the SQLGlot system. **Policies** live in the project's DO: for one source and table, a **row** filter
(a predicate with `{t}` for the table), a **deny**, or a column **mask**; each applies to everyone, a role, one person
(by email) or one agent key. A predicate may name the reader's **attributes** (`{t}.branch IN {attr.branches}`),
rendered as SQL literals; a missing attribute denies the table (fail closed). The engine carries the reader with each
session intent (an async context), resolves their policies through the hub (cached until the platform says they
changed), and sends them with every query; the datasource manager's rewrite applies them to every table read.
**Agents' own tools (built 2026-10-05):** at the start of each chat turn the engine writes the asker's resolved policies
beside the turn (`.reader.json`); the data seam every agent tool and script uses sends them with each query; policies
that cannot be resolved mean nothing is read. *Limit:* agents run as the same OS user with file access, so one could
deliberately bypass this — closing that needs sandboxing (dynamic workers, later); what is guaranteed now is that no
answer leaks another reader's rows by accident.

**Agents, not the CLI, in the user's words:** the CLI's details belong nowhere in the backend — not in the Worker or the
Durable Objects. The backend knows only **agent keys** and the **agent** connection, in one place; any system can use
them, and the CLI is our version, which people install to connect to Superatom and make their changes. Some things go
over the agent's WebSocket; others are plain HTTP with the agent key — creating and editing domains and concepts,
making suggestions, creating and uploading programs, and more that usage will show is missing.

**The CLI keeps its connection:** a command does not connect and disconnect each time. The first command connects, and
the connection stays ready for about an hour, each command resetting the timer (never forever); `sacli disconnect`
ends it, which is useful for testing. To its user it is a normal CLI, though everything goes over the WebSocket inside.

**What the CLI is for, in the user's words:** once the product is built, the user builds it alone and gives team
members the CLI: "use your own agent, do whatever you want to do" — create concepts, create things, including create
a project. Install it the way people do: a `curl` to an install address on the domain installs the package. The engine
itself should install like that too — perhaps first the CLI, then the Superatom backend through it, configured for a
project. The CLI is multi-purpose, primarily for AI agents.

**Releases, in the user's words:** the R2 bucket holds several versions of the engine, with one always marked
latest, so an install takes the latest by default; the CLI is there too, built separately for Windows, macOS and Linux.
An install script at `install.superatom.site` or `superatom.site/install` is a shell script that downloads the right
build for the machine; the engine is mostly Docker based, so that is what gets downloaded and installed.

*Proposal (to agree):* `curl -fsSL https://superatom.site/install | sh` installs `sacli`; `sacli engine install`
installs and configures the engine for a project. Creating a project is an organisation's act, so it needs a key
above the project — an organisation key — which is still to design.

### Audit history and observability (2026-10-04)

A separate concern from the CLI, and it covers **everything**. **In the user's words:** whether something is done
through the CLI, from the user interface, or by the engine — every way — it is audited: a **full audit history of
what has happened**, a list of who made what changes, and everything, **including who asked what question**.

It is a huge piece of work. The audit history goes to a different place, a data warehouse. There are two kinds of data
warehouse: one where users put their own data (project specific, above), and **the platform's and engine's own**, where
we log everything and trace — for our own analytics, to see how things work and which agent did what. Some actions go
through a Durable Object, which records them; some happen in the engine, which records them separately. Proper
observability, **through Cloudflare only** — no third party: their recent products for observability, tracing, SQL over
R2 (the data lake product), the analytics engine, and stream processing through Workers.

**Three things, no duplication (asked 2026-10-05):** the audit history is the *meaning* — who did what — recorded once by
the project's DO and kept for years; Workers Logs and Traces are the *mechanics* — each request's timing and errors —
written by Cloudflare itself and kept for days, for debugging; Analytics Engine keeps *counts* of audit events for
instant dashboards (the only overlap: counts the audit history could also give).

**The design (researched 2026-10-04 — Cloudflare's data stack went GA as "Basin" that week):**

| Purpose | Where |
|---|---|
| The audit history — every action, append-only, queryable by SQL for years | Basin Pipelines (a stream, schema-checked) → an Iceberg table in Basin Catalog (R2) → Basin SQL |
| The project's own record, immediate | the project's Durable Object keeps every audit event in its SQLite, append-only (the stream reaches SQL after 1–5 minutes, and a failed send must not lose an event) |
| Near-real-time metrics (latency, errors, per project) | Workers Analytics Engine (3 months) |
| Traces and logs of the Worker and Durable Objects | Workers Traces and Logs (`observability` in wrangler.jsonc) — written by Cloudflare automatically, never by us |

- **One event shape** (`AuditEvent` in platform-types): who (user, agent key, engine, system), via (ui, admin, agent,
  engine, api, channel, system), action `<thing>.<verb>`, target, outcome (ok, refused, error), detail (a question's
  words, an intent's ops, a refusal's reason).
- **One path, in the user's words (2026-10-05):** all audit comes from the same place, never from two — however a
  change is made and by whichever method, there is one path. That place is the **project's Durable Object**: every
  message a person or agent sends passes its relay, and every HTTP call passes its one gate, which records a call that
  changes something exactly once — the handler's own event when it has one (`agent-key.create`, `program.publish`, …),
  else the call itself. The Worker only says who the caller is (`x-sa-actor`, from the token it checked); it records
  nothing.
- **The engine's events come in through our own ingest endpoint**, signed with the project's key; the Worker stamps
  which project and engine sent them (never trusting the body), checks them against the schema (a stream drops a bad
  event silently), and writes them to the same stream. Engines buffer and retry; `id` makes a retry harmless.
- Writers hold only the right to send; nothing at runtime can change or delete the history.
- **Built (2026-10-05):** in the platform's own Cloudflare account — stream `audit_events` (schema-checked) → pipeline
  `audit` → sink `audit_r2`: Parquet in R2 bucket `superatom-platform` at `audit/events/year=/month=/day=`, every project's
  events in one stream, each tagged with its project. It is the **platform's** Basin, never a customer's warehouse.
  Bound to the Worker as `AUDIT` (with Analytics Engine `METRICS`). *Next:* an Iceberg table in Basin Catalog for Basin
  SQL — it needs a catalog API token made once in the dashboard.

**Where each record lives, in the user's words (2026-10-04):** the **session Durable Object** has SQLite and keeps
everything that happens in that session. The **user Durable Object** keeps information about the user and what is
theirs — a module they build, all their work — and, per user, the state and information needed to give **a very
personalised view to that user**. "Something I have been dreaming of for some time but never implemented": the user DO
is essential; what exactly it keeps is not decided yet, but it is going to be important. So much is already recorded
where it happens (session, user, project). For **general-purpose analytics — not real time; five or ten minutes late
does not matter** — everything also goes into **the Superatom platform's own Basin**. That is a different thing from
the data warehouse each customer or project gets.

**The customer's warehouse (to design):** perhaps at the **organisation** level, with each project taking what it needs
from it. How to scope one Cloudflare Basin across many customers is the open question; if it is just a namespace in an
R2 bucket, and R2 scales to any number of customers, that is fine. *Proposal (to agree):* one Basin Catalog namespace
per organisation (tables per project inside it), every read and write through the platform's own API, which checks the
caller's scope — no customer or agent ever holds a Cloudflare credential. A bucket per organisation is the stronger
separation if a customer needs it.

**Structure, in the user's words:** design everything so that it is structured and flows from high level to low level,
with a hierarchy in the ideas — not things plugged in at random. Just as the organisation has its knowledge index, the
platform itself should have an organisation of how things are built, and that index should be maintained — in the
source code, or in the folder and module structure.

## The flow

```
intent ──► agent (domain picked; from a dashboard it is already picked)
             │  concepts of the domain  ┐ filtered by
             │  programs of the agent   ┘ global / group / user
             ▼
          session: STATE ◄── structured intent (set/add/remove)
             │        ◄── language intent → ICA → STATE change + markdown
             ▼
          view: same block (replace) or new block ──► answer history
```

## Applications

- **User UI — the base application, the same for every project.** It gets everything the dashboard has today, plus
  the block · card · thread system. From it a person adds concepts, creates agents, and builds
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

Taken from what worked in earlier builds, on our transport and plain CSS:

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

**What STATE must be able to do** (the kinds of change seen across the systems built so far):
- change a parameter and re-run a program (an optimisation with a new rate);
- change a filter or a period, and the view follows;
- start from an empty STATE; a question in words goes to the composer, which returns a new STATE and an answer;
- ask questions, and also change STATE through the controls of a deterministic UI.

**The organisation's state:** the organisation has one big state that keeps changing over time. Each user has a partial
view of it; in a session, a smaller view still ("the top 10 customers by revenue" is one such slice). An answer
appears after every intent — structured or in words — many times in a session.

**The starting UI** is designed in advance for each agent; its controls are hard-coded structured intents
(set / add / remove on STATE).

**The ICA** (the composer) takes words, runs analysis or finds the answer, and replies with markdown (programs and
components embedded) — an answer.

**Same view or new block, in the user's words:** a structured intent sometimes does not make a new block — a filter
changed inside a dashboard just modifies it, with no history; it replaces the previous answer. A question
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
and "these functions you can call"; it produces data, does an action, or generates another view — an answer appended
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

**Rules:** the platform's rules are general. Units, scale and whether zero cells show are per-project settings; and the
builder must know what agents usually get wrong. Project-specific versions of an idea do not belong in this document.

## The whole product, built deterministically (2026-10-04)

The user, in their words: this time the entire platform is built properly, once and for all — every deterministic
part — and only then the non-deterministic part (the agents, which depend on the model, the time, the concepts and
the domain, and which already work) is tested. Each part gets quick, real tests; none needs an AI agent or a model.

In scope, beyond what is above:

- **User authorization and the permission system** — users, groups, roles, scopes, owners and admins (above), enforced
  at one place.
  **In the user's words (2026-10-04):** we need to know the user on everything — without that there is no authorization.
  Every user has an authorization attached to them, and it is enforced on the data through the SQLGlot (Python)
  system that already rewrites every query: a user's policy rewrites what their queries may read. So every message
  reaching the engine names its user, stamped by the hub (never taken from the payload).
- **Enterprise: single sign-on** — how an organisation adds its own identity provider (see `identity-and-access.md`).
- **Payment, credits, usage** — a credit system and metering of who uses how much.
- **The data protocol, fixed for everything** — including many users at once, and showing people what an agent is
  doing in the background.
- **A data warehouse like Microsoft Fabric or Databricks** — on the engine side and on the Durable Object side, with
  R2 SQL.

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
| project homes only under `~/.superatom/state/<projectId>` (the old in-repository `vm/projects` is gone) | — |
| a port per project (data source manager, engine) | one set of ports, every request scoped by project |

## Order of work (proposed)

1. Agree this document (the OPEN points).
2. Define the JSON schemas: STATE operations, the answer, program manifest, agent, governance log.
3. The template: user UI with block · card · thread, our transport, plain CSS — lifting the generic parts of earlier
   builds.
4. Move one existing agent onto it end to end.
5. The builder agent; the org knowledge index; governance.
6. The DO hierarchy (user, session, state) and engine ↔ platform sync; the optional warehouse.
7. Project scoping on shared ports, so the system runs without Docker (Windows, macOS, Linux, Electron).
8. Programs in dynamic workers (later).
