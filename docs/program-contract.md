# The program contract

What every program is, and what a builder — an agent or a person — must do so that what is built fits the platform
and does not drift. The template is `vm/packages/project-template/start/programs/template/`; start a program from it
with `programs init <name>`.

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
- It returns `{ answer?: { markdown, blocks? }, actions? }`. The answer is markdown; a marker line
  (`:::table name.json`) names a block the answer carries in `blocks` (`{ title, columns: [{ key, label, unit? }], rows }`).

## Data rules

- Totals are computed in the source query, never by adding up the rows shown.
- At most 100 rows are shown or returned; say the total.
- Parameters are values the person can change (STATE fields, actions), never constants in the code.
- Nothing about one organisation's data belongs in the platform; it belongs in the project's programs and knowledge.

## The view (the React side)

- One export per ui block, named in PascalCase (`unsettled-trips` → `UnsettledTrips`), drawn with `{ slice, state }`.
- **Controls are `<Intent>`s** (`@superatom/ui`): `ops` (set/add/remove on STATE), an `action`, or a `call`, and
  `to="current"` (change this view) or `to="new"` (open a new block). Nothing else changes STATE.
- Only the platform's libraries are imported: `react`, `react/jsx-runtime`, `react-dom`, `echarts`, `@superatom/ui`,
  `@superatom/design`. Anything else is the program's own code.
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
