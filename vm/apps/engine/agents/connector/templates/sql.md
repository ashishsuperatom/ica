# Template — a SQL database (`kind: sql`)

A relational DB reachable by a driver or a bridge/proxy. The analyst writes SQL in the source's dialect.

## Connect
- Set `dialect` to the real one (`postgres` | `mssql` | `duckdb` | `sqlite` | `mysql` | …) so the analyst writes the right SQL.
- Use a **node built-in / already-present driver** if you can; otherwise a small HTTP bridge/proxy to the DB (the "recorded" connector). No new heavy deps.
- Creds in the source's `.env`, read via `process.env` — never hardcode. `ready()` = true only once a real connection succeeds.
- `query(sql, params)` binds `@name` params in the dialect and returns an **array of clean row objects**.
- `introspect()` returns `{ tables:[{name, ...}], kind:'sql', dialect }` from the DB's catalog (`information_schema`, `sqlite_master`, `oa_tables`, …).

## Common issues (do these every time)
- **Return clean rows** — strip any driver/transport metadata so rows are just data.
- **Page or stream large results**; never silently cap (losing rows is worse than a slow query). If you must bound a runaway, throw a clear "add a filter" error, don't truncate.
- **Large tables:** unfiltered `SELECT *` can be slow/time out. Put a one-line performance hint in the source `description` (filter by an indexed column / date range; aggregates are cheap) so the analyst avoids full scans.
- Note real dialect quirks in `description` (row-limit syntax, quoting, date functions).

## Verify
`GET /sources` → `ready:true` → `POST /introspect` → real tables → `POST /query` with a tiny probe → real rows.
