# Project template

A project home (`~/.superatom/state/<projectId>/`) holds the project's knowledge and its dashboard. Most of the
dashboard and the program helpers are the same in every project; this is that part, kept in one place.

- `shared/` — the same in every project, kept in step: the dashboard server's generic files (`app/server/`: the
  question state, windows, loader, resolver, the fact reader, the recorder and the check against the composition
  graph), the whole client (`app/web/`), and the helpers programs state their rules with
  (`knowledge/shared/sql-rows.mjs`, `js-rows.mjs`).
- `start/` — what a new project begins with and then owns: `facts.mjs`, `dimensions.mjs`, `project.mjs`, an empty
  `capabilities/`, an empty knowledge index with the two settings every dashboard reads.

```
node vm/packages/project-template/cli.mjs new   <home> --name "<name>" --currency <code> --locale <tag>
node vm/packages/project-template/cli.mjs check <home>    # the shared files a home has changed or lacks
node vm/packages/project-template/cli.mjs sync  <home>    # write the shared files into a home
```

A shared file is changed here and synced to every home, never in one home alone; `check` on every home says whether
they are in step. After `new`: `pnpm install` in `app/web`, then a domain in `knowledge/index.mts` (imported with
`composition-graph import`), its facts, dimensions and views, and `app/server/verify.mjs` until it passes.
