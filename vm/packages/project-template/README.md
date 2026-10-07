# Project template

A project's author folder (`~/.superatom/state/<projectId>/author/`) is where its knowledge and its dashboard are
written — then imported and published to the platform; the engine never reads it. Most of the
dashboard and the program helpers are the same in every project; this is that part, kept in one place.

- `shared/` — the same in every project, kept in step: the dashboard server's generic files (`app/server/`: the
  question state, windows, loader, resolver, the fact reader, the recorder and the check against the composition
  graph), the whole client (`app/web/`), and the helpers programs state their rules with
  (`knowledge/shared/sql-rows.mjs`, `js-rows.mjs`).
- `programs/` — programs every project runs (`app-views`): built into a project's platform with `sacli program build
  vm/packages/project-template/programs/<name>` (the platform keeps the build and its source; the engine downloads it),
  never copied into a home.
- `start/` — what a new project begins with and then owns: `facts.mjs`, `dimensions.mjs`, `project.mjs`, an empty
  `capabilities/`, an empty knowledge index with the two settings every dashboard reads.

```
node vm/packages/project-template/cli.mjs new   <author folder> --name "<name>" --currency <code> --locale <tag>
node vm/packages/project-template/cli.mjs check <author folder>    # the shared files it has changed or lacks
node vm/packages/project-template/cli.mjs sync  <author folder>    # write the shared files into it
```

A shared file is changed here and synced to every home, never in one home alone; `check` on every home says whether
they are in step. After `new`: `pnpm install` in `app/web`, then a domain in `knowledge/index.mts` (imported with
`sacli graph import knowledge/index.mts`, into the platform's graph), its facts, dimensions and views, and `app/server/verify.mjs` until it passes.
