# Building a project — the template

Everything a project is built from, as working examples. Read this first, then `docs/program-contract.md`.

| You want | Build | Example here |
|---|---|---|
| what an agent knows: meaning, rules, joins, traps — never numbers | **knowledge**: concepts in a domain of the composition graph | `agent/knowledge/index.mts` |
| an agent: its domain, the programs it runs, where its screen starts | **an agent** (`agents/<name>.json` in a clone) | `agent/agent.json` |
| a screen with state: inputs a person sets (a filter, a choice), what is derived from them, a table or chart, a click that drills in | **a program**: its STATE slice (`manifest.json`), its functions (`server/`), its React blocks (`web/`, from `@superatom/ui`), its `doc.md` | `agent/programs/example/` |
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

The domain programs' shared helpers (`sql-rows.mjs`, `js-rows.mjs`: totals and pages from a source) are in
`knowledge-helpers/`.
