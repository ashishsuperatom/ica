# Projects — name → id

Projects are stored on disk **keyed by their unique project id (UUID)** — the same id the engine connects
to the hub with (`ICA_PROJECT`). A **name is a label, not a key**: two projects can share a name (a v2, a
different org), but ids never collide, and renaming a project must not move its folder. So `projects/<id>/`
and `.state/<id>/` are the truth; this file (and each `projects/<id>/PROJECT.md`) carries the readable name.

| name       | project id                             |
|------------|----------------------------------------|
| totalgroup | `22dd6ecd-7878-4739-bb23-bc7703737807` |
| fusion5    | `1c20400d-99b6-4afb-ba71-0e458a78b1a2` |

Layout per project:
- `vm/projects/<id>/`  — committed config: `PROJECT.md`, `datasources/`, `units/`, `programs/`, `.env` (gitignored)
- `vm/.state/<id>/`    — generated state: workspace (seams, `programs/`, `out/`) + the project's DBs (gitignored)

When adding a project, create it under its **id**, add a row here, and set `ICA_PROJECT=<id>` in its `.env`.
The engine already derives every path from `ICA_PROJECT`, so no path is hand-named.
