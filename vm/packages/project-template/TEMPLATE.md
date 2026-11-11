# Building a project — the template

Everything a project is built from, as working examples. Read this first, then `docs/program-contract.md` and the
design system's step standard (`ui/design/DESIGN-SYSTEM.md`, "A step — the standard").

**The words.** An **agent** is what a person opens: its UI, its STATE, the ICA at work in its sessions, and its
programs. An **ICA** is the model at work in a session — its domain, its model, its tools (the composer, the analyst…);
its **domain** is only its first prompt, the platform's (`composer-domain`, `analyst-domain`, …), carried by the engine
release. A question's knowledge comes from its **intent** (the intent graph), which names the **concepts** it stands
on — never from a domain, and nothing is routed by one. **Programs** belong to the agent (built, published, embedded in
its UI, each owning a slice of STATE); **tools** belong to the ICA.

| You want | Build | Example here |
|---|---|---|
| what a question stands on: meaning, rules, joins, traps — never numbers | **concepts** in the composition graph, each said once, reached through intents | `agent/knowledge/index.mts` |
| an agent: its programs, where its screen starts, its ICA | **an agent** (`agents/<name>.json` in a clone) | `agent/agent.json` |
| a step with state: inputs a person sets (a filter, a choice), what is derived from them, figures, words, a chart, a table, a click that drills in | **a program**: its STATE slice and filters (`manifest.json`), its functions (`server/`), its own block (`web/`, from `@superatom/ui`), its `doc.md` | `agent/programs/example/` |
| a filter whose choices are always ones the data holds | **a filter** declared in `package.filters`, its choices computed by a function of the program, with their count and amount | `agent/programs/example/server/index.ts` (`groupOptions`) |
| the next moves offered under a step, each one only where it makes sense there | **option functions** of a program (`package.options`), each computing one move — or none — for the step | `agent/programs/example/server/index.ts` (`everyKey`, `largestKey`) |
| many no-model views over the same facts — a figure, its breakdown, its trend — with filters, windows and next moves | **the views library**: one folder per view, on facts and dimensions | `programs/views/` (+ `programs/app-views/`, which shows them) |
| code or components several programs share | **a library** (`"kind": "library"`, imported as `@lib/<name>`) | `programs/views/` is one |
| a front-end package from npm (a map, an editor) | **a library** with a `package.json`: `pnpm install`, then import it as usual — sacli bundles it | `programs/maps/` (Mapbox GL; its token is each project's setting) |

How each piece is made and tried:

- `sacli agent init <name>` writes `agent/` as a new agent's folder; `sacli agent push agents/<name>.json` makes it live in
  the draft.
- `sacli program build programs/<name>` builds a program or a library on the project's engine (a library before the
  programs using it); `sacli program publish <name>` makes the build the one people use.
- `sacli dev` (inside a clone) builds what you change into your own environment on the engine — tried on the real data,
  seen only by you.
- Concepts: `sacli graph import knowledge/index.mts` → `sacli ask --graph draft "…"` → `sacli graph publish "…"`.
  How they are written: `composition-graph guide`.

## A step, as every program draws it

The framework draws a step; the program gives it the parts, in this order (DESIGN-SYSTEM.md "A step — the standard"):

1. the block frame — the answer's first line, `**Title** — _one line_`;
2. the filter row — `:::filters <slice>.filters`, drawn from the manifest's `package.filters`: each filter a slot
   (small, medium, large), its choices computed from the data in scope by the function it names, each with its count
   and amount, so no choice gives an empty view; "Fewer / More", "Break down by" (`package.breakdown`) and "Clear all"
   in the same row. **The build refuses a filter without a function that computes its choices**, and never takes a
   list typed by hand;
3. KPI cards — `:::kpis …`: a label, one figure coloured by its meaning, one line under it;
4. words first — a heading and two or three plain sentences, said from the data;
5. sections, one view each — `:::bars …` (opens on the chart, its table a click away), `:::table …` (closed to one
   line until opened); each block's `says` is the one line under its title;
6. everything on the page at once.

The program's own React block (`web/`) holds only what is its own; a value a person picks is always one the data offers.

## STATE, filters and next moves

How a program's STATE works (the example program shows each): the slice holds **inputs** (what a person sets) and
**derived** fields (what the program works out); a control changes an input with an `<Intent>` op; the program's `run`
reads the inputs, fetches through `ctx.services.query` (the person's data access applied), sets the derived fields and
returns markdown with marker lines naming its blocks. A filter that narrows the same view changes it in place; a click
that opens another view opens a new block. At most 100 rows reach a screen; totals come from the source.

How a filter's choices are computed — a function named in the manifest, exported from `server/index.ts`:

```ts
export async function groupOptions(state, ctx) {                    // the STATE as the run left it; services that only read
  const got = await ctx.services.query('SOURCE', '…', { … })        // the groups in the scope the other narrowings leave
  return got.map((r) => ({ value: r.value, label: r.value, count: r.count, amount: r.amount }))   // each holds something
}
```

How a program offers next moves: **never a fixed list**. Each move is a function, named in the manifest's
`package.options`, exported from `server/index.ts`:

```ts
export async function everyKey(state, ctx: OptionContext) {        // import type { OptionContext } from '@superatom/program'
  if (!state.example.key) return null                              // does not hold here: nothing is offered
  const [all] = await ctx.services.query('SOURCE', '…')            // read-only services: query, settings, config, who
  return { label: `Every key — ${all.keys - 1} more besides ${state.example.key}`,   // said from the data
           ops: [{ op: 'set', path: 'example.key', value: null }], to: 'current' }  // or call: { fn, params }
}
```

- It is given the step: the whole STATE (frozen), `ctx.context` (what the session started with) and `ctx.history` (its
  answers down to here). It finds out whether the move makes sense **here**, and returns it — or `null`.
- It never does the work and changes nothing (no `ctx.set`, no writes); it is quick — one that is late or fails is left
  out. The move is the program's own: ops on its own slice, or one of its functions.
- An option **explores**. Something with an effect outside — sending, paying, delivering — is never an option.
- What holds is shown in one strip at the end of the step. `programs run <name>` prints what a program offers.
  The rules in full: `docs/program-contract.md` "Options" and "Filters".

A program (or library) that reads a setting **names it** in its manifest — `"settings": ["<name>"]` — and the project's
knowledge must give it: the build refuses one it does not, a run refuses an undeclared read, and publishing knowledge
refuses dropping one in use. Currency, locale, time zone and financial year are never settings: `ctx.services.config()`.

The views' fact programs share helpers (`sql-rows.mjs`, `js-rows.mjs`: totals and pages from a source) in
`knowledge-helpers/`.
