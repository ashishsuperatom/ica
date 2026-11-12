# Programs — one design for every use (decided 2026-11-12, not built yet)

A program is used by an ICA, drawn as a dashboard or inside one, makes reports and takes actions. All of it is **one
program and one way of calling it**. This page is the design the user settled on 2026-11-12; `docs/program-contract.md`
is what is built today and changes to match as each part is built.

## Tools and programs: one tree, one `inspect` (decided 2026-11-12)

Everything an ICA can use — the platform's tools and the project's programs — is a node in **one tree**, read the same
way. An ICA is given little at the start and reads more only as its work needs; nothing about a tool is written by hand
into a general concept.

**Two trees, fixed areas.**
```
tools.<area>.<tool>        the platform's — areas: intent, data, concept, program, schedule, approval, agent, connection
programs.<program>.<fn>    the project's — made from the catalogue for this person (the project's published programs, and their own drafts); never stored
```
A tool's name ends in its command: `tools.data.query` is `./query`, `tools.intent.find-intent` is `./find-intent`. **Each
tool keeps its own command** — the tree only says what a tool is and how to use it.

**Reading it: `./inspect`, for everything.**
```
./inspect                              the top nodes, one line each
./inspect tools.schedule               that node: its doc, and its children one line each
./inspect 'tools.schedule.*'           the node and its direct children, each with its doc
./inspect 'tools.schedule.**'          the whole subtree
./inspect programs.inventory.cover     a program's function: its doc, params, what it produces
```

**In concepts: double curly braces**, as concepts already write what the engine fills in (`{{sources}}`, `{{currency}}`):
`{{tools.schedule}}` (the node), `{{tools.schedule.*}}` (it and its children), `{{tools.schedule.**}}` (its subtree) —
expanded when the concept is composed, exactly as `./inspect` prints them, for the person it is composed for (their
access applied). A single name is a variable; a dotted path, with or without a glob, is a reference into the tree.

**The protocol: a tool card** (built 2026-11-12: platform-types `tools.ts`). Every platform tool is one card:
```ts
{ name: 'tools.data.query', command: 'query', summary: 'Read a source, in its own language',
  input: './query "<SOURCE>" "<query in the source\'s dialect>"', output: 'JSON rows',
  when: 'To read the data an answer stands on.', how: [...], example: '...', traps: [...] }
```
- The fields are always these (name, command, summary, input, output; When, How, Example, Traps). An **area**
  (`tools.data`) is a card without `command`: what its tools are for; its children are listed under it.
- **What an ICA has is declared in one place, its domain**: the paths its concepts reference. A path grants its whole
  subtree — how much is shown at the start (`{{tools.data}}` lists the tools, `{{tools.data.*}}` gives each whole) is only
  how much is read up front. Every ICA also has `./inspect`. The engine answers an ICA only for those tools.
- **Adding a tool**: write its card at its place in the tree, and its handler in the engine under the same command. The
  tests fail when a card has no handler, a handler no card, a name is not a place in the tree, or a field is missing;
  every `{{tools…}}` a default concept writes must be in the tree. Give it to an ICA by referencing it in a concept of its
  domain.
- The cards travel with the engine release, in code. **Not built yet**: the cards as `tool` nodes of the composition
  graph (versioned, seen in the console's tree, a card's doc editable by a project as a concept is).
- **What it replaces** (done for the platform's tools): the tool lines written into concepts (`analysis/tools`, `intent/decide`, `agents/composer`); each
  domain's `tools` list; the programs' docs the engine put into every turn; `find-program` / `inspect-program` as tools of
  their own (`./inspect 'programs.**'`, and one search over it).

## A program
- Every program has a **name** and a **hash** — nothing else names it. ("Package" is gone: a program's slice of STATE is
  *the program's STATE*.)
- It is a set of **functions** (the Node side) and, when it shows something, **views** (the React side). Immutable by its
  hash; a change is a new build.
- **Two states, nothing else** (decided 2026-11-12):
  - **Draft** — each person's own: only the person who built it finds, inspects and runs it. Every person has their own
    drafts.
  - **Published** — the project's: everyone in the project finds and runs it. A person with `project.publish` publishes
    directly; anyone else's publish is a **request an admin approves** (the approval system below).
  No scopes, shares or guards. What a person sees of the data stays theirs: every run reads with **that person's own
  data access** (the access policies, through the datasource manager).
- Lifecycle: build (a draft) → publish (approved) → change (a new hash, a draft again until published; open sessions
  keep theirs) → remove (`sacli program remove`).
- **Trust**: the shared engine serves internal people only; programs run in the engine as today, not isolated.
  Isolation, when needed, comes with the cell (the person's own engine).

## One call: an address and a JSON object
```json
{ "call": "inventory.cover", "params": { "plant": "CUDD", "days": 30 } }
```
- The address is always **`program.fn`**; the params always **one JSON object** — the same two inputs everywhere: an
  ICA's tool, an `<Intent>`, a schedule, an approval.
- Each function **declares itself** in the manifest: its `doc`, its `params` (types, defaults; where a param has choices,
  a function computing them from the data, as filters do), what it `produces`. A call is checked against
  them before it runs; a wrong one is refused with a sentence.

## What a function produces — one runner, four results
| `produces` | result |
|---|---|
| `view` | a **step**: its answer, blocks and STATE — drawn live, filtered in place |
| `data` | **JSON** to whoever called it (another program, an ICA, a check) |
| `report` | a **file** (PDF, XLSX, a page), kept with the session or delivered |
| `action` | an **effect outside STATE** (approve, send, write rows) — always through an approval (below) |

## Running a program (an ICA's tool)
A program is found and read like any tool (`./inspect 'programs.**'`, `./inspect programs.inventory.cover`) and run with
`./run-program inventory.cover '{"plant":"CUDD"}'` — a step below the answer (view), JSON (data), a file (report), or an
approval request (action). A concept beside them says when a program is the
answer: a tested, published calculation is preferred to a new query where one fits, and the figure says where it came
from.

## On a screen: `<Intent>`
A dashboard is an agent whose program draws its screen; everything done on it is an `<Intent>` — a filter changes its
STATE in place, a click calls a function (`<Intent call="rfq.bestAndFinal" params={{…}}>`) and opens a step. An Intent
may call any program the person may run, so a dashboard can use another program's function the same way.

## The scheduler — every time-based operation
A **schedule** is a call and a time, run on behalf of the person who made it:
```json
{ "call": "sales.monthlyReport", "params": { "region": "West" }, "when": "every month on day 1 at 08:00",
  "deliver": { "to": ["group:finance"], "how": "email" } }
```
- **Kept in the person's UserDO**, fired by its alarm — it is theirs, it runs with their access, never more. The
  ProjectDO keeps a **reference row** (owner, call, next run, status) so admins see every schedule of the project.
- `when`: a recurrence (daily, weekly, monthly, cron) in the organisation's time zone (its configuration).
- It runs any function: a report is made and delivered; data feeds a check or an alert; an action goes through approval.
  The platform wakes the engine when it sleeps; every run is recorded (started, ended, its result or file, delivered
  to whom, or why it failed).
- **Seen** on a Schedules page (each schedule, its next run, its runs; pause, edit, remove) and **managed by ICAs** with
  the same JSON shape: `find-schedule`, `inspect-schedule`, `create-schedule`, `update-schedule`, `pause-schedule`,
  `remove-schedule` — within the person's own rights; what an ICA makes is on the person's page.

## Actions and approvals
A function that `produces: "action"` names **how it is approved**:
```jsonc
{ "name": "award", "produces": "action", "params": { … }, "approval": "approvalRoute" }
```
- The **route is computed** by a function of the program from the params and the data — the requester (a confirm), a
  role, a named person, a chain by rule ("above ₹5 Cr: Procurement Head, then Finance") — never written into the code.
- **Any call** of an action — a click, an ICA, a schedule — first makes an **approval request** (the call, its params,
  who asked, why, the route). Nothing runs yet.
- The request is **kept in the requester's UserDO**; each approver gets an item in **their own UserDO**, in order along
  the route (approve, or reject with a reason). The ProjectDO keeps the index, for admins and audit.
- Approved: the engine runs the action — who asked, who approved, and its receipt recorded. Rejected: back to the
  requester with the reason. An ICA may request an action, never approve one.

## What goes
- The word *package*; the `{ package, fn }` call shape; the agent's list of programs as a separate notion (an agent
  names the calls it starts with).
- The programs' docs injected by the engine into every turn (the tools above replace them).
- `ctx.services.program(domain, …)` and `ctx.services.settings(domain)` — domains no longer hold programs or settings;
  a program reads the settings its manifest names, by name.

## Order to build
1. The tool tree: tool cards (the platform's tools moved onto them), `./inspect` with globs, `{{…}}` references in
   concepts, reach from the domain — **built 2026-11-12** (the cards as graph nodes: not yet).
2. `program.fn` with JSON params and declared params; `programs.*` in the tree; `run-program`; "package" gone.
3. Actions and approvals.
4. The scheduler: UserDO, its page, its tools (tools.schedule).
