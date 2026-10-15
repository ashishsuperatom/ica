# Connectors

Every system Superatom reaches — a database, a SaaS API, an MCP server, any HTTP API — is a **connector** here: one
folder with everything it needs, and there is **one kind**: the engine connector (`bridges/<id>/`), run on the engine
inside the client's network, one process per connection. How a connector reaches its data — a database driver, an HTTP
API, a worker of ours in front of one — is its own business; the platform sees one contract. The request and its
principles, in the user's words: `docs/connector-system-request.md`. The design: `docs/platform-architecture.md`
("Connectors").

## An engine connector

```
bridges/<id>/
  manifest.json   who it is: title, description, icon, kind (sql | documents | api), dialect (as SQLGlot names it),
                  levels (project, user), identity (shared, person-key, person-oauth), the connection form (fields;
                  secrets marked; a field may be asked for only `when` another has a value), native packages it needs
  bridge.mjs      export function createBridge({ settings, secrets, drivers, dataDir }) → { id, kind, dialect, description,
                  ready(), test(), query(text, params), introspect(), isTransient(err), close() }
  package.json    its own driver (pure JavaScript), bundled with it at build
```

- **One module, many connections.** A connection is an instance: its settings and secrets, its small pool. The module
  is immutable; its version is the hash of its build. A connection stays on the version it was given until someone
  updates it (`sacli workloads act connection/<name> update`, and `rollback`).
- **test()** signs in and reads something trivial: how the engine knows a connection reaches its source.
- **introspect()** gives each table with its columns (and its rows if cheap): the index needs nothing more.
- **query(text, params)** binds `@name` values in its own way and reads only (its session read-only where the database
  has one). A SQL connector's queries go through the platform's rewrite first (access policies, the row cap, SELECT only).
- **Writing one:** copy the nearest folder (`postgres` for a SQL database, `mongodb` for a document store), change the
  manifest and the driver, `pnpm -C connectors build`, then test it live: `test/live/up.sh` starts six databases in
  Docker with the same data; `test/live/connectors.live.test.mts` runs every built connector against them.

Built: PostgreSQL, MySQL/MariaDB, SQL Server / Azure SQL / Fabric, Oracle, ClickHouse, MongoDB, NetSuite, DuckDB,
SA-WAREHOUSE (the platform's own).

## An API connector

An HTTP API is an engine connector of kind `api`, made on `src/api.ts` (what every API connector needs, written once):
its entities become tables in the index, a query is JSON naming one (`{"entity": "issues", "filters": {"repo":
"acme/app"}, "limit": 50}`), and it may do *actions* — each saying what it changes (`read`, `write`, `irreversible`); one
that changes anything runs only when a person confirms it.

```
bridges/<id>/
  manifest.json   as any engine connector (kind "api", dialect "api")
  connector.ts    export const createBridge = apiConnector('<id>', { description, headers, requires, test, entities,
                  actions, read, act })
  bridge.mjs      export { createBridge } from './connector.ts'
```

- **Nothing common is copied.** `src/api.ts`: `apiConnector`, `json` (retries, Retry-After, errors in words), `pages` /
  `nextLink` (paging), `flatten` / `fieldsOf` (rows and their types from JSON), `join`. `src/mcp.ts` is the one MCP
  client.
- **Its credentials are its connection's**, signed onto each request by its `headers`; like every connector, it holds
  only its own connection's secrets, in its own process.
- Test it against a stand-in API: `createBridge({ settings, secrets, fetch })` takes a `fetch` (test/connectors.test.mts).

## Built (API)

- `github` — repositories, issues, pull requests; open an issue (write, confirmed).
- `rest-json` — any JSON API: the endpoints a person names become entities.
- `mcp-server` — any MCP server (Streamable HTTP): tools become actions by their hints, resources become entities.
