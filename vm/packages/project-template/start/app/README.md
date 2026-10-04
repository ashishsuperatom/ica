# The {{NAME}} dashboard

Deterministic code on the domains' programs: no model.

- `server/` — the application the engine hands every `app:` payload. The project's own files: `facts.mjs` (which program
  gives which rows), `dimensions.mjs` (what a question may be narrowed or broken down by, and the column carrying it on
  each fact), `project.mjs` (the name, the starting points, how members are found), `capabilities/` (one folder per view)
  and `lib/`. The rest is the platform's template (`vm/packages/project-template`), the same in every project.
- `web/` — the client, the same as every project's: it draws what the catalog sends (name, starting points, currency).
- `server/run-all.mjs` opens every view and records it in `runs/`; the recordings are the client's test fixtures
  (`web/public/mock`). `server/verify.mjs` checks the application against the composition graph. Run both from
  `vm/apps/engine`: `pnpm exec tsx <project>/app/server/verify.mjs`.

Every table is one page of at most 100 rows; counts and sums come from the source (the programs' `--totals`).
