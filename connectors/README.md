# Connectors

Every system Superatom reaches — a database, a SaaS API, an MCP server, any HTTP API — is a **connector** here: one
folder with everything it needs. Two places it can run, one idea:

- **On the engine** (`bridges/<id>/`) — the base: inside the client's network, any driver. Databases and anything that
  needs a connection of its own.
- **In the platform's sandbox** (`catalog/<id>/`) — a fallback for plain HTTP APIs. The request and its principles, in the user's words: `docs/connector-system-request.md`. The design:
`docs/platform-architecture.md` ("Connectors").

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

## A sandbox connector

```
catalog/<id>/
  manifest.json   who it is, the connection form (fields; secrets marked), its auth, the hosts it may call, what it offers
  server.ts       introspect · read · act — written with the SDK, run in a sandbox (a Cloudflare Dynamic Worker)
  web.tsx         optional: its own React view; without one the platform draws the form from the manifest
```

- **Data and actions.** A connector reads *entities* (tables, collections, resources — each with its fields) and may do
  *actions*. Every action says what it changes: `read` (nothing), `write`, or `irreversible`. An action that changes
  anything runs only when a person confirms it; agents ask.
- **No secrets in connector code.** The gateway adds the connection's credentials to each request, as the manifest's
  `auth` says, and only for the hosts the manifest names. Connector code calls `ctx.fetch` and never sees a token.
- **Nothing common is copied.** `src/sdk.ts` holds what every connector needs: `defineConnector`, `json` (retries,
  Retry-After, errors in words), `pages` / `nextLink` (paging), `flatten` / `fieldsOf` (rows and their types from JSON),
  `join`. `src/mcp.ts` is the one MCP client. A better way of doing any of it is written there once; every connector
  gets it at its next build.

## Writing one

1. `catalog/<id>/manifest.json` — see `src/contract.ts` (`Manifest`); `checkManifest` says what is wrong.
2. `catalog/<id>/server.ts`:

```ts
import { defineConnector, json, pages, nextLink } from '../../src/sdk'

export default defineConnector({
  async test(ctx) { const { data } = await json(ctx, 'https://api.example.com/me'); return { ok: true, message: `as ${data.name}` } },
  entities: [{ name: 'orders', fields: [{ name: 'id', type: 'integer', key: true }, { name: 'total', type: 'number' }] }],
  actions: [{ name: 'refund', label: 'Refund an order', description: '…', effect: 'irreversible', confirm: true, input: [{ name: 'id', type: 'integer', required: true }] }],
  read: { orders: (ctx, req) => pages(ctx, req.cursor ?? 'https://api.example.com/orders', req.limit!, (data, h) => ({ rows: data.items, next: nextLink(h) })) },
  act: { refund: (ctx, input) => json(ctx, `https://api.example.com/orders/${input.id}/refund`, { method: 'POST' }).then(() => ({ ok: true })) },
})
```

3. A test in `test/` against a stand-in API, through the real gateway (`gatewayFetch`) and sandbox (`runOp`).
4. `pnpm build` (checks every manifest, bundles each server module with the SDK, hashes it) → `dist/`. Commit `dist/`;
   `scripts/check-all.sh` refuses a stale one. The next control-plane deploy ships it; connections pick it up.

## Built

- `github` — repositories, issues, pull requests; open an issue (write, confirmed).
- `rest-json` — any JSON API: the endpoints a person names become entities.
- `mcp-server` — any MCP server (Streamable HTTP): tools become actions by their hints, resources become entities.
