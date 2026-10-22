# Building a project — the template

Everything a project is built from, as working examples. Read this first, then `docs/program-contract.md`.

| You want | Build | Example here |
|---|---|---|
| what an agent knows: meaning, rules, joins, traps — never numbers | **knowledge**: concepts in a domain of the composition graph | `agent/knowledge/index.mts` |
| an agent: its domain, the programs it runs, where its screen starts | **an agent** (`agents/<name>.json` in a clone) | `agent/agent.json` |
| a screen with state: inputs a person sets (a filter, a choice), what is derived from them, a table or chart, a click that drills in | **a program**: its STATE slice (`manifest.json`), its functions (`server/`), its React blocks (`web/`, from `@superatom/ui`), its `doc.md` | `agent/programs/example/` |
| the next moves offered under a step, each one only where it makes sense there | **option functions** of a program (`package.options` in its manifest), each computing one move — or none — for the step | `agent/programs/example/server/index.ts` (`everyKey`, `largestKey`) |
| many no-model views over the same facts — a figure, its breakdown, its trend — with filters, windows and next moves | **the views library**: one folder per view, on facts (domain programs) and dimensions | `programs/views/` (+ `programs/app-views/`, which shows them) |
| code or components several programs share | **a library** (`"kind": "library"`, imported as `@lib/<name>`) | `programs/views/` is one |
| a front-end package from npm (a map, an editor) | **a library** with a `package.json`: `pnpm install`, then import it as usual — sacli bundles it | `programs/maps/` (Mapbox GL; its token is each project's setting) |

How each piece is made and tried:

- `sacli agent init <name>` writes `agent/` as a new agent's folder; `sacli agent push agents/<name>.json` makes it live in
  the draft.
- `sacli program build programs/<name>` builds a program or a library on the project's engine (a library before the
  programs using it); `sacli program publish <name>` makes the build the one people use.
- `sacli dev` (inside a clone) builds what you change into your own environment on the engine — tried on the real data,
  seen only by you.
- Knowledge: `sacli graph import knowledge/index.mts` → `sacli ask --graph draft "…"` → `sacli graph publish "…"`.

How a program's STATE works (the example program shows each): the slice holds **inputs** (what a person sets) and
**derived** fields (what the program works out); a control changes an input with an `<Intent>` op; the program's `run`
reads the inputs, fetches through `ctx.services.query` (the person's data access applied), sets the derived fields and
returns markdown with marker lines naming its blocks. A filter that narrows the same view changes it in place; a click
that opens another view opens a new block. At most 100 rows reach a screen; totals come from the source.

How a program offers next moves: **never a fixed list**. Each move is a function, named in the manifest's
`package.options`, exported from `server/index.ts`:

```ts
export async function everyKey(state, ctx: OptionContext) {        // import type { OptionContext } from '@superatom/program'
  if (!state.example.filter) return null                           // does not hold here: nothing is offered
  const [all] = await ctx.services.query('SOURCE', '…')            // read-only services: query, settings, config, who
  return { label: `Every key — ${all.keys - 1} more besides ${state.example.filter}`,   // said from the data
           ops: [{ op: 'set', path: 'example.filter', value: null }], to: 'current' }  // or call: { fn, params }
}
```

- It is given the step: the whole STATE (frozen), `ctx.context` (what the session started with) and `ctx.history` (its
  answers down to here). It finds out whether the move makes sense **here**, and returns it — or `null`.
- It never does the work and changes nothing (no `ctx.set`, no writes); it is quick — one that is late or fails is left
  out. The move is the program's own: ops on its own slice, or one of its functions.
- An option **explores**. Something with an effect outside — sending, paying, delivering — is never an option.
- What holds is shown in one strip at the end of the step. `programs run <name>` prints what a program offers.
  The rules in full: `docs/program-contract.md` "Options".

The domain programs' shared helpers (`sql-rows.mjs`, `js-rows.mjs`: totals and pages from a source) are in
`knowledge-helpers/`.
