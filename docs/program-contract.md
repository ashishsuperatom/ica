# The program contract

What every program is, and what a builder — an agent or a person — must do so that what is built fits the platform
and does not drift. A program belongs to an agent (what a person opens: its UI, its STATE, its ICA and its programs):
`sacli agent init <folder>` makes an agent's folder from the template (agent.json, the concepts its questions stand on in
knowledge/index.mts, its programs), `sacli agent push <folder>` is the one step: it builds and publishes each program,
imports the concepts and writes the agent, and publishes them — people use it at once (`--draft` keeps it unpublished;
`sacli program publish` and `sacli graph publish` are the single steps). A single program builds with `sacli program build <folder>`.

## What a program is

A program is **a Node.js side and a React side**, built together, identified by the hash of what was built, immutable.
It takes part in an agent's sessions through **STATE**: it owns one slice of STATE and offers functions over it. A
**dashboard** is not a separate application: it is an agent whose programs' views are drawn together in its session.

## The folder

```
manifest.json   who it is, where it attaches, what it owns and offers
server/         the Node side — index.ts exports the functions (run, and any others it declares)
web/            the React side — index.tsx exports one component per ui block
doc.md          what an agent needs to use it: what it shows, which STATE fields to set, its options
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
| `settings` | the settings it reads, by name — each one the project's knowledge must give; it can read no other (below, "Settings") |
| `ui.blocks` | the views it draws, by name |
| `ui.as` | how a session draws it: `block` (the default — its views as cards in a block, beside the step's answer) or `ui` (its views alone, the whole width, no block and no side space: an interface of its own, laid out by the program — a dashboard, a tool) |
| `package.owns` | its slice of STATE (`STATE.<owns>`), named once; no other program may own it |
| `package.schema`, `package.initial` | the slice's fields and their starting values; an op that breaks the schema is refused |
| `package.reads` | STATE paths whose change re-runs it automatically (a global filter) — optional |
| `package.functions` | `run` (the default) and the others it offers, each with what it produces (`data`, `action`, `view`) |
| `package.options` | its option functions, by name — the next moves it offers, each computed for the step (below, "Options"); an empty list: none |
| `package.filters` | its filters: each a field of its slice and the function computing its choices from the data (below, "Filters") |
| `package.breakdown` | "Break down by": the field holding the grouping in force and the groupings it offers (below, "Filters") |
| `package.commands` | writes outside STATE (approve, save) — through the governed write path, never STATE |
| `package.doc` | `doc.md` |

## Functions (the Node side)

```ts
export async function run(state, ctx) { … }
```

- The server side's types are the platform's: `import type { ProgramContext } from '@superatom/program'` (in a clone,
  `platform/program/`), and `ctx: ProgramContext<Slice>`. The engine's services are checked against the same types.
- `state` is the **whole STATE, frozen**: it reads anything (a global filter included) and changes nothing directly.
- `ctx.set(patch)` changes **only its own slice**, only fields its schema declares. The engine enforces this.
- `ctx.params` are the parameters of the call (an option's, a run button's).
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
  row; with `{ notes: true }`, `{ data, notes }` (what the program noted: a read that reached its row limit). A program
  reaches a domain's logic this way instead of copying it. `ctx.services.settings(domain)` gives the domain's settings
  — only those the manifest's `settings` names (below, "Settings").
- `ctx.services.config()` is **how the organisation reads time, money and words** — its configuration: language,
  locale, time zone, currency (null when none is set), the week's first day, the financial year (`{ startMonth }` or
  `{ months: [{ name, from, to }] }`). Never write a locale, a currency or a financial year into a program or a setting:
  read them here (a domain's programs read the same in `configuration.json`, beside `settings.json`). Values written with
  the platform's formatter (`fmt`, `money`) already follow it.
- A project's no-model views (a figure, its breakdown, its trend, with filters, windows and next moves) are the **views
  library** (`@lib/views`, in the template: `template/programs/views/doc.md`); `app-views` shows them in a session.
- It returns `{ answer?: { markdown, blocks?, world? } }`. The answer is markdown; a marker line
  (`:::table name.json`, `:::kpis summary`) names a block the answer carries in `blocks` (`{ title, columns: [{ key,
  label, unit? }], rows }`, or with its `type`: kpis, figure, bars, grid, table, facts, text). `world` names the
  headline figures the step showed (`{ red: 12, remaining: 5214260 }`), kept with the answer.
- `export async function check(state, ctx)` (optional): what is wrong with its slice **as a change from outside would
  leave it** (an agent's answer, a person's ops) — `ctx.slice` is that slice; return a sentence, a list, or nothing. The
  schema says a field's shape; `check` says what only the program knows (a dimension its model has). A refused change is
  not kept: the answer stands without it and says so. Its own writes (`ctx.set`) are never checked again.
- A function that throws while running after a change costs only its own part: the step says plainly that part could
  not be shown, its slice stays as it was, the other programs run on, and the reason goes to the operators. Throw a
  failure — never write it into the answer as text.

## Settings — declared, so they never go missing

A setting is a value the project's knowledge gives (a threshold, a floor, a token). A program **names every setting it
reads** in its manifest — `"settings": ["remaining-budget-floor"]` — and a library names its own (the programs that use
it may read them too). The platform holds the two together:

- **built** — a program that names a setting no domain of the project's knowledge gives is refused, naming it;
- **run** — `ctx.services.settings()` gives only the declared ones; reading another (or asking whether it is there) fails
  at once, saying to declare it;
- **knowledge published** — a version that would take away a setting a published program declares is refused, naming
  both.

Facts about the organisation are **never settings**: currency, locale, time zone, the week's first day and the financial
year come from `ctx.services.config()` (a view in the views library: `c.currency()`, the calendars it is given).

## Options — the next moves a program offers

The moves offered under a step are **functions, never a fixed list**: each is computed for the step it is at, and offered
only where it holds there. Whoever builds a program — an agent or a person — offers moves only this way.

```ts
// manifest:  "package": { "options": ["stockCovers", …] }
export async function stockCovers(state, ctx: OptionContext): Promise<Option | null>
```

- It is given the step: `state` — the whole STATE, frozen; `ctx.context` — what the session was started with;
  `ctx.history` — its answers down to this step, in order (`{ question?, markdown }`); `ctx.services` — only
  what reads: `query`, `settings`, `config`, `who`.
- It returns **one move, or `null`**: `{ label, why?, call?: { fn, params? }, ops?, to? }`. The label is said from what
  is there (`Free stock covers RFQ-01405: 2,711 MT for 2,623`), never a phrase that would read the same at every step.
  The move is the program's own: one of its functions to call, or ops on its own slice. `to` defaults to `new`.
- It **finds out; it never does**: no `ctx.set`, no writes. An option explores — it never leads to an effect outside
  (a function that `produces: "action"`, such as sending an email, is never an option's move). Its work is the check — does this move make sense here, from
  the STATE, the history and the data? The move itself is done when the person takes it, as an ordinary intent.
- It is **quick**: every option function of the step's programs runs at once after the step, each within a time limit
  (a setting). One that is late, fails, or returns what the contract refuses is left out — the reason to the operators.
- What holds is shown in **one strip at the end of the step**, whatever program offered it. Learned next moves, when
  they come, are option functions too.
- `sacli`/the programs CLI (`programs run`) prints what a program offers at the STATE it left.

## Filters — computed from the data, drawn by the platform

A step's filters are **declared, never laid out**: the program names them in its manifest and the platform draws the
row — the same on every screen (design/DESIGN-SYSTEM.md, rule 19).

```jsonc
// manifest:  "package": { "schema": { "plant": { "nullable": "string" }, "kinds": { "list": "string" }, "by": { "nullable": "string" } }, …,
"filters": [{ "field": "plant", "label": "Plant", "options": "plantOptions", "size": "medium", "noun": ["SKU", "SKUs"], "unit": "money" }],
"breakdown": { "field": "by", "choices": [{ "value": "plant", "label": "Plant" }, { "value": "kind", "label": "Kind" }] }
```
```ts
export async function plantOptions(state, ctx): Promise<{ value: string; label: string; count: number; amount?: number }[]>
```

- A filter is a field of the program's own slice that can mean "all": `{ "nullable": "string" }` (one choice; null is
  all) or `{ "list": "string" }` (several; empty is all). Its `size` is a slot on the row's grid — `small`, `medium`
  (the default) or `large` — never a width.
- Its choices are **computed, never written by hand**: `options` names a function the server side exports. It is given
  the whole STATE (frozen, as the run left it) and read-only services (`query`, `settings`, `config`, `who`), and returns
  the choices that hold something **in the current scope** — each with how many things it holds (`count`, above zero)
  and, when there is one, their amount — so choosing any of them can never give an empty result. A total comes from
  the source, as always.
- **The build refuses** a filter with no `options`, a function `server/index.ts` does not export, choices written into
  the manifest, or a field that cannot mean "all" — each with the sentence that says how to fix it. A choice that holds
  nothing is refused when it is computed.
- After every answer of the program the platform computes them and the answer carries the row: a `:::filters` line
  where the program writes one, else under its first line. A change of filter is an intent to the current block
  (`to: "current"`): the view narrows in place.

## Data rules

- Totals are computed in the source query, never by adding up the rows shown.
- At most 100 rows are shown or returned; say the total.
- Parameters are values the person can change (STATE fields, options), never constants in the code.
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
- A library and the programs that use it move together. In a clone, `sacli agent push` first typechecks every program
  (a type error stops it); a library it builds is then linked into the project's **other** programs that use it too —
  whichever agent they serve — each rebuilt and published (one unchanged builds to the same hash). One that no longer
  builds keeps the build it had, named in a warning.

## The view (the React side)

- **The step standard** (design/DESIGN-SYSTEM.md "A step — the standard"): a step reads the block frame, its filter row,
  KPI cards, a heading and two or three plain sentences, then its sections — each one view at a time, a chart opening
  on its chart with its table a click away, a table section closed to one line until opened — all on the page at once.
  The answer's markdown gives that order: `**Title** — _one line_`, `:::kpis …`, `## A heading` and the sentences, then
  `:::bars …`, `:::table …` (each block may carry `says`: the one line under its title). The framework draws the rest.
- One export per ui block, named in PascalCase (`unsettled-trips` → `UnsettledTrips`), drawn with `{ slice, state }`.
- **Controls are `<Intent>`s** (`@superatom/ui`): `ops` (set/add/remove on STATE) or a `call`, and
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
- **npm packages:** list them in the program's (or library's) `package.json`, run `pnpm install` there, and import them
  as usual — a stylesheet too (`import 'pkg/dist/pkg.css'`). sacli bundles each one the web side imports, with the
  folder's own esbuild (in its devDependencies); a library shares one among programs (`vm/packages/project-template/programs/src/maps`).
- **Charts:** `EChart` (`@superatom/ui`) draws any ECharts option in the design system's chart theme (what the option sets wins), resized with its box, a click handed back (`onPick`) — use it rather than a wrapper of your own.
- Only the platform's libraries are imported: `react`, `react/jsx-runtime`, `react-dom`, `echarts`, `@superatom/ui`
  (`PLATFORM_LIBRARIES`) — and the libraries it uses (`@lib/<name>`). Anything else is the program's own code.
- Views are loaded from the platform by hash, so they draw even while the project's engine is asleep.

## Lifecycle

1. **Build** — `sacli program build <folder>` (or `sacli dev`): the project's engine compiles both sides and the
   platform keeps the build, with its source, as the builder's **draft**.
2. **Try** — an agent that lists the program by hash (or the owner's session) runs it.
3. **Publish** — its owner or an admin publishes it; agents that name it get the newest published.
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
