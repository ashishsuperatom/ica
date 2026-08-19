# fusion5

A separate Superatom project — its own admin project, hub, semantic model, units, and programs,
independent of `totalgroup`. Data source: **NetSuite**, queried with **SuiteQL over the REST API**.

## Identity (admin project · provider = "Local / EC2")
- **Project id**: `1c20400d-99b6-4afb-ba71-0e458a78b1a2`
- **Hub**: `wss://superatom.site/_ws/1c20400d-…` — the local code-engine connects OUT to this
- **Secrets**: in `./.env` (gitignored) + `datasources/fusion5/private.pem` (gitignored)

Compute is **external**: no Fly machine. A local code-engine (a second one alongside totalgroup's) runs
against this folder and connects to the hub.

## Layout
- `.env`          — engine connection (`ICA_*`) + NetSuite creds (`NETSUITE_*`) — gitignored
- `datasources/fusion5/`
    - `bridge.mjs`   — the **NetSuite SuiteQL bridge** (`kind:'sql'`, dialect `suiteql`) — WORKING
    - `private.pem`  — the OAuth signing key — gitignored
- `units/`        — semantic-model units (accumulate)
- `programs/`     — analyst programs (accumulate)

## The data source: NetSuite via SuiteQL
NetSuite's **SuiteQL is SQL** (Oracle-flavoured), so to the agent this is a `kind:'sql'` source — it
writes SuiteQL, not raw HTTP. The bridge:
- **Auth**: OAuth 2.0 M2M — a PS256 JWT signed with `private.pem` (via `node:crypto`, no deps) → access
  token (cached, auto-refreshed).
- **Query**: `POST /services/rest/query/v1/suiteql {q}` with paging (`hasMore`), capped at 50k rows.
- **Introspect**: `oa_tables` catalog.
- Dialect quirks the analyst must use: `FETCH FIRST n ROWS ONLY` (not `LIMIT`/`TOP`), `ROWNUM`, `@name` binds.

Verified live: `SELECT COUNT(*) FROM customer` → 5456; real rows return. Ported from the client's
experiment at `~/broken/superatom/client/fusion5/infra/netsuite`.

## Running it (multi-project — already supported)
Locally it's a second manager + engine in the pm2 ecosystem: `sa-datasources-fusion5` (serves this
bridge on its own port) + `sa-engine-fusion5` (this project's id/hub/key from `.env`).
