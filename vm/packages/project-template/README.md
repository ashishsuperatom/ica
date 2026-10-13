# Project template

How a project is built, as working examples — shipped to every clone as `platform/template` (scripts/build-sdk.mjs), and
read first there: `TEMPLATE.md` is its README.

- `start/agent-template/` — an agent: `agent.json`, its domain (`knowledge/index.mts`) and a program (`programs/example/`:
  STATE inputs and derived fields, server functions, a React block from `@superatom/ui`). `sacli agent init` writes it
  (embedded into sacli at build).
- `programs/src/views/` — the views library: the view engine (`server/app/`: the same in every project) and the place a
  project's own views, facts and dimensions go. `doc.md` says how to write a view.
- `programs/src/app-views/` — the program that shows the views in a session (uses `@lib/views`).
- `shared/knowledge/shared/` — helpers domain programs use (`sql-rows.mjs`, `js-rows.mjs`).

A project builds `views` (with its own views) and `app-views` like any program: `sacli program build`, then
`sacli program publish`. A change to the view engine is made here and copied into each project's `programs/views/`.
