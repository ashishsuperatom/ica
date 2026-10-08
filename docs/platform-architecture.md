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

### Permissions — who may do what (being built, 2026-10-05)

**In the user's words:** we have a hierarchy. There is an **organisation**; the organisation has a **super admin of the
organisation** and **admins**, and the organisation creates **projects**. The organisation can have **users who have
special access to the data warehouse**, and inside that there is more — **who can create what**. If this permission
system is not built, build it: rethink the whole permission system of the entire platform — who is given access to do
what. **A solid permission system for everything** — and only then the ability to create warehouse tables and do things
through the CLI.

**What was there (surveyed 2026-10-05):** four role ideas that did not line up — the platform's `superadmin`, the
organisation's `admin|user`, the project's `admin|member|viewer` (whose permissions were stored and never checked), and
one `admin` flag every check collapsed into; agent-key scopes beside them; principals named three ways. Holes it left:
a viewer could ask; any member read the organisation's people, conversations, credits and warehouse queries, and every
person's usage in a project; a new concept could be made `global` without anyone publishing it; history and
suggestions of hidden concepts were readable; a project's admin could let in people the organisation never added
(members, unverified domains); releasing a domain took any project's address.

**The model.** Three levels, one vocabulary of **capabilities**, roles as named sets of them:

| Level | Who | Built-in roles |
|---|---|---|
| Platform | the platform's superadmin | — (holds everything; alone: credentials, prices, credit grants, organisations, engine profiles, service tokens) |
| Organisation | its people (the org list decides who exists) | **owner** (everything in the org, alone may make owners and define roles) · **admin** (everything but that) · **member** (nothing org-wide; works in the projects they are given) · custom roles (any org capabilities but `org.roles` — e.g. *data engineer* = query + write the warehouse) |
| Project | people of its organisation, given a project role | **admin** (everything in the project) · **member** (view, ask, approve others' decisions, own connections, use the project's warehouse grant) · **viewer** (view only) · custom roles |

Organisation capabilities: `org.people` (add and remove people, give them projects and roles), `org.roles` (define
roles, make owners), `org.projects` (create, delete, restore projects), `org.billing` (credits, budgets, everyone's
usage), `org.keys` (organisation keys), `org.audit` (the organisation's records), `warehouse.manage` (make tables;
grant tables — read, and write — to projects), `warehouse.write` (append rows to any table), `warehouse.query` (read
every table, the tables' list and the warehouse's record).

Project capabilities: `project.view` (open it, browse its agents and views, read what its scopes show), `project.ask`
(ask in words, keep sessions, record decisions — what spends credits), `project.approve` (approve someone else's
decision), `project.connect` (one's own connections), `project.publish` (widen knowledge: publish concepts, programs,
change the decision memory), `project.data` (shared connections, data access policies and attributes, data sources),
`project.people` (project roles for the organisation's people, groups, custom project roles), `project.keys` (agent
keys), `project.audit` (the audit history, logs, everyone's usage and sessions), `project.manage` (engine, settings,
dashboards, domains), `warehouse.use` (read what the project was granted), `warehouse.append` (append to the tables
its grant makes writable).

**The rules, everywhere:**

1. **One check.** `control-plane/shared/permissions.ts` holds the vocabulary, the built-in roles, which capability each
   route and each hub message needs, and `can()`. The Worker, the Durable Objects and the admin console read it; no
   other place decides.
2. **Fail closed.** Without the capability, refused; a route or message nobody named needs the strongest one; an
   unknown capability is an error, never ignored.
3. **No one gives more than they hold** — a role given, a custom role defined, a key made. Only an owner makes owners;
   an organisation always has one.
4. **A key acts for its maker.** Its scopes must be within the maker's capabilities when made, and are cut to the
   maker's capabilities at every use — a maker who leaves or is demoted takes the key's power with them. Project keys
   (`sak_<project>_…`) for project work; **organisation keys** (`sak_org_<org>_…`, made by someone with `org.keys`) for
   the organisation's own work — the warehouse today, creating projects later.
5. **The organisation decides who exists; the project decides what they do there.** A project gives roles only to the
   organisation's people; domain sign-in is an organisation decision (`org.people`) and admits at most a member.
   Organisation owners and admins administer every project (mirrored into each, so a project answers alone).
6. **Who sees** stays the scopes (`global`, `group:`, `user:`): a capability says what a person may *do*, a scope what
   they *see*. Making or widening anything beyond one's own scope is publishing (`project.publish`).
7. **Every grant, role and key change is in the audit history.**

**The warehouse under it:** `warehouse.manage` makes tables and sets each project's grant — per table, the columns it
may read and whether it may write. A project's people and keys read with `warehouse.use` and append with
`warehouse.append` (key scopes `warehouse`, `warehouse-write`), only within that grant; the organisation's people query
and append with `warehouse.query` / `warehouse.write`; `sacli warehouse` does each, with whichever key it holds.

*Later (planned):* one principal name for a person everywhere (today `email:`, `user:<clerk id>`, `agent:`);
revocable sign-in tokens; service tokens bound to one project.

### Storage and builds

- **The platform is the source of truth; the engine is a replica.** Sync runs immediately whenever the engine is
  connected, and everything important is always synced to the local system as well.
  - **In the user's words (2026-10-07):** the concept, composition graph and related things always come from the
    platform to the engine. The program generated in the engine and the agent-generated things go from the engine to
    the platform — because they are generated by the engine anyway, so they have to go the other direction; whatever
    the rest of the things, they always come from the platform. As many things as possible, by default, go from
    platform to engine; only what the agent generates — because it can only be generated in the engine — goes from
    engine to platform.
  - **One path (the user, 2026-10-07):** anything that can be sent to the platform should first go to the platform and
    from there only should come to the engine — you cannot have both paths. Whatever you are uploading or sending, it
    always goes to the platform and the engine downloads later on. Always send a message once it is saved in the
    platform — "you can download it" — to the engine; if the engine is not available at that point, when it comes back
    it downloads it anyway. *How:* every kind the platform holds is an append-only, numbered log (content by hash);
    on save the platform tells the engine `<kind>:changed`; the engine pulls what comes after its own cursor, in order,
    on that message and on every reconnect (so a message missed while it was away costs nothing); a record already held
    is checked equal and skipped; an engine copy that disagrees is set aside and rebuilt from the platform.
  - **Where it is kept (the user, 2026-10-07):** only metadata and JSON-like, table-like data is stored in the project's
    Durable Object; everything else — files — goes to the R2 bucket, connected to the Durable Object by metadata (its
    hash, when, by whom), so we always know what any project contains, keep its history, and know how to delete it.
    The platform is the source of truth for almost everything — not data that is easily generated again, and not
    files specific to the engine that make sense only where it runs (caches, indexes, agents' working folders).
  - **The doors up (what the engine generates):** a thing is kept on the platform only when it goes through its door;
    everything else an agent writes is its scratch. A program → `program:build` (the platform keeps the build and its
    source); a connection's bridge → uploaded after the connector agent's turn; a concept, domain or agent definition →
    `graph:write` (written by the platform, as the person); a session (its log, answers, files) → session sync. People's
    doors in: the console, `sacli graph import` (knowledge), `sacli program build`, `sacli app publish`, connections in
    the console. A new kind worth keeping gets its own door.
  - **Engine → platform** (made in the engine): sessions and conversations, programs, dashboards, and the nodes an
    agent generates (an agent made from a session) — sent as writes the platform makes, governed, as the person.
  - **Platform → engine** (held by the platform): the composition graph — domains, concepts, agents, settings, its
    changes, suggestions, decisions and versions. The ProjectDO holds it (`graph.ts`, the composition-graph package over
    the Durable Object's SQLite) and answers every read and change people and agents make; the engine keeps a replica
    it only pulls into (`graph-replica.ts`: on every welcome and on `graph:changed`, `graph:pull` from its cursor), never
    writes, and rebuilds from the platform when it disagrees.
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
- **Credit assignment (built 2026-10-05):** an organisation admin gives a person (`email:`) or a group (`group:`) a
  budget of credits (per month or in total; every change kept). The hub records each session's owner as their messages
  pass; usage tagged with a session is attributed to its owner in the project's usage and the organisation's ledger;
  a person over their own or a group's budget is refused new questions and session intents, with a sentence.
  *Next:* every model call tagged with the session it served — the proxy path `/p/<project>/s/<session>/<provider>/…`,
  set per session by the engine for each harness — so all usage is attributed (today it is attributed only when the
  session is named).
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

### Views and sessions — one thread, two homes (built 2026-10-05)

**In the user's words:** "I just click on one of the agent, I'm not doing anything… are we actually creating a new
session in the file system?" — "whenever I change a filter or do something and no new blocks are added, really there is
no point in creating a new session, that will be a waste." — "Only if I ask a question, then only we create a new session
because we are talking about the agent." — "I want to do it in such a way that it is not complicating it, like
uniformity is there… a proper solution, a proper thinking behind it."

- **One model:** a thread of steps; each step a STATE (small JSON: what the view looks at, its filters, breakdown,
  window); the answer is derived from STATE by running the agent's programs. Same thread, frames and controls everywhere.
- **Two homes:** a **view** (browsing) is kept by the browser — the address carries the current step's STATE, the
  history holds the tree; the server writes nothing but one small usage event per action; coming back recomputes the
  answer fresh (a dashboard shows today's numbers). A **session** (a conversation) is kept by the platform — the answer
  history, unchangeable, branchable, the answers as shown.
- **The engine is stateless for views:** the browser sends a step's STATE with the intent; the engine runs the same
  session code on a throwaway in-memory session and returns the new STATE and answer — one code path, writing nothing.
- **Kept when it must be:** the first question to the agent, recording a decision, or making an agent from it. Then
  the path browsed is written as the session's first steps (the engine recomputes their answers itself), and the question
  follows. Filter changes and drill-downs never create a session.
- **Without a session:** usage events (agent, view, control, when) to the platform's usage record — for defaults learned
  from usage and for the decision memory's sense of common paths; learned paths for a view come from a stateless
  "recognise this STATE" call.
- **Replaces** the held-in-memory interim (deferringLog, 2026-10-05), which kept a session at its first filter change.
- **As built:** engine `view:open` / `view:intent` (a throwaway in-memory session, nothing kept) and `session:keep`
  (the path replayed: opening, each step's intent, each change made in place); the user UI's `threadSource.ts` gives the
  one steps component either home; a view's thread lives in the history entry, the current STATE in the address
  (deflate + base64url, kept out of the address past 6,000 characters — the history still holds it); `view_events`
  (ProjectDO 30) is the usage record; `decision:paths` takes a view's inline STATE.

### Connectors — the framework (built 2026-10-05)

**The request, in the user's words: `docs/connector-system-request.md`.** A standard way for an enterprise's systems to
attach — built one by one in this repo, governed, with data and actions kept apart, and nothing common copied into each.

- **A package of its own** (`connectors/`, like the CLI): a connector is a manifest, a server module and optionally a
  React view, built on one SDK (`src/sdk.ts`, `src/mcp.ts`) and kept by hash. `pnpm build` writes `dist/` (the catalog
  and the bundled code); the control plane ships it with each deploy. Guide: `connectors/README.md`.
- **Data and actions.** Entities to read (fields typed), actions to do — each saying what it changes (`read`, `write`,
  `irreversible`). An action that changes anything runs only with a person's confirmation; an agent's request for one is
  refused with that reason (an approval flow can carry it later). Every action is audited.
- **Runs in a sandbox: Cloudflare Dynamic Workers.** The connector's code is loaded by hash into a Dynamic Worker (one
  isolate per connector version and connection, kept warm). Its only way out is the **ConnectorGateway** entrypoint in
  the platform's Worker: only the manifest's hosts (resolved from the connection's settings), the connection's
  credentials added there (the code never holds a secret), redirects not followed with them, every request recorded.
- **Connections** are the ones the platform already kept (shared by the project, or a person's own; secrets sealed):
  cloud connectors joined the one catalog (`shared/connectors.ts`, `runs: 'cloud'`), replacing the saved-only REST and
  MCP entries. Opening one: test, what it offers, a look at the rows, its actions, and its record.
- **Code mode.** Instead of an agent calling a connector once per turn, it writes one program: `connector:run` runs it in a
  Dynamic Worker with **no network** (`globalOutbound: null`); its only reach is `connectors` (the **ConnectorProxy**),
  which runs each read and action as the caller — the same checks, the same record, a change still waiting for a person.
- **MCP.** One connector (`mcp-server`) reaches any MCP server over Streamable HTTP: its tools become actions by their
  hints (read-only → a lookup; destructive → cannot be undone), its resources become entities; a read-only tool is also
  readable as rows. Any connector that speaks MCP reuses the one client.
- **The record.** Every operation (test, introspect, read, act, run) and every request a connector's code made (method,
  host, path, status — never a header or a body) goes to the project's append-only `connector_calls`; each introspection
  is kept (`connector_schemas`), the latest being what the connection offers.
- **Hub:** `connector:catalog|test|introspect|read|act|run|calls`, agent-key scope `connectors`.
- **Next:** the datasource index reading `connector_schemas` (every connector's data findable beside the databases'); a
  `cloud` source kind in the datasource manager so engine programs read connections through the one data path; OAuth 2
  connections (the platform runs the flow, keeps the tokens sealed); a connector's own React view (web.tsx); an approval
  flow for actions agents propose; semantic models over connector entities; pushing data to a system as a governed
  action; more connectors, one by one.

### The organisation's data warehouse — the module (built 2026-10-05)

**The spec, in the user's words, is `docs/warehouse-module-spec.md`.** It answers the stop below: no Pipelines per
customer — the Workers and Durable Objects that receive data write the Iceberg tables themselves.

- **Owned by the organisation:** one logical Iceberg warehouse each — a namespace (`org_<id>`) in the one shared Basin
  Catalog; the catalog lays out the files. Projects are not warehouses: a project is **granted** tables, and within a
  table perhaps only some columns — an authorization boundary, not a storage one.
- **The module** (`control-plane/superadmin/src/warehouse/`): the **Data Source Bridge** (`tables`, `describe`, `query`)
  that the rest of Superatom reads through, and **Ingest** (`createTable`, `append`) kept apart from it. The backend is
  chosen in `warehouse/index.ts` alone: the **cloud** (Basin Catalog + R2 + Basin SQL) today; a local Iceberg stack later
  behind the same two interfaces (not built). Nothing Basin-specific leaves `warehouse/cloud/`.
- **Writing from a Worker:** Basin SQL is read-only, so an append writes the Iceberg files itself — a Parquet data file
  carrying the table's field ids, a manifest and a manifest list in Avro (the parent snapshot's manifests carried
  forward), then a commit that holds only if the table has not moved (on a conflict the list is made again). Verified
  with DuckDB and PyIceberg reading the result; an append on a table another engine wrote carries its manifests forward.
  The catalog's maintenance compacts the small files.
- **Reading:** Basin SQL runs the query (no engine of ours). Before it runs, the **access check fails closed**: every name
  must be a granted table, a granted column, an alias the query made, or SQL's own word; `*` over limited columns, writes,
  comments and a second statement are refused; plain table names are placed in the organisation's namespace.
- **Who does what:** the **OrgDO** coordinates — names the warehouse, routes every operation through the module, keeps an
  append-only record of what was done (`warehouse_ops`); no data in DO state. The **ProjectDO** keeps the project's grant
  (append-only `warehouse_grants`), set by the organisation's administrator (`/api/warehouse/grants`). Projects read
  through the hub (`warehouse:tables`, `warehouse:query`; agent-key scope `warehouse`), audited. Organisation
  administrators make tables, append and query everything from `/api/warehouse` and the console's Warehouse tab.
- **Setting it up (needs the user):** settings `WAREHOUSE_ACCOUNT_ID`, `WAREHOUSE_BUCKET`; secrets
  `WAREHOUSE_CATALOG_TOKEN` (R2 + Basin Catalog) and optionally `WAREHOUSE_SQL_TOKEN` (Basin SQL); the bucket bound as
  `WAREHOUSE` (R2) with its catalog enabled. Until then every call says the warehouse is not set up.
- **Next:** a `warehouse` source kind in the datasource manager, so engine programs read it through the one data path.

### Customer data warehouse — stopped (2026-10-05, superseded by the module above)

**Flagged and stopped, in the user's words:** if a proper, Fabric-like warehouse per customer cannot be built on
Cloudflare, it is not built half-heartedly; something else will be thought of. The limitation: an account has at most
20 Pipelines streams/sinks/pipelines, so per-customer streams do not scale. The proposal below is kept for reference
only.

### The platform's own data warehouse (being built, 2026-10-05)

**In the user's words:** for our own system, a full data warehouse of everything that happens — in one place, so it can
be queried, agents can be trained on it, and analysis done that is impossible while every Durable Object keeps its own
data separately. One recorder in the platform's code, one stream (`platform_records`: kind, project, key, time, the
record as JSON) fed by every DO — audit, usage, sessions, graph records, activities, programs, credits — and by the
**agents' own work**: every turn of the composer (who asked what, which agent and domain answered, the steps it took
with what each returned, the queries it ran, the answer, the time), sent by the engine to its project's DO, which
records it — the one path. Into Iceberg tables in the platform's Basin Catalog, read with Basin SQL. One stream for all
kinds stays far inside the 20 limit. **No backfill** (the user, 2026-10-05): what runs from now on is recorded; history
can be thought about later if it is needed.

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

## The rest of the scope (the user, 2026-10-05)

**In the user's words:** build everything that was discussed first — it will be messy and some decisions will be wrong,
and that is fine — so the whole scope is in place and known; then smooth it out and weed out the wrong decisions.
Building one thing at a time risks discovering late that something was never thought about (how credit assignment
works, how connectors work). Questions asked: did the user UI move onto the block system; is the STATE system there; can
new agents be created, and how from the user UI; how do program templates (code + React) get built and deployed; when a
dashboard is "a collection of programs in the user UI itself", are programs fetched from the engine or from R2 through
the Worker; what is the contract a builder (agent or person) works to; is global/group/user scope applied everywhere it
matters.

**Connectors, in the user's words:** enterprises want to connect to their systems. Today's connector system works
programmatically; there will also be hundreds of connectors to other services, and MCP connectors, beside connectors to
other databases. Connecting looks like the SLOB application's block UI: "I want to connect to this" brings a UI for it.
A connection can be **per user** (each user makes their own) or **organisation level** (an admin connects once and
everyone uses it). The access key is stored securely: every use first decrypts it with a master key, then makes the call.

**Two kinds of connector, one thing (the user, 2026-10-05):** some connectors are **base connectors whose code runs in
the engine** — normally machine-to-machine, the whole engine has access; others have **no code of ours** — they live in
the Cloudflare side or behind MCP, an HTTP API the agent can still use by writing a program against it. They are meant
to be the same thing: a connection; the only difference is that some are written in code and some are just an HTTP
API. Someone connecting their Outlook or a specific database is most likely user level, but an admin can add a
connector too. Both kinds belong in the data source index.

**Models in production, in the user's words (2026-10-05):** for each harness and each model, one primary way:
**OpenRouter**. With 200 users we cannot have the trouble codex gave before — logging in, subscription-based logins;
that should not be necessary. An option where an API key is set and everything passes through it — Claude Code, pi,
codex, opencode, whatever runs — as the one standard way for production (the Claude Code subscription route stays as an
option). One OpenRouter key for everything, and a key per organisation; limits, including monthly recurring limits, the
way OpenRouter does them — in our own system too (it still goes through OpenRouter), so that each customer sees how
much each of their users uses: the enterprise context.

**The OpenRouter route (built 2026-10-05):** every harness can reach its model through OpenRouter with an API key and
no login on the box. pi and opencode already could; Claude Code is pointed at our proxy as an Anthropic-compatible
endpoint (`ANTHROPIC_BASE_URL=…/p/<project>/openrouter`, the project's key as its token, the subscription token
dropped), and codex at the same base as an OpenAI-compatible one. The proxy proves the project, attaches the vault's
OpenRouter key and meters the call — the same path for all four. The key is chosen by the project's credential group:
one platform key, or one group (and key) per organisation. A profile chooses it with `provider: 'openrouter'`; the
subscription routes stay as options. Limits are the credit budgets (a person or a group, monthly or in total).

**One model, many names (built 2026-10-05):** switching the account an agent runs through never means retyping its
model. The same model is spelled differently by each account (`claude-haiku-4-5` to the Claude Code subscription,
`anthropic/claude-haiku-4.5` to OpenRouter); a model is matched by its name without vendor prefix or variant, with `.`
and `-` as one, against the platform's model list (`control-plane/shared/models.json` — the only models agents run; changed with
`pnpm models add|remove` and a deploy; each engine receives it in its welcome when its copy differs; nothing is fetched online),
and translated. A profile is checked when it is saved: an account the harness cannot use, a turned-off account, or a
model the account does not serve is refused with a sentence naming the nearest models; the editor keeps the model when
the account changes. Every harness translates again at start for anything that reached the engine another way, and none
ever runs a different model in place of the one named.

**Usage per person, for every harness (built 2026-10-05; simplified the same day, in the user's words: "whatever they
pass on, we just take the same thing"):** the harness already knows what each model call used, so that is the usage —
we do not read provider APIs ourselves.
- *What is counted*: each harness's own report of each model call — pi per answer, opencode per step (`step-finish`),
  Claude Code from its transcript, codex from its session log (`token_count`, read across each turn, so a turn we end
  early still counts) — fresh input, output, and prompt-cache reads and writes kept apart. One path for every harness
  and every account (subscription, OpenRouter, any relay).
- *Who it was for*: the turn names its session and person (the engine knows who asked); each report is stamped with
  them and sent to the project's DO, queued until sent. Work no turn names (warm-up, a terminal session) is the
  project's, shown as unattributed.
- *Where it is kept*: the project's DO, append-only (`usage_events`: person, session, the agent's tag, tokens, cache
  tokens, credits), priced from the platform's price list, debited from the organisation's credits with the person
  named; a copy of each row goes to the platform's warehouse stream. Nothing else can post usage.
- *Who sees it*: the organisation's admin, per person across all its projects, month by month (admin console →
  organisation → Usage); a member sees their own.
- The proxy only logs each call it relays (project, agent tag, key, model, tokens shown), for following a call.
- Open: prices for prompt-cache tokens (counted, not yet priced).

**Choices made (2026-10-05):** the platform's own warehouse is Basin, and Analytics Engine is dropped (its 3-month,
sampled metrics duplicate what the warehouse gives; minutes of lag are fine).

**Groups and scope (built 2026-10-05):** a project has groups (members by email or agent key, managed by admins,
audited). The hub stamps every message with the sender's scopes — `user:<id>` and `group:<name>` for each group, read
each time — never from a payload. Knowledge (the graph), agents (listing and opening) and programs (the catalogue)
show only what those scopes see (global, one's own, one's groups'); an admin sees all; data access policies can apply to
a group.

**Programs to screens, the template and the contract (built 2026-10-05):** the engine uploads every program it built
to the platform's catalogue on each connect; screens load a program's view from the platform (R2, immutable by hash,
cached) — the engine is not needed to draw it — falling back to the engine only for a program not yet uploaded. A
dashboard is an agent whose programs' views are drawn together in its session. The contract every builder works to is
`docs/program-contract.md`; the template is `project-template/start/programs/template/` (`programs init <name>`).

**Order of building:** (1) drop Analytics Engine; (2) groups, and scope (global/group/user) wherever things are listed
or read — knowledge, agents, programs, sessions, connections; (3) agents as first-class, created from the UI and CLI;
(4) programs' React side served to the user UI from R2 through the Worker (the engine is not needed to draw a view);
(5) the program template and the program contract; (6) connectors and credentials (encrypted with the platform's master
key, per user or per organisation; MCP as a kind of connector); (7) credit assignment within an organisation (budgets for
users and groups); (8) the user UI pages for all of it.

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

## The decision system (2026-10-05)

### The loop, in the user's words

People ask questions; the agent answers. Later, on a slow path, we look at their questions and generate more
dashboards and more systems, a richer version as more happens. While that happens, the modules, the concepts, the
composition graph — everything — is immutable and in time: any point can be gone back to and seen, and everything is
governed as an enterprise needs, so nothing is ever lost. Everything built in a decision-intelligence system has
**steps**: we go through an agent, it does something, and step by step we progress, creating **artifacts** — and the
artifacts of the decisions taken come on the **right-hand side**. (Nothing like this is in any dashboard or
application yet.)

The agents are assumed to work (the ICA answering, System 3 exploring, System 4 consolidating, learning): the system is
built around what they produce and what they are given, not around how they work.

### The screen: steps in the middle, artifacts on the right

- **Left — where to go:** home, the agents (topics) a person sees, their sessions. A dashboard is an agent: opening it
  opens a session already on its domain.
- **Middle — the steps:** the session's thread of blocks, one step each (a question and its answer, a program's
  view, a control's result). Going back to an earlier step and changing it branches (the thread is a tree); the
  branch switcher sits at each fork. Each step ends in **paths from here** (below): never a dead end.
- **Right — the artifacts:** what the work produced and decided: the **decision records** (the decision, the options
  considered, the path chosen, the reasoning, the data it rested on, who approved), and the files, reports and plans
  made along the way. Artifacts are immutable and versioned, linked to the steps that made them, and governed
  (commands — approve, record — go through the one write path, never STATE). A session's artifacts are on the right;
  a project's decisions are its **decision register**.

### Decision memory — the decision state

One **decision memory** per project, in its own Durable Object (DecisionDO): every decision state is collected there,
because recognising a situation means searching all of them. It is not the session's STATE. Following the stable
attractor pattern (`docs/stable-attractor-associative-memory-source.md`):

- **Experience** — each passage through a step: its cues (language: the agent, the domain, the question, the STATE's
  values as phrases), the **world** as it was (the figures the step showed — each program's answer can name them), the
  STATE's hash, the **path taken** next (the intent: a control's ops, an action, a call, or words), and later its
  **outcome** (a decision recorded, approved, abandoned, reversed). The memory of the data that passed through.
- **Decision state** (an attractor) — a situation recognised from experiences: its description in language, its cues,
  the **paths** possible from it with the **reasoning** for each and their record (taken, succeeded, failed), the range
  of the world it was seen in, and its evidence (the experiences supporting or contradicting it). A decision state can
  hold other decision states (specialisations: "revenue + finance" and, when evidence shows it differs,
  "revenue + finance + 003"). Specificity is earned: one general state until evidence splits it.
- **Recognition (the hot path, deterministic, no model):** a step's cues → the associative index (phrases 1–4 words,
  BM25-like, user → group → global scope as a ranking factor, strength from the record) → the matching decision states
  → is the world still like the one each was learned in (each figure within the range seen, or how far it moved)?
- **What a state does:**
  - **learned, world similar** — offer its paths first, with their reasoning and record, one click each; exploring
    (asking the agent) is always still there;
  - **learned, world changed** — offer its paths marked with what moved ("seen 12–18, now 31"), and suggest checking
    with the agent before taking one;
  - **not learned** (nothing matches well, or the evidence is thin or competing) — explore: the agent answers and the
    programs' own actions are offered; the experience is recorded, so it can become memory.
  Memory is advisory, never authoritative; contradictions are kept as competing states until evidence explains them.
- **The first learner** (built): the plainest honest learning so the memory is never empty — a step people reached at
  least twice (one agent, the same STATE) becomes a decision state of the paths they took, each with how often; it
  writes only through the named operations, so a better learner (System 4) replaces it with nothing else changing.
- **Learning is a separate path** (assumed working): it reads experiences and outcomes and changes decision states
  only through named operations — create, reinforce, weaken, merge, generalise, specialise, supersede, split, compete,
  invalidate — each recorded with who, when and why; nothing is erased; any decision state can be read as of any moment.

### How it routes

```
step (block) ──► cues + world ──► decision memory: recognise
                                   ├─ learned · similar  ──► its paths (one click) + explore
                                   ├─ learned · changed  ──► its paths, flagged + "check with the agent"
                                   └─ not learned        ──► explore: the agent, the programs' actions
person takes a path ──► new step ──► experience recorded (cues, world, path)
decision recorded / approved / abandoned ──► artifact (right) ──► outcome of the experiences that led to it
slow path (System 3/4) ──► reads questions and experiences ──► proposes decision states, programs, dashboards
                           (as suggestions: owners decide; published versions; lineage kept)
```

### One UI framework (2026-10-05, from slob, proc, the Fusion5/TotalGroup dashboards and the user UI)

Today the same things exist several times: three thread implementations (the user UI's session screen, the
dashboards' `runtime/thread.tsx`, the chat's flat feed), two answer formats (the chat's `sections[]`, the dashboards'
`Block` types), three sidebars, three palettes, three WebSocket clients. The dashboards' web code — slob's design
system in plain CSS, proc's tree — is the best of them, and is copied byte for byte into every project. There will be
**one framework, a platform package** every surface is built from:

- **Design system** — slob's, kept and refined (tokens by meaning; fixed scales; `sa-thing__part--variant`; hover
  actions; value first; text fits its track; never null/undefined; ECharts' own charts; one table). Its rules are the
  design system's document; every project gets the same, refined as projects add to it.
- **Shell** — left: where to go (one line about the app; details open as a block); middle: the thread; right: the
  artifacts. One user profile (name and email, never an id), one connection status.
- **Thread** — a tree (proc): going back to a step and changing it starts a branch; a branch switcher at each fork;
  each step a block with its frame (step badge, title, the cause that opened it linking to its parent, hover copy ·
  collapse · remove), a separator with the time between steps, Shift+↑/↓. The thread is the platform's session (its
  log, synced to the owner's UserDO), not a browser's: the address names the session and its current block — absolute, never an
  operation list.
- **Blocks** — act in place when looking closer, open a new block when moving on or deciding; a decision is a block
  whose form locks and whose receipt captures before and after; live blocks re-read, record blocks never do. A block
  shows: the **answer** (markdown with marker lines, drawn by the one answer component — the chat's answer card and
  the dashboards' block renderers made one: tables with caveats and paging, KPIs, figures, bars/ring, grid, facts,
  files, the period), the **programs' views** its STATE names, and **paths from here** (the programs' actions, the
  decision memory's learned paths, asking in words). While it works it shows the narration beats and the partial
  answer.
- **Data** — one client (the hub socket, request ids, a bounded cache shown at once and re-asked, refreshed by server
  events); reads are named, writes are commands refused with a sentence.
- **Intent** — `<Intent>` (ops · action · call, current or new) and one listener; a component owns its intent, the
  engine owns whether it is coherent.

**Every surface is a thread of blocks (the user, 2026-10-05).** "Make an agent and the other things also need to follow
the same UI and structure — as we built the SLOB UI as block UI — same principle, UI and styles in the user UI, the
dashboard and even the admin UI. The admin UI also needs the exact same thing — everywhere we bring uniformity.
[…] We have to re-architect the front end a lot, but finally we should be able to use the same system in our dashboard,
user agent, the control panel, admin UI and everywhere, so that there is uniformity everywhere and we can use agents in
every place, and they are basically the same design in terms of the UI — they might just have different functionality."
So: a page is not a page. Every surface — the workspace, a dashboard, the admin console — is a thread of blocks:
starting from the sidebar or home, each click opens a block below (or changes the block in place when looking closer),
a form is a block that locks when sent and leaves a receipt block, going back to an earlier block branches. A session's
thread is the platform's (the engine's log); a surface without a session (the admin console, the user UI's pages) keeps
its thread in the browser (the address and history), with the same frames, blocks and design system. Agents can be
asked on every surface.

**The admin UI, rethought (the user, 2026-10-05).** "The admin or super admin system is very clumsy, so many things are
just put there on the left hand side. Organise it so that we can work much better — rethink the whole admin UI. […]
The admin UI was built without much thought; given how we want decision intelligence to happen, even on our admin UI the
decision intelligence and the UI structure should reflect it." And: "whenever we do this UI, create a design system — a
more semantic version — so that for everything we have a system; do not simply add ad-hoc CSS."

- **Home is what needs a decision**, not a list of panels: approvals waiting (decisions recorded for approval), suggestions
  to decide (knowledge, agents to publish), engines offline, credentials expiring or spent, budgets nearly used, work that
  failed. Each is a step: it opens a block with its context and its paths (approve, reject, fix, open the place), and
  what is done is a receipt — kept in the audit history like any other decision.
- **Navigation by purpose**, in the order the work happens, for the scope chosen (the platform, an organisation, a
  project): **Attention** · **Knowledge** (domains, agents, programs, decision memory) · **Data** (connections, sources,
  index) · **Agents at work** (models per agent, the consoles) · **People and access** (members, groups, data access,
  agent keys) · **Usage and credits** · **Operations** (engine, events, activity, audit, settings) · **Platform**
  (organisations, credentials, models, prices — superadmin).
- **The same structure as everywhere**: a thread of blocks, forms that lock into receipts, paths at the end of each step,
  agents askable on the page.
- **A semantic design system**: components named for what they are — a form and its fields, a receipt, a list of records,
  a status, an attention item, an action bar, a figure — each owning its styles on the tokens; a screen composes them and
  writes no CSS of its own. Theming is a handful of token overrides (`:root[data-theme=…]`).

**Moving a project's views onto programs (2026-10-05).** A project's existing views (its application's capabilities,
on its domains' programs) reach sessions through one generic program, `app-views` (in the template, the same for every
project): its slice is the question the application understands; `run` asks the application, `move` applies its next
moves, `row` follows a row clicked in a block (`ctx.services.app` — the engine hands the payload to the project's
application and returns its reply). Each scenario is an agent on it, starting from its root view, so every scenario is
in the workspace at once with nothing copied. A view is moved into a program of its own (as PMO health was) when it is
worth it; the bridge is the transition, not the destination.

**Three surfaces, one framework:** the **user UI** (admins and domain experts: work in sessions, build — programs,
agents from a conversation, dashboards — and publish), **dashboards** (an agent opened on its starting screen: its
programs' views; people ask on a topic from the left), and the **control plane** (organisation and platform
governance: the same design system). A project's dashboard code stops being a copy: its capabilities become programs,
its scenarios agents.

### The admin console in three layers (built 2026-10-06)

**In the user's words:** the block idea is not a good idea for the super admin — we are not making decisions by going from
one place to another; it is a hierarchy: I want to see this thing on the left, go there, see things. Some things could still
be blocks. Separate two ideas: one is the Superatom platform altogether — creating organisations, giving people access,
making admins for an organisation, keys, models and their credentials — and only the super admin sees it. The second is a
specific organisation: create projects, give access, the warehouse (the warehouse happens in this second layer), payment —
the credit card, address and billing address. Inside that, each project: its roles, data access, and the rest. See it layer
by layer, represented in the URL, so we can jump to a place directly. A tree: Superatom (the company, its assets, how the
platform runs) → the organisation (we give it to them; they think about everything in it) → its projects. One hierarchy
of the UI so everything is obvious; no card system everywhere — only where it is the essential piece.

**Built:** one router, every place a page with its own address — the platform `/` (organisations, engines, attention,
models and agents, credentials), an organisation `/o/<org>/<place>` (projects, people and roles, warehouse, usage and
credits, billing, settings), a project `/o/<org>/p/<project>/<place>` (attention; knowledge; data; agents; people;
operations). The sidebar holds the places of the layer you are in, with the way up at its top; the breadcrumbs the path,
each step with a switcher. A place is shown only to someone whose role holds what it needs (the server refuses the rest
regardless). Blocks remain where a flow helps: Attention, whose items open approvals and suggestions as steps. A page that
fails says so in its place. Earlier addresses (`/org/…`, `/pro/…`, `/w/…`) land on their place. Billing details (name,
billing email, address, tax number) are kept by the organisation, every change recorded; card payments wait for the
payment provider, which will hold the card.

### The admin console's cache (built 2026-10-06)

**In the user's words:** an LRU cache in the browser for the data the admin console shows. Every time we click something,
first load from the browser so we can move between places quickly — everything instantaneous because it is already
loaded — and always make the query to the back end; when its data comes, replace it. So there is never a stale cache. A
maximum size; when local storage runs out of memory, clear the cache. It is not the place for the token and small
settings — those are different; this is only the data shown in the admin platform.

**Built:** `control-plane/superadmin/src/cache.ts`, used by the console's `useApi` (and the graph page): a read is shown at
once from the cache when it was read before and asked of the server every time; a fresh answer that differs replaces it
and every reader reads again. Keys are who · organisation · path; least recently used goes first (at most 300 reads,
4 MB, 500 KB each); full storage clears it; a change made (anything but a read) forgets that person's reads in that
organisation; reads that change by the second (status, logs, attention) are never cached; a read that changes on every
ask stops causing re-reads.

### Named versions of the composition graph (built, 2026-10-06)

**In the user's words:** is versioning possible in the composition graph? Every change to a node is saved at once — that is
time travel — but there is no commit-like system: in git we make several changes and commit them. We need a version we
can name — B1, B2, B3 — and move between. It is not much different really: a name at some point. And a diagram or graph
of the versions: click one and view the graph as that named version.

*Proposal:* keep saving every change at once (nothing is lost between versions — the change log is the truth); a
**version** is a name and a message given to one moment of that log (`version` table: name, message, the change it
stands at, who, when — append-only, like a git tag over the log). On the graph page: **Name this version** (the changes
since the last version are listed, like a commit's diff); a **versions strip** — a line of named points with the
changes between them counted; clicking one shows the whole graph as of that version (read-only, the time travel the
store already has); **Make this the current graph** writes the changes that bring today's graph back to it (new
changes in the log; history never rewritten). Held by the platform (ProjectDO, `graph.ts`) since 2026-10-07; the
engine's replica pulls it.

*Built:* the `version` table (engine migration 6: name, message, `upto` — the id of the last change it covers — when,
who; append-only). A version is read **by change id**, not by time, so changes made in the same millisecond never leak
into it. Naming needs an admin; restoring is governed like any change and writes `back to version <name>` changes in
one savepoint. CLI: `composition-graph versions | version <name> --message … | restore <name>`; hub: `graph:versions`,
`graph:version`, `graph:restore`, and `compositionColumns({version})`; versions travel with the replica (cursor
`version`) to the platform (the ProjectDO) and back. The graph page shows the strip beside the search, a banner while viewing a version
(read-only: nothing attached, detached, made or edited), **Make this the current graph** and **Back to now**.

### Draft and published versions (built, 2026-10-06 — replaces naming)

**In the user's words:** every edit is not a version v1, v2 — they are just changes. We need a draft/publish system: while
they are editing it is a draft; when they commit/publish, a new v2 → v3 happens. That is what is pushed to the engine.
And the versions as a diagram, like git's, of how things moved.

*Built:* every change is still saved at once, but a change is only a change. **What the agents read is the latest
published version** — picking an agent for a question, composing its prompt, listing domains and agents
(`publishedUpto`; before the first version, the graph as it is). Edits after it are **the draft**, shown as the nodes
that differ from the published graph (so a discard empties it although the log grew). **Publish** makes the next
version, numbered v1, v2, … with a message (`graph:version {message}`, or in the console);
**Discard** sets the draft back to the published version; **Bring into the draft** sets it to an older version, and
publishing that starts a new line from it — the versions form a tree (`versionLine`: each version's parent is the one it
was published from). An agent in a person's own scope (made from their session) is theirs at once; everything shared
waits for a publish. The graph page: one button saying `vN live · k changes in draft`, Publish and Discard beside it, and
the versions drawn as a git graph (the draft a dashed dot above the live version, lines left behind in their own colour);
the changes page has a List / Graph toggle showing the same graph. Open chats keep what they started with; new chats read
the new version.

### The warehouse explorer (built, 2026-10-06)

**In the user's words:** the warehouse view in the organisation is going to be a big one. Today there is a table list,
make a table, what was done, and organisation keys. Look at slob's data section — a proper data warehousing UI: all the
data, search it, the columns and their information on the right. Bring it and make a better version: slob's is view-only;
here we create tables and do other things. The same viewer is used by a project's admin to view their data — with the
permission system applied (they cannot see everything); an organisation's admin sees all of it. Missing in slob: an
ownership mechanism — who owns a table. It is a semantic warehouse: several versions of the same data, virtual views,
transformations — we do not always work on raw data — but at the very least we see the actual raw data and manage it
properly. Plan it well, waste no space, show the data properly.

*Proposal (slob's explorer, three panes, the whole page):* **left** — the organisation's tables (raw, and later views)
with search over table and column names, grouped by owner/kind, row counts; **middle** — the chosen table's rows: search
across every column, value filters as chips, sort by a header, pages (50/100/250/500), click a cell to copy it,
shift-click a row; **right** — the table in figures (rows, columns, % null, owner, made, last appended), then every column
profiled (type glyph, distinct, null %, a sparkline) — a column opens to its spread (histogram, quartiles; dates over
time) and its commonest values, each a filter. Above the rows: the table's actions for those who may (append rows,
grant to projects, describe/owner, make a table, later views and versions). **Ownership:** each table has an owner (a
person or a project) and a description, kept by the organisation (a `warehouse_tables` record beside the catalog). **One
viewer, two places:** the organisation's Warehouse page (everything, for warehouse.query) and a project's Data → Warehouse
(only its grant — tables and columns — through the same access check as every project query). The explorer's reads are
structured (rows, values, profile, spread), turned into SQL by the platform from checked names only, then checked again
by the warehouse's access check before Basin SQL runs them — never raw SQL from the page.
*Verified (2026-10-06, a 3,000-row probe table in the TotalGroup organisation):* Basin SQL takes GROUP BY with ORDER BY,
COUNT(DISTINCT), ILIKE, CAST(… AS VARCHAR) LIKE (search over every column), MIN/MAX/AVG, `approx_percentile_cont` /
`median` (quartiles), `date_trunc`, `floor` arithmetic (histogram buckets — `width_bucket` is missing), subqueries and
window functions. **No OFFSET** — pages are `ROW_NUMBER() OVER (ORDER BY …)` in a subquery, or keyset (`WHERE id > last`).
The probe found three faults of ours, fixed: a subquery's alias was refused; every query was wrapped in an outer SELECT
for its row cap, which lost its ORDER BY (the cap is now the query's own LIMIT); headers carried the namespace.

*Built:* the explorer is one framework component (`Explorer` in `@superatom/ui`) reading through one function with
structured requests — `rows` (search across every column, value filters, sort, pages of 50–500 numbered by
`ROW_NUMBER()` over the sort then every column, so a page is the same page each time), `values` (the 50 commonest),
`profile` (every column in one read: distinct, empty, min/max, mean and quartiles for numbers, trues for booleans) and
`spread` (twenty bins for numbers; days or months for dates). The organisation makes the SQL (`warehouse/explore.ts`)
from names checked against the columns the reader may read, and the access check reads it again before Basin SQL runs
it. **Through the Durable Objects, where the authorization is:** the organisation's page asks the OrgDO
(`/warehouse/explore`, warehouse.query, grant 'all'); a project's Data → Warehouse asks its ProjectDO
(`warehouse:explore`, warehouse.use), which adds the project's grant and asks the OrgDO. The Worker only routes.
**Owners:** `warehouse_tables` in the OrgDO (append-only; the maker owns a new table; warehouse.manage changes it),
tables grouped by owner on the left. The organisation's page is the explorer, the whole page; beside its tables:
Ask in SQL, What projects may read, What was done (explorer reads are recorded but not listed there), Organisation
keys; above a table's rows: Add rows, Owner. `sacli warehouse explore <op> <table>` gives agents the same reads.
Later: views, versions and transformations (the semantic warehouse); a table's grant from its own head.

**In the user's words (2026-10-06, round 2):** listing tables and showing 10 or 100 rows should be fast — it is Parquet
and Cloudflare SQL, just 1,000 rows should be almost instantaneous; why not? One search only: on the left it searches the
tables and their column names (whatever metadata there is), and the same search searches the actual data of the opened
table — in the database, not only what the screen shows. A warehouse cache in the front end (an LRU of its own), so what
was seen comes back immediately — above all the column analysis on the right, which is slow; going to another table and
back must be instant. A click on a cell selects it with a border (as Google Sheets or Excel), arrow keys move, the
selection stays in view (scroll at the edges), Ctrl-C copies — no copy on click. Every query is a table too: a list of
queries beside the tables, click one to load it and run it again; no separate "Ask in SQL" card — a query's result is the
same table view, with the column analysis and filters wherever possible. The column analysis must have everything Rill
(Rill Data) has — show example, show distribution, all of it. And saved queries are stored on the platform, not the
front end.
*Why it is not instant:* measured from the Worker, R2 SQL answers in 0.5–1.4 s whatever the size: a distributed engine
plans, reads the table's Iceberg metadata and manifests from R2, then the Parquet — a fixed cost per query. Our own cost
on top (a catalog listing and every table's metadata before each query, each catalog call 1–8 s) is removed: one
warehouse per isolate, the tables' schemas kept five minutes, forgotten on our own writes. Instant is the browser cache.
Reading small tables' Parquet directly in the Worker would be faster still — not done; the standard engine was chosen.
*Where queries live — the user's words:* not the organisation's DO alone: each person who comes sees something else; with
many people given access to projects, each runs their own queries. They are stored in the **UserDO** (its SQLite): a
section for the warehouse with every query they have asked — perhaps a very small subset of what they got last time, but
above all the queries themselves. Every user logs in, so it is simple: every user has their own, and inside it a warehouse.
*Built:* `warehouse_queries` in the UserDO (keyed `user:<id>`): which warehouse (organisation) and project ('' = the
organisation's page), the SQL, an optional name (named = saved; unnamed = recent), runs, last run, rows, up to five rows of
the last answer, its columns. The platform records each run itself — the Worker on the organisation's page, the ProjectDO
in a project (`warehouse:queries`, `…:save`, `…:delete` over the hub) — and the answer carries `recorded: {id}`.

**The UserDO as everyone's front door — the user's words (2026-10-06, for later, not switching now):** the UserDO belongs to
the user and many things will come into it — we will track what a user does, quite a lot. After a while, every
connection from the front end goes to the user's UserDO instead of straight to the ProjectDO as today. The engine is
connected to the ProjectDO — otherwise the engine would have to connect to every user, which is not good. To limit what a
user can do, to allow several connections per user, to fan out and manage throughput, every user connects to their
UserDO; based on their access it decides and sends the message on to the ProjectDO; the project passes on to the
OrganisationDO what is the organisation's. A very clean architecture — to be discussed and done a bit later.

### How many Durable Objects (question, 2026-10-06)

**In the user's words (thinking aloud):** the graph data not being at the project level but in another graph Durable
Object feels redundant — what does it have that could not be in the ProjectDO? A Durable Object's SQLite holds some
10 GB, so it should be easy in the ProjectDO. The graph belongs to the project — unless the graph becomes really about
agents and their capabilities, then it might make sense. The ChannelDO is fine: Teams and other channels are a separate
thing. The DecisionDO is fine: the state machine has its specific reason. The session: a user has sessions; a session is
not edited once done, so a few facts stay with the user as the session, and the rest of its data could go to a key-value
store.

*Assessment:* the limit is 10 GB of SQLite per Durable Object. A graph is text — kilobytes to megabytes — so size is no
reason. The GraphDO was split for isolation, not need: the ProjectDO runs one request at a time and is the hub for every
socket of the project, so a big graph catch-up would queue behind and ahead of live messages — but graph syncs are small
and occasional. Folding it into the ProjectDO (its records and content as two more tables) loses nothing. Sessions: a live
session is appended to every turn and branches when a block is edited, so while live it needs a consistent log, which
Workers KV is not (eventually consistent, up to about a minute; last write wins). A finished session is immutable: an
object in R2 by hash (as parcels are), its index and few facts in the person's UserDO. So the SessionDO could become: the
live log in the UserDO, the finished log in R2. Not done yet — to be decided.

**Decided and done (the user, 2026-10-06):** fold the graph into the ProjectDO and the SessionDO into the UserDO; move the
data ourselves — two projects, one user — and keep no migration code for it. Everything that belongs to a person goes in
their UserDO (their sessions, their warehouse queries); later every connection goes front end → UserDO → ProjectDO (which
holds, copied in at creation, everything it needs, authorization included — the OrgDO is not crossed) → the engine.
*Done:* the composition graph in the ProjectDO (since 2026-10-07 held there, graph.ts — the engine a replica); `session_entries`/`session_artifacts` in the
UserDO (session-store.ts), the ProjectDO knowing each session's owner (`sessions_known.user`, from its opening entry). The
data was copied once by a temporary step and checked (TotalGroup: 93 graph records, 17 sessions; Fusion5: 171 and 38; no
artifacts existed anywhere; no mismatch), then both engines re-sent all 77 of their synced sessions from their own files,
each landing at exactly its old length. The copy code, both classes and their files were then deleted (wrangler `v8
deleted_classes`). Six Durable Object classes remain: GlobalDO, OrgDO, ProjectDO, UserDO, DecisionDO, ChannelDO.



### One ICA, the composer, and what a session keeps (the user, 2026-10-06)

**In the user's words:** we only MUST have one ICA, and it has to be called COMPOSER — the analyst is not used, the
dashboards' "reader" is the composer by another door. As discussed before: Intent → Classifier (choose an agent/domain)
→ ICA (the composer) → [narration] → answer.md. In a session two important things are stored: (1) STATE — a file,
STATE.json, changed and written every time through an operation; (2) ANSWER_HISTORY.jsonl — append only: {q1, ans1},
{q2, ans2}… (not only questions and answers; there can be more — illustration) — the partial history of the session,
the user's view of what they asked. Every session can also have attachments: files, in an attachments folder inside
the session. Every session can be started with additional context (like the dashboard gives the reader agent). Once
the agent commits its answer we take it — but today it may be sessionId/answer.md, which risks taking the previous
question's answer: it must be sessionId/<qid>/answer.md, so every question's answer is written in its own place; once
it is written and the agent's work is finished, we take that answer and send it to the user.
All of these — the files of a session — are also stored on the platform, in the user's Durable Object, on the session
side. They are made in the engine, so they are replicated from the engine to the platform, and there has to be a path
for sending them, done properly. Not at engine start-up (we would upload so much, and from which session?): only when a
specific session is being talked about. The engine can be down sometimes but the platform is always on; the engine has
to send everything through the project's Durable Object anyway, which saves it to the user's — and the answer always
goes to the user's Durable Object, whatever happens, so it can be kept there.
*Decided:* the engine writes `<sid>/<qid>/answer.md` from the composer's committed answer and sends exactly that file;
`session.jsonl` stays the one append-only truth (branching, the platform's sync), with `STATE.json` and
`ANSWER_HISTORY.jsonl` written beside it after every change.

### Every connection through the UserDO (built, 2026-10-06)

**In the user's words:** the answer buffer, the view events and the session owners can all go into the user's Durable
Object once the front end connects only to the UserDO; it becomes much cleaner. Imagine we are moving there: how would
the architecture look? Simulate it and discuss.

*Simulated:* a browser tab (or the phone) opens one socket to its person's UserDO, which checks the sign-in once and holds
everything that is the person's: their sessions, their warehouse queries, an **inbox** (today's answer_buffer: answers
land there whether or not a device is open, and every device of theirs reads from it), what they browsed (view events),
their preferences. Who owns a session stops being a fact anyone records: a session lives in its owner's UserDO. The
UserDO passes the person's messages to the ProjectDO they concern; the ProjectDO stays the authority on who may do what
(members, roles, grants, keys — copied in from the organisation when the project is made, so the OrgDO is never crossed)
and keeps the single engine connection, the graph, programs, the audit, activities and usage. Answers and events come
back the other way: engine → ProjectDO → the UserDO of whoever asked (or every connected member's, for project-wide
news) → that person's tabs. A fan-out tree: one engine socket, one link per active person, their tabs below.
*Gains:* the ProjectDO's load follows active people, not tabs; a person's limits (rate, queue, several devices) are kept
in one place; answers wait in the inbox for a device that was offline; one place serves a person's home across all their
projects.
*To settle when built:* (1) the UserDO ↔ ProjectDO link as RPC calls both ways, not a held WebSocket — a socket a Durable
Object opens itself keeps it awake, RPC lets both sleep; (2) the extra hop — the two objects may live in different
places, so the ProjectDO's location matters, and streamed answers carry sequence numbers; (3) agents and keys (sacli,
the ChannelDO, ICA tools) are not people — they keep talking to the ProjectDO directly, or get a principal object of
their own; (4) project admins still reach a person's session for approvals and the audit — through the owner's UserDO,
as today. *Path:* first the UserDO accepts the socket and passes everything through unchanged; then the inbox and view
events move; then limits and the clients' address.

**Decided (the user, 2026-10-06):** not gradual — move everything now (one user): every browser tab, the admin console,
the iOS app and the project apps connect to the person's UserDO; many tabs, one UserDO; RPC between the objects. And
deliver carefully: a person asked in the browser, then opens the session on the phone — the phone should get the answer
there because it opened the session, not because every device gets everything. Lanes and attachments (once the
terminal's, on the ProjectDO) now go through the UserDO: a structured way of pushing and pulling, what goes where.
*Built:* the Worker sends every socket that carries a person's sign-in (`/_ws/<project>?token=…`; not a service
identity) to `user:<id>` — the clients' protocol is unchanged (hello, envelopes), so the web app, the console, iOS and
the project apps needed no change. `user-hub.ts` keeps one link per project and surface (`personLink`,
`personMessage`, `personUnlink` on the ProjectDO, by RPC); the ProjectDO's link is a connection like any other in its hub
(kept in `person_links`, found again after a wake), whose `send` is an RPC to the UserDO's `deliver`. Delivery: a reply
to a request (reqId) → the tab that sent it (`asked`, kept six hours); an answer (qid) → the tab that asked and every tab
with its session open; a session's news → the tabs with that session open; a log → the tabs attached to its channel;
an agent lane's stream → the tabs on that lane; the hub's own notices → every tab of the link. A tab's lanes — sessions
it opened or asked in, logs and lanes it attached to — live on its socket. Engines (key), agents (agent keys) and
service identities (the ChannelDO, Teams) still talk to the ProjectDO directly.
*The inbox* (the answer buffer) is now the UserDO's, by project: questions as they leave, answers and follow-ups as they
arrive, served to a device that was away (sync:req, answer:get, answer:ack) without asking the project; the ProjectDO
keeps only who asked each question (it decides whose logs and answers reach whom). A large message (parts, or a parcel)
hides its question and session: the UserDO joins it, decides from the whole, and forwards the original frames in order.
*Kept in the ProjectDO, on purpose:* `view_events` (what was browsed in the project) and `session_owners` (whom the
project charges for a session's spend) are the project's usage record, not the person's state. *Found and fixed on the
way:* a log nobody could be found to own reached every attached person (now the session's owner, else admins only);
the engine's wire shared one sender — one address — for every log and channel; terminal viewers were never removed;
`session:load:res` carried no session; a question queued while the machine slept lost who asked.

### Appending and partitioning in the warehouse (question, 2026-10-06)

**In the user's words:** Parquet files are a one-time thing, a compression system — appending is not like a scale
system, you cannot just append another row. So how exactly are we adding data incrementally — will that be a problem?
How does it normally work in a Parquet file system? And have we thought properly about partitioning — there are many
ways; in one system I partitioned by year and then month and inside that each table, or table and inside it year and
month — everything partitioned by time. Is it done like that, or is there no partitioning and Apache Iceberg does it?

*How it is today:* a Parquet file is never changed. Each append writes one new Parquet file with only those rows, a
manifest naming it, a manifest list carrying every earlier manifest forward, and a commit to the catalog that makes the
new snapshot current only if nobody committed in between. A table is a growing set of immutable files; a snapshot says
which make it up (hence time travel). The tables are **unpartitioned**, and append refuses a partitioned table.
*The risk:* many small appends → many small files, and a manifest list one entry longer per append. The cure is
**compaction** (rewriting small files into few, as a new snapshot — readers never notice) and batching on the sending
side. Whether R2 Data Catalog's compaction is switched on for our catalog is **not verified yet**.
*Iceberg's partitioning:* a partition spec in the metadata (e.g. `month(shipped)`), not folders; each data file carries
its partition value and per-column min/max in the manifest, so a query's WHERE skips files (hidden partitioning — no
`year` column to filter on); the table is always the top level; the spec can change later without rewriting old files.
*Proposal (not built):* unpartitioned until a table is large (min/max + compaction serve millions of rows; partitioning
small tables multiplies small files); the maker of a big time-series table names its time column, the default spec
`month(column)` (`day` for very high volume); append splits a batch by partition, one file each. Turn on and verify
compaction first.

**Decision (the user, 2026-10-06):** appending an immutable file n+1 is the standard way — beautiful. If Cloudflare's
Iceberg catalog does the compaction for us, even better. No Hive-style layout: we go with today's industry standard,
Iceberg, the way Cloudflare's catalog is made for — not our own scheme, nor something random found on the internet.
*Done (2026-10-06):* the catalog's automatic compaction is on for the warehouse bucket (`wrangler r2 bucket catalog
compaction enable`, 128 MB target files). Pricing: 10 GB and 1 million files compacted a month included, then $0.005/GB
and $2/million files. Snapshot expiration (free) is left off for now: it would limit how far back time travel reaches.

### The composition graph in columns (built 2026-10-06)

**In the user's words (2026-10-05):** some things do not make sense in the block view; the composition graph needs white
space to see everything and think about it, something more like a graph. **Then (2026-10-06):** don't do it in a canvas —
just have columns. When any node is selected in the first column, show all its first neighbours in the column to its
right; each column scrolls independently. In the right column show first whatever is connected to the one selected on
the left, and then the rest. A node on the right can be selected and attached to the one selected on the left, or removed
— it becomes detached from the selected one. Three columns: **domains → intermediate concepts → atomic concepts**. An
intermediate concept is a combination of some atomic concepts.

**Built:** an intermediate concept is a concept of form `composed` listing atomic concepts in order (and perhaps a line
of its own); a domain composes intermediate concepts (a domain written before them may still list atomic ones directly —
they show in the middle column marked *atomic*, and can be detached); an intermediate composes atomic ones only, and a
concept that is part of one stays atomic. Composing renders an intermediate as its heading, its line, then its atomic
concepts beneath it. Attaching and detaching are one governed change (`graph:join` / `graph:leave` with `into`: a domain
or an intermediate concept); `sacli call graph:join` the same. The console's
graph page is the three columns (`Columns` in the framework, reusable for other linked things), each searchable, with
*New* in the intermediate and atomic columns (made and attached to what is selected on the left).

### Arrange — every block's cards, in the framework (built 2026-10-06)

**In the user's words:** whenever there is a block and cards — look at the slob application — we have a concept called
*arrange*: arrange the cards inside a block, which happens first, which second, the order of it; it is stored only in
local storage. Replicate it exactly; the Arrange button at the bottom. Not only in the admin console — in the user UI too.
It is part of our template and framework, so everything gets it for free wherever there is a block UI — a framework, not
an ad hoc thing in one page.

**Built:** `components/frame/arrange.tsx` in `@superatom/ui`, slob's mechanism as it is: Arrange at the bottom right turns
it on; a click selects a card, ↑ ↓ move it within its block, Delete hides it (shown faded while arranging, "Show this card"
brings it back), Reset this screen, Enter or Done keeps, Esc or Cancel puts back. The order is kept in localStorage per
scope, applied before paint (no jump); a card is a Section (its title) or anything marked `data-card` (figures are). Every
surface gets it with nothing to write: AppShell holds the switch, every BlockFrame's body is arranged (per kind of block and
title, or its own `arrangeScope`), and a page wrapped in `<Arranged>` too — the admin console wraps every page (kept per
place, the same for every organisation and project); the project template's thread keeps it per capability.

### Creating and publishing

- A person works in a session; when it holds knowledge worth keeping they **make an agent from it** (its domain's
  concepts compacted from the conversation, as suggestions), forked from the agent they started with — lineage kept.
- Programs are built (by a person or the builder agent) as drafts, tried in the session, **published** by their owner
  or an admin; a dashboard is an agent whose programs' views are its starting screen, published the same way.
- What the slow path proposes (new decision states, programs, dashboards, concepts) arrives as **suggestions**; the
  owner decides; the decided version is published; everything keeps its history (time travel) and its scope
  (global / group / user).

## Everything is an agent, an agent is a composition (the user, 2026-10-07)

**In the user's words:** we want everything to be an agent, which itself is just a composition of concept nodes. Concept
is the base node — there could be other types inside, like settings, UI, units… Most nodes come stored (inside the
database). But some nodes are created dynamically, like the available programs and the available tools that we can run.
Simplify everything that can be done with this composition graph — and only whatever is not possible as a composition
we will think of separately.

Whenever we work with our own coding agent, we can create any files or folders and programs, and then we always upload
them through sacli. Most of the time the engine is hosted somewhere we do not directly have access to: what we create
through, say, Codex and upload with sacli is stored in the platform database and replicated into the engine's project
workspace. Only in some cases are we working directly on /state/<project>/…, and that is where the confusion comes from.
Only the engine's agents work in the project workspace; when we write code ourselves (by hand or through our own agent)
we always use sacli, which always goes through the platform — and the problem is solved.

## The project's map, and addresses (the user, 2026-10-09)

**In the user's words:**

- **Every menu item is an agent.** We can have each one as an agent — that's not a problem, it doesn't cost us
  anything to make an agent. An agent can have a domain, programs, context… all of them optional except the domain,
  and creating a domain is not a big thing. If one can ask a question of the approvals, that is not really bad.
- **The problem is organisation, and the number of agents** — overwhelming. A menu has a hierarchy and a
  categorisation, not just a list of agents, and there could be many more agents than we want to show.
- **A program can't publish the menu.** The menu items are a **map**, and each is mapped to an agent.
- **Each project has a map, written by its admin.** Each person can later have their own, kept in their own Durable
  Object. For now the project's is enough.
- **Addresses are paths**, not `?page=agents`: a collection of good paths. A published dashboard keeps
  `/dashboard/<id>`.

**How it is built:**

- **The map is a node of the composition graph**, of kind `map`, named `map`. It is versioned, governed and changed
  like agents.
- **Its body** is `{ sections: [{ label, items: [{ agent, slug?, label?, icon? }] }] }`.
  - Every item names an agent of the graph.
  - Each item's slug (by default the agent's name) is its address, `/<slug>`. Slugs are unique and never one of the
    reserved words below.
- **The user app's Agents panel draws the map's sections**, under "All agents". An agent not on the map is still
  reached by search (⌘K) and from the All agents page; it is not listed in the sidebar.
- **The engine sends the map with `session:agents`**, from its replica of the graph. Only the items whose agent the
  person may use are sent.
- **Addresses:**
  - `/` — home;
  - `/<page>` — the app's own pages (about, agents, activity, connections, profile, settings);
  - `/c/<session>` — a session;
  - `/a/<agent>[/<start>]` — an agent's view;
  - `/<slug>` — a place on the map;
  - `/dashboard/<id>` — a published dashboard's own site, unchanged.
- **Reserved words** (never a slug): the pages, `a c s w u dashboard admin api ws assets auth`.
- **The view's STATE stays in the query string** (`?v=`): it says what is on screen, not where one is.
- **Old addresses** (`/w…`, `?page=`) were migrated, not kept beside the new ones.

## What each project keeps, and secrets on their own path (the user, 2026-10-08)

**In the user's words:** we use the same R2 bucket for every organisation, every project, every user — imagine someone
uploads a lot of things for a project: is there a way we track, for each upload of files and things, how much storage
they are using? For the project's Durable Object that is easy, but in the bucket — the parcels, the messages, the source
code, the programs, the React applications, the source index — can we calculate how much is there? When we store where
an upload went, also a little metadata about its size, so we can say "you are using this much storage from us". And if
they ask us to delete their data, we know exactly where their things are: we can list them (it may take time), show them
where things are, how big, what is inside, and delete them. And secrets — data passwords and the like — are never put
into R2 or anywhere readable: there must be a specific, special way, so that secrets never go through the same path; they
always go through a different one.

*So:* every object in the bucket is written and removed through one module (storage.ts), which records it in its
project's ledger (the project's Durable Object, stored_objects: key, kind, size, who put it, when). From the ledger: what
a project keeps by kind and by person, an organisation's as the sum of its projects', and the list of a person's or a
project's objects — to show and to delete (never what is in use). Secrets enter only through the connections routes,
sealed at once (proxy/seal.ts), kept sealed in the project's Durable Object, and leave only in the two payloads that carry
them to the engine (SECRET_PAYLOADS) — inline on its authenticated socket, never as a parcel, never into the bucket.

## Big bodies and stored things travel one way (the user, 2026-10-08)

**In the user's words:** downloading a file, downloading a snapshot of something — this will be very common, so it should
be done in a generic way, or at least organised properly. Do not give a direct R2 URL: everything comes from
*.superatom.site or *.superatom.ai. The engine always pulls through its WebSocket, but it can push something as a parcel
and the front end can read that parcel; when something big goes from the front end, or the CLI, it should be the same
parcel idea in the reverse direction too — where authorisation allows it. Packaging something as a parcel happens in one
place, and opening a parcel also happens in one place: once in the browser, once in the engine, and once in the platform
code. No backward compatibility while there are no users — change it for the best and only method (the iOS app too).

*So:* one transport (clients/transport.ts) at every end, in every direction: a body over the frame limit goes beside the
wire as a parcel (the bucket, by its hash, read with a ticket the platform signs) and its pointer travels. The browser,
the admin console, the CLI and the engine each pack in one sender and open in one receiver; the engine's own messages to
the platform go through the same wire (toHub). The platform packs in one place (the project's Durable Object's emit) and
opens in one (openParcel) — and, where the platform itself must read a body, through the same receiver: a person's hub
(to keep their answers) and the Teams channel (to post). One route serves every stored thing a project keeps:
/api/projects/<project>/objects/<kind>/<id> — parcels (with their ticket), and what the engine downloads (program builds,
bridges, session files, with its key). Secrets never take this path: what carries them (a connection unsealed for the
engine) is sent inline on the authenticated socket, never as a parcel.

## Data sources and their index (the user, 2026-10-07)

**In the user's words:** the datasource index, as everything else we are doing, will really be in the platform — inside
the project's Durable Object as the primary source of truth. It actually gets created in the engine, because that is
where the connector code is; but we will add connectors that run in a Cloudflare worker, so it can come from anywhere.
No matter where the connection happens, we sync both sides; if it is deleted fully or partly from the engine it is
efficiently synced back from the platform. Almost every piece of data has to be on the platform; we sync it to the
engine only because the engine is the one doing the work. find-schema and get-schema are answered on the engine, beside
the agents, fast. There is one idea, the DATASOURCE, and the DATASOURCE INDEX is part of it: information about the
source and its keys to connect. Sometimes there are per-user keys: if the source has its own authorisation, instead of
one machine-to-machine key we reuse the user's key, with their roles and authorisation in it. When the engine starts it
checks it has the latest data sources (else the platform gives it a snapshot), then asks for each source's latest index.
When an admin adds or changes a table or column, or disables one, it comes as a standard change-sync message; the
platform is the truth and the engine holds a replica. The connector agent fills in the kind of database and the basic
information essential to connect. sacli works with data sources and their index too (create, read, update, delete,
publish to the platform). Each connector has its introspect(); beside it the build-dsi system, in phases — the first as
fast as possible: table names, column names, type, description if any (else empty). Every item has programmatic, human
and AI descriptions, kept apart; the order of value is human > the database's own > AI; when a human has written one,
the others are only shown. Through sacli we cannot know whether a person or an AI wrote it — the sacli user picks.

Building must survive anything: a failure, a restart, a source disconnected and reconnected — it continues from its
checkpoint, never redoing work. A second layer (which tables have no rows, how many fields are empty…) comes after,
never in the first stage, because COUNT(*) is slow on some databases. While it runs, progress is sent like a heartbeat —
a message type of its own: how many sources, which one now, how many tables in it, how many columns seen. It is a
singleton: there can never be two at once; a second trigger joins the one running. A protocol for this kind of work in
general — not only this — that says the stage and exactly what it is doing, so whoever listens sees it, and can trigger
it again if it broke; after a restart it carries on by itself, since the index matters: as long as it is not done, keep
doing it. Schemas change, sources are removed; we show the last snapshot. A project may see only a slice of a source
(the warehouse) and the slice changes with permissions; we do not poll every source daily — a targeted message (this
table changed, look again) is sent to the indexer, at table level (column level allowed). For the console, one current
snapshot of the index to download directly, updated whenever the index changes — while the index itself time-travels:
at any point in time, which tables and columns were there, their descriptions, which were disabled. Disabled is never
deleted — shown as available but disabled. Disable at table level or field level; a disabled table hides all its
fields. Disabled means find-schema and get-schema leave it out; queries are not blocked (a fixed dashboard may still
read a column disabled later). Every connector is its own module, because some (NetSuite) have no introspection query
and need what is known about them written in.

*The rules this is built and tested against:*
1. The platform (ProjectDO) holds every data source and its index; engines hold a replica; nothing on an engine is the
   only copy.
2. An index item is a table or a field of a source. It keeps three descriptions (source, human, AI); the one used is
   human, else the source's, else AI. A description written through sacli says which it is.
3. Every change to an item is appended to the index's log with when and by whom; the index as of any time is read from
   it. Nothing is ever deleted: a removed table is marked gone, a disabled one disabled.
4. Disabled: a table or a field; a disabled table hides all its fields from find-schema and get-schema; queries are not
   blocked.
5. Building is in phases per source (1: names and types and descriptions; 2: row counts, only where cheap). Each table
   done is a checkpoint kept by the platform; a build resumes from it after any failure or restart, and skips nothing.
6. A failure to read is never recorded as emptiness, and never removes or disables anything.
7. One build at a time per project, held by a lease on the platform with a heartbeat; a second trigger is told the one
   running; a lease whose heartbeat stops expires and the work resumes.
8. A build left unfinished resumes by itself when the engine is back; a targeted rebuild names tables.
9. Every long piece of work reports through one job protocol: kind, stage, what it is on, counts, heartbeat, state.
10. The engine's replica follows the platform by a numbered cursor: told when something changed, it pulls what changed
    after its cursor; empty or lost, it pulls everything.
11. A snapshot of the current index is kept as one file, rebuilt only when the index changed since it was made.

## The data area: sources first, a viewer for each kind, lineage as a map (the user, 2026-10-08)

The user's words, kept:

- "we do not have to say data source index because of course index is part of it but we should just call it data source …
  the first thing should be data source because where the data is really coming."
- Data lineage: "the data comes from this place and then some virtual things are getting created here something is coming
  from there. What is the lineage of where data is coming from? That flow itself should be part of this application … this
  is not the actual pipeline it will only be a information of how the pipeline really works … the pipeline has to be running
  somewhere else … the best way … is that the pipeline itself tells … this will be a map of … which one is connected with
  which thing what combination we are doing and what is finally ending it in the data warehouse or in the data source index."
- Two kinds of data: the warehouse ("an actual iceberg catalog … a known data like uniform data system because we are
  creating it") and the connected sources ("not really replicating the data … directly connecting to the source").
- "we have a data viewer for warehouse but we do not have data viewer for … the data sources that we are connected … the
  connected data source thing they might be different it could be excel file … it could be an api … so that is why the
  data viewer will not work same as a data warehouse so we need to separate both of them."
- Grounding and data access stay as they are.

What follows (proposed, 2026-10-08):

1. **Data sources** is the area's first place (renamed from "Data source index"; the index is part of a source). Per
   source: its structure (the index), and a **viewer** shaped by its kind — rows of a SQL table (≤100 shown, the total, our
   paging), a file's sheets, an API's resources — always through the datasource manager (the reader's data access applied,
   every call recorded), never around it.
2. **Warehouse** stays the viewer of what we keep (Iceberg; one uniform kind).
3. **Lineage** is a map, not a pipeline: datasets (a source's tables, views, files, warehouse tables) and what consumes them
   (programs, dashboards, agents), joined by "made from" edges that say how. Three ways it is filled: told by the pipelines
   themselves (OpenLineage events — the open standard dbt, Airflow, Spark and others emit), read from the sources (a view's
   SQL, parsed), and written by people or agents; plus our own side for free — the datasource manager records which tables
   each program and agent reads. Kept on the platform, versioned and with provenance, like the composition graph.
4. Grounding and Data access unchanged.
5. What an enterprise data system also needs (candidates): freshness and schema-change watch per source (the index already
   marks what is gone); owners per source and table; sensitivity tags (personal data) that suggest masks in data access;
   quality checks with their history; usage (what is read, by whom; what is never read); trust marks on tables; columns
   linked to the graph's concepts (a glossary).

## A data source's lifecycle: one process from every door (the user, 2026-10-08)

The user: "if we add a data source then all the things required or essential for that to happen should be happening …
Think from every place we can add so from the user ui also … from the cli what happens when we manually do it … How
exactly the data sources are getting registered? So all of those things has to be thought out."

Found (2026-10-08): four doors (user app Connections, sacli datasources, the connector agent, files on the engine's disk —
the last rightly undone by the engine). After the platform's record: a connector's ready bridge is not attached from the
user app (the connection never runs, while its state says connected); the engine loads a bridge and the index builds by
itself; the agents are never told (their knowledge names sources by hand); lineage, data access review and grounding are
not started; removal leaves the index and knowledge behind; the name is the key everywhere.

To build — one lifecycle the platform runs whatever the door:
1. The connector's bridge attached on create (the ready bridges held by the platform, not the engine).
2. State from proof: waiting for the engine → testing → ready (tables found) or failed (why) — never "connected" untested.
3. The index built (already so).
4. Every agent's composition carries the project's live sources (kind, dialect, description) as a generated node; no
   concept names sources by hand.
5. Lineage: the source's tables become datasets when the index has them.
6. Data access: a new source asks for its rules and sensitivity to be reviewed (open or closed by default: to decide).
7. Removal reverses each step; the name is fixed once chosen (a title can change).

## Who writes source, and where (the user, 2026-10-07)

**In the user's words:** a dashboard or another program is built either through the CLI, or by the engine altogether —
from the chat: "hey, build this dashboard" (on the admin side, that is also a path). In that case the engine is again
writing into the work folder. If the work folder cannot live anywhere, what is the point of another folder? Why not the
same thing in state? What is special about it that cannot, and should not, be done in state?

*So:* nothing is special about a folder. The source lives on the platform — each program build keeps the source it came
from; knowledge is the graph's nodes. Every author — a person with the CLI, or the engine's builder agent from a chat —
works the same way: take a copy from the platform (or the template), edit it in a scratch folder of its own, send it back
(`program:build`, `graph import`); the platform keeps the new version, the engine downloads it. The scratch folder sits
in the project's folder on the engine (`~/.superatom/<project>/author/` for a person; a builder session's own
folder for the agent). Two rules keep one path: the engine's downloaded copies are never edited by hand, and an author's
folder is never read by the engine as truth. It is not the agents' shared `workspace/`, which holds only what the engine
puts there. Still to build: taking a program's source (and knowledge, as files) back from the platform — `program pull`.

## Keys follow the same tree as people (the user, 2026-10-07)

**In the user's words:** eventually the agents will do much of this work; this could be a security nightmare, so do it
properly. The hierarchy: a super admin creates an organisation; the organisation has its own permission system — its
admin can create and delete projects and do whatever can be done from the UI — and the structure flows from
organisation to project, including the ability to create keys; then the project owner does things inside it. Not only
humans: the keys themselves have this hierarchy. As long as it is structured and nothing flows in reverse — capability
only goes downstream, like a tree — we can do almost anything. Creating an organisation is for humans only; there will
never be a key for the super admin. One source of truth, one structural identity, in the CLI and on the backend.

*So:* a key belongs to one node (an organisation or a project) and holds capabilities of that level — the same names
roles use; at most what its maker holds now (checked on every call); it may make keys only at or below its node, never
more than it holds; a key's children go when it goes (revoked or cut, they are cut too); every door a person uses takes
a key, checked by the same rules; every key action is audited with the key and its maker.

*As built:* `agent_keys` / `org_keys` hold `capabilities` and `made_by_key` (a key of the same node, or `org:<id>` for
a project key an organisation key made). What a key holds = what it was given ∩ what its maker holds now — up the chain
to the person at its root (`keyHolds`, `AgentKeys.holds`). A key is in force only while every key above it is (the
ProjectDO asks the OrgDO for an `org:` parent). The Worker takes `Authorization: Bearer sak_…` on the REST API: a
project key in its own project (asked of the ProjectDO's `/key-access`), an organisation key in its organisation (the
OrgDO's `/key-access`) and, holding `org.projects`, in every project of it with every project capability. A key revokes
only keys below it; revoking closes the connections of every key it cut. `/api/organizations` takes only a person's
token. The CLI is the same tree: `sacli projects`, `sacli keys [--project]`, `sacli api`.

## Everything is a program (the user, 2026-10-07)

**In the user's words:** the domain scripts, like allocation.mjs — we can get rid of them and only have programs. If in a
program the React part we do not use, only the backend part, then it's the same thing; so everything could be just a
program. They will also have their React thing, but we may or may not use it: the agent uses it and gets the data. We
do not need two different kinds of thing — programs are one category, and that is enough; we do not need to invent
another type. The project app we see today is also just a collection of programs.

Someone (a person, or an agent) builds either a program or a dashboard — why should they be different things? What is
the purpose, and how are they used? If we build a dashboard, why should it not also have the STATE concept? Everything
is one session: every session has a domain and a list of programs. A dashboard is also a program, or a report —
everything is a program; there is no separate concept of a dashboard. We may have a special thing called a dashboard,
because we want a specialised version for some people — that is what goes in the dashboard section — but it is nothing
different from a program, and people can ask questions below it, if they have the permission (the permission system
covers them too).

**A full application, not only small programs (the user):** a program is like one module — it does something individually
and has a React view. But an application can have many things: a library or a system, a full application. If all we
have is single programs, 300 of them each done on its own, disconnected — what if they need common libraries, and what
about a completely separate application? Otherwise we give up that capability and can only have small Node programs
with a React view, not a full system. And: why would there be a separate app store, if we keep metadata and download
files? A built Node.js and React program is the same thing as a small one when it comes to the file system. If
everything becomes an agent session, that is quite good — build it; and while doing it, clean up the older versions
of things that are no longer necessary.

**So, one kind — the program — that scales from a function to a full application:**
- A program is a package: any number of modules, any number of server functions, any number of React blocks (screens),
  and the slice of STATE it owns. A full application is one program with many blocks (its screens and its own
  navigation), not a different kind of thing.
- Common code is a **library program** — functions, no blocks, no STATE — that other programs name (`uses`, by name and
  version); the engine builds a program with the libraries it uses, from the catalogue, and records which versions (by
  hash) went into it. Programs may also call one another's functions at run time.
- **One store:** the program catalogue — metadata in the project's Durable Object, each build (source included) in R2.
  No separate app store: the project app becomes an application program (or a few) on library programs.
- **Everything is an agent session:** a session is a domain and its programs, with STATE; a dashboard is a program (an
  application) offered in the dashboard section to the people allowed, and a question asked beneath it opens a session
  on it. The domain scripts (`allocation.mjs` and the others) become library programs the domain's programs and its
  agent use; the graph keeps only knowledge.

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
| project homes only under `~/.superatom/<projectId>` (the old in-repository `vm/projects` is gone) | — |
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

### One kind of agent: the ICA with concepts (2026-10-06)

**In the user's words:** remove all reader — unified agent — the composer is the only thing. I don't see any reason why
the connector has to be another agent; think of it like this: it's an ICA (intelligent coding agent) with different
concepts and other things. Some concepts we will add, for example for the connector, so it's also going to be the same
thing. We will try to figure out how to create domains for our internal things — not only for the user, it could also be
for the user; make everything uniform. But at the current time I do not want the reader, I just want the composer.

*Done now:* a dashboard's typed question is a composer turn in a platform session like every other door (session-seam
`ask`, opened on the agent of the domain the screen is about, with what the person is looking at going with each
question); the word "reader" (as an agent) is gone from the dashboard and its wire. *Later:* the connector (and the other
internal agents) become the same ICA given an internal domain of concepts — connecting a source, grounding — rather than
agents of their own.

## Connecting: one handshake (2026-10-08)

Every client opens `wss://<platform>/_ws/<project>` and sends one `hello` first; the hub answers with one `welcome`
(`ProjectDO.welcomeFor`), and nothing else is broadcast about who joined or left.

| Client | Opens with | Goes to | Registered as |
|---|---|---|---|
| a person's tab or device (user app, admin console, iOS) | `?token=<their JWT>`, hello `{ role: 'runtime' \| 'admin' }` | their own **UserDO**, which links them to the project (`personLink`; one link per person, project and surface, shared by their tabs) | `runtime` / `admin` (admin only for a superadmin) |
| the engine | `?key=<engine key>`, hello `{ role: 'code-engine', key, instanceId, epoch, modelsHash }` | the **ProjectDO** | `code-engine`, one at a time (a newer one fences the older) |
| an agent key (sacli) | `?agent=1`, hello `{ role: 'agent', key }` | the ProjectDO | `agent`, with what its key holds |
| a service identity (the ChannelDO, the Teams bot) | `?token=<its service token>`, hello `{ role: 'runtime', token }` | the ProjectDO | `runtime`, admitted as a member |

The welcome: `{ wsId, type, project }`, plus — for people, agents and services — what they see with and may do
(`scopes`, `caps`); for the engine, what it runs with instead: the project's `profile` and the platform's model list
(only when its hello named another hash). A socket's messages that arrive while its hello is still being handled wait
for it, so a client may send its first request right behind the hello. After a welcome, a client sends again what it
watches (a new connection watches nothing: `log:attach` and the like). A deploy restarts the Durable Objects; every
client reconnects by itself and is welcomed again.
