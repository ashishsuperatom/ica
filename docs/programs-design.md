# Programs — one design for every use (decided 2026-11-12, not built yet)

A program is used by an ICA, drawn as a dashboard or inside one, makes reports and takes actions. All of it is **one
program and one way of calling it**. This page is the design the user settled on 2026-11-12; `docs/program-contract.md`
is what is built today and changes to match as each part is built.

## A program
- Every program has a **name** and a **hash** — nothing else names it. ("Package" is gone: a program's slice of STATE is
  *the program's STATE*.)
- It is a set of **functions** (the Node side) and, when it shows something, **views** (the React side). Immutable by its
  hash; a change is a new build.
- **Scope**: a person's own, a group's or the project's; a **guard** (a capability, role or group) on the program or on
  one function. One rule decides **find, inspect and run** alike — a person never finds what they may not run — and
  everything runs with **that person's own data access**.
- Lifecycle: build (the builder's draft) → publish to the person, a group or the project (the project's needs
  `project.publish`) → change (a new hash; open sessions keep theirs) → remove (`sacli program remove`).

## One call: an address and a JSON object
```json
{ "call": "inventory.cover", "params": { "plant": "CUDD", "days": 30 } }
```
- The address is always **`program.fn`**; the params always **one JSON object** — the same two inputs everywhere: an
  ICA's tool, an `<Intent>`, a schedule, an approval.
- Each function **declares itself** in the manifest: its `doc`, its `params` (types, defaults; where a param has choices,
  a function computing them from the data, as filters do), what it `produces`, its `guard`. A call is checked against
  them before it runs; a wrong one is refused with a sentence.

## What a function produces — one runner, four results
| `produces` | result |
|---|---|
| `view` | a **step**: its answer, blocks and STATE — drawn live, filtered in place |
| `data` | **JSON** to whoever called it (another program, an ICA, a check) |
| `report` | a **file** (PDF, XLSX, a page), kept with the session or delivered |
| `action` | an **effect outside STATE** (approve, send, write rows) — always through an approval (below) |

## The ICA's tools (in the shared part of composer-domain and analyst-domain)
| tool | input | gives |
|---|---|---|
| `find-program` | `"words"` | the programs this person may run: name, one line, its functions, its scope |
| `inspect-program` | `inventory` · `inventory.cover` | the program: doc, functions, its STATE, filters · one function: doc, params, what it produces, guard |
| `run-program` | `inventory.cover` `{params}` | a step below the answer (view) · JSON (data) · a file (report) · an approval request (action) |

They replace the programs' docs the engine's code put into every turn. A concept beside them says when a program is the
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
1. `program.fn` with JSON params and declared params; `find-program`, `inspect-program`, `run-program`; "package" gone.
2. Actions and approvals.
3. The scheduler: UserDO, its page, its tools.
