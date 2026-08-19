# Template — NetSuite via SuiteQL (`kind: sql`, `dialect: suiteql`)

NetSuite's SuiteQL is Oracle-flavoured SQL over the REST API, so the analyst treats it as a `sql` source and
writes SuiteQL (not HTTP). You write a bridge that authenticates, runs SuiteQL, and returns clean rows.

## Connect
- **Auth: OAuth 2.0 machine-to-machine.** Build a **PS256** JWT (RSASSA-PSS, SHA-256, salt length **32**) —
  header `{alg:"PS256", typ:"JWT", kid:<CERT_ID>}`, payload `{iss:<CLIENT_ID>, scope:["rest_webservices","suite_analytics"], aud:<token_url>, iat, exp:+1h}` — signed with the account's private key
  (`node:crypto`, no deps). Exchange it (`grant_type=client_credentials`, `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`) at
  `https://<ACCOUNT>.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token` for an access token; **cache + auto-refresh**.
- **Query:** `POST https://<ACCOUNT>.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql?limit=1000&offset=N`
  with header **`prefer: transient`** and body `{ "q": <sql> }`; **page while `hasMore`** (accumulate all rows).
- **Introspect:** `SELECT * FROM oa_tables` (SuiteQL's own catalog).
- Creds in the source's `.env` (`NETSUITE_ACCOUNT`, `NETSUITE_CLIENT_ID`, `NETSUITE_CERT_ID`, `NETSUITE_PRIVATE_KEY_PATH`); read via `process.env`, never hardcode.

## Common issues (do these every time)
- **Strip per-row metadata.** SuiteQL returns a `links` field on every row — `delete row.links` before returning, so rows are clean data.
- **Dialect:** `FETCH FIRST n ROWS ONLY` (not `LIMIT`/`TOP`), `ROWNUM`, standard SQL functions; bind values with `@name`.
- **Performance / planner trap (put this in the source `description` for the analyst):** on large tables (millions of rows, e.g. `timebill`), an unbounded `SELECT *` / `FETCH FIRST n` can **time out** — the planner won't push the row-limit stopkey down. `COUNT(*)` and aggregates are fast. To sample or read, **filter by an indexed column first** (an id range or a recent date range), then limit.

## Verify before reporting success
`GET /sources` shows `ready:true` → `POST /introspect` returns real tables → `POST /query` with `SELECT COUNT(*) FROM customer` returns a real count.
