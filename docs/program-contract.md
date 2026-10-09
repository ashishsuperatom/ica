# The program contract

What every program is, and what a builder — an agent or a person — must do so that what is built fits the platform
and does not drift. A program lives in an agent: the template is the agent template,
`vm/packages/project-template/start/agent-template/` (agent.json, its domain in knowledge/index.mts, its programs) —
`sacli agent init <folder>` makes one, `sacli agent push <folder>` imports the domain, builds each program and writes the
agent. A single program builds with `sacli program build <folder>`.

## What a program is

A program is **a Node.js side and a React side**, built together, identified by the hash of what was built, immutable.
It takes part in an agent's sessions through **STATE**: it owns one slice of STATE and offers functions over it. A
**dashboard** is not a separate application: it is an agent whose programs' views are drawn together in its session.

## The folder

```
manifest.json   who it is, where it attaches, what it owns and offers
server/         the Node side — index.ts exports the functions (run, and any others it declares)
web/            the React side — index.tsx exports one component per ui block
doc.md          what an agent needs to use it: what it shows, which STATE fields to set, its actions
```

Relative imports carry their extension (`./query.js` for `./query.ts`). Tests (`*.test.ts`) are left out of the build.

## The manifest

| Field | Is |
|---|---|
| `id`, `name`, `version` | its identity; `name` is how agents refer to it (the newest published build) |
| `scope` | `global`, `group:<name>` or `user:<id>` — who sees it |
| `owner` | set by the engine to whoever asked for the build |
| `attachesTo` | its place in the organisation's knowledge index (`procurement.contract`) |
| `reads` | the data it reads (`datasource:<id>`) |
| `ui.blocks` | the views it draws, by name |
| `package.owns` | its slice of STATE (`STATE.<owns>`), named once; no other program may own it |
| `package.schema`, `package.initial` | the slice's fields and their starting values; an op that breaks the schema is refused |
| `package.reads` | STATE paths whose change re-runs it automatically (a global filter) — optional |
| `package.functions` | `run` (the default) and the others it offers, each with what it produces (`data`, `action`, `view`) |
| `package.actions` | what it suggests to the person: plain ops, or a call to one of its functions |
| `package.commands` | writes outside STATE (approve, save) — through the governed write path, never STATE |
| `package.doc` | `doc.md` |

## Functions (the Node side)

```ts
export async function run(state, ctx) { … }
```

- `state` is the **whole STATE, frozen**: it reads anything (a global filter included) and changes nothing directly.
- `ctx.set(patch)` changes **only its own slice**, only fields its schema declares. The engine enforces this.
- `ctx.params` are the parameters of the call (an action's, a run button's).
- `ctx.services.query(source, sql, params)` is **the only way to data**. It goes through the datasource manager: the
  reader's data access policies are applied to every table read, the query is read-only, and it is recorded.
- `ctx.services.append(source, table, rows)` is **a program's write**: rows appended to one table of a source that
  takes writes (a DuckDB source does). It goes through the manager, which records it (who, which table, how many) and
  forgets that source's cached reads, so the next read sees it. Only programs write; an agent's tools read. A
  correction is a new row beside the original, never an edit of it.
- `ctx.services.who()` is who the work is for (`{ id, email? }`, or null for the platform's own work): what a program
  records beside a decision it writes.
- `ctx.services.program(domain, file, args)` runs one of a **domain's programs** (the composition graph's — the
  domain's logic in one place, such as the query every view of a topic stands on) where the platform places them, for
  whoever asked (their data access goes with the run), and returns the JSON it prints — totals and pages, never every
  row. A program reaches a domain's logic this way instead of copying it.
- It returns `{ answer?: { markdown, blocks?, world? }, actions? }`. The answer is markdown; a marker line
  (`:::table name.json`, `:::kpis summary`) names a block the answer carries in `blocks` (`{ title, columns: [{ key,
  label, unit? }], rows }`, or with its `type`: kpis, figure, bars, grid, table, facts, text). `world` names the
  headline figures the step showed (`{ red: 12, remaining: 5214260 }`): the decision memory compares a later step's
  world with them to say whether the situation has moved.

## Data rules

- Totals are computed in the source query, never by adding up the rows shown.
- At most 100 rows are shown or returned; say the total.
- Parameters are values the person can change (STATE fields, actions), never constants in the code.
- Nothing about one organisation's data belongs in the platform; it belongs in the project's programs and knowledge.

## Libraries — code shared by programs

- A **library** is a program with `"kind": "library"`: functions (`server/`) and components or formats (`web/`), no
  STATE and no blocks of its own. Common code lives in one — never copied into each program.
- A program names what it uses — `"uses": ["<name>"]` (its newest build) or `"<name>@<hash prefix>"` (a pinned one) —
  and imports `@lib/<name>` (or `@lib/<name>/<file>.js`). The build records the library build it links
  (`uses: [{ name, hash }]`, inside its hash); the library is kept once, as its own build, and every program that links
  that build loads the same module — once per engine, once per page — however many use it.
- Build a library before the programs that use it (`sacli agent push` does). One build of a library in all a program
  links: two builds of one library are refused.

## The view (the React side)

- One export per ui block, named in PascalCase (`unsettled-trips` → `UnsettledTrips`), drawn with `{ slice, state }`.
- **Controls are `<Intent>`s** (`@superatom/ui`): `ops` (set/add/remove on STATE), an `action`, or a `call`, and
  `to="current"` (change this view) or `to="new"` (open a new block). Nothing else changes STATE.
- **Where a control lands — the rule for every view:** only the filter controls above a view (its chips, breakdown
  and window pickers) change it in place (`to="current"`). Every other click — a row, a bar, a card, a next move, a
  decision — is a step taken and opens a new block below (`to="new"`; `destinationOf(ops)` says so for next moves).
  The new block's title carries the path that led to it (`Spend · Raw Materials › Coal`), so the thread reads as the
  drill-down it was.
- **Blocks that explain and lead:** a block may carry `about: { means, calc }` — shown behind an ⓘ in its head: what
  it means and how it is worked out (the tables and the formula). `cards` are the things to act on (a figure, the line
  beneath, a tone, an `about`, and a `move`). A table column's `tones` colour its values as tags.
- **Opening another agent:** a row's (or card's) move may name another agent — `rowMove.open: { agent, start?, set:
  { "<slice>.<field>": "<the row's column>" }, fixed: { "<slice>.<field>": value } }` — and the app opens that agent with
  those fields over its start (only slices and fields its programs declare).
- **How values are written:** the platform's formatters by default. A program that writes a unit its own way exports
  `formats` from its React side — `{ INR: (v) => …, MT: { full, short } }` — taking a library's when an application
  writes values its own way everywhere (`export { formats } from '@lib/<name>'`, or `{ ...libFormats, … }`). Every
  table, figure and chart in the program's steps writes values that way: the program's over the library's, the
  library's over the platform's.
- Only the platform's libraries are imported: `react`, `react/jsx-runtime`, `react-dom`, `echarts`, `@superatom/ui`,
  `@superatom/design` — and the libraries it uses (`@lib/<name>`). Anything else is the program's own code.
- Views are loaded from the platform (R2) by hash, so they draw even when the engine is asleep.

## Lifecycle

1. **Build** — the source is sent to the engine (`program:build`); the engine compiles both sides, sets the owner, and
   uploads the bundle; the platform checks it against its hash and keeps it as the builder's **draft**.
2. **Try** — an agent that lists the program by hash (or the owner's session) runs it.
3. **Publish** — its owner or an admin publishes it (`program:publish`); agents that name it get the newest published.
4. **Change** — a change is a new build, a new hash; the old one stays (sessions keep the hash their STATE names).

Everything is in the audit history; builds and runs are visible as activities.

## What builders usually get wrong (check before handing over)

- A change applied in one place only, instead of everywhere it belongs.
- Removing or rewriting what worked; features are hidden, never removed.
- A flow nobody clicked through: every control works, no runtime errors.
- A number without a source, or two views that disagree.
- Building more than was asked; answering a different question.
- Fixing the symptom, not the cause.
- Long silent work: keep steps short and visible.
