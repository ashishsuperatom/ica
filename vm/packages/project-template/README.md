# Project template

How a project is built, as working examples — shipped to every clone as `platform/template` (scripts/build-sdk.mjs), and
read first there: `TEMPLATE.md` is its README. It teaches the current design only: an agent is its UI, STATE, ICA and
programs; an ICA's domain is the platform's; a question's knowledge is concepts reached through its intent; every
program step follows the step standard (`ui/design/DESIGN-SYSTEM.md`).

- `start/agent-template/` — an agent: `agent.json` (its programs, its start, its ICA on the platform's domain), the
  concepts its questions stand on (`knowledge/index.mts`) and a program on the step standard (`programs/example/`: a
  filter whose choices are computed from the data, STATE inputs and derived fields, KPI cards, words first, a chart
  section and a closed table, a drill by row(), option functions). `sacli agent init` writes it (embedded into sacli at
  build: `cli/test/agent-template.test.mts` builds what it writes).
- `programs/src/views/` — the views library: the view engine (`server/app/`: the same in every project) and the place a
  project's own views, facts and dimensions go. `doc.md` says how to write a view.
- `programs/src/app-views/` — the program that shows the views in a session (uses `@lib/views`).
- `programs/src/maps/` — an example of a front-end npm package in a library (Mapbox GL): listed in its `package.json`,
  imported the usual way; `sacli` bundles it. No project uses it; any other package is added the same way.
- `shared/knowledge/shared/` — helpers the views' fact programs use (`sql-rows.mjs`, `js-rows.mjs`: totals and pages).

A project builds `views` (with its own views) and `app-views` like any program: `sacli program build`, then
`sacli program publish`. A change to the view engine is made here and copied into each project's `programs/views/`.
