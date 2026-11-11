# Enterprise connectors — the plan (2026-11-11)

Databases and warehouses, ERPs and CRMs: what every connector must do beyond reading data — be easy to connect, say how
it stands, be indexed well and cheaply, and keep up when its system changes — then which connectors, in what order, and
how each is proven. Built on what exists (connectors/README.md; the index: control-plane `dsi.ts`, engine `dsi.ts`).

## 1. Where the connectors stand today

| connector | kind | sign-in | setup steps | proven |
|---|---|---|---|---|
| postgres, mysql, sqlserver, oracle, clickhouse | sql | shared, person-key | postgres: 3 proven steps; the rest from fields | live (Docker, `test/live`) |
| mongodb | documents | shared, person-key | from fields | live (Docker) |
| duckdb | sql | shared | from fields | live |
| netsuite | sql (SuiteQL) | shared (token-based) | from fields | live (F5's NetSuite) |
| github, rest-json, mcp-server | api | shared, person-key | from fields | replayed (stand-in servers) |
| google-sheets, microsoft-365 | api (a tree) | person's sign-in (OAuth) | the sign-in | replayed; microsoft-365 live |
| sa-warehouse | sql | the platform's own | — | live |

Gaps across all of them: most setups are only their fields (no proven steps, no copyable grants); none says *why*
it is degraded beyond an error line; none notices a **column** changing in a table it has indexed; none reads the
descriptions its system already holds (column comments, labels) except where the driver gives them for free.

## 2. What every connector must do

### 2a. Easy to connect
- **Proven steps** (`manifest.setup`): where it is (reach), a user that may read (sign-in, with the exact commands to
  give it read-only access, to copy), which part to read (schemas, objects — counted by a check). Each check that fails
  says what is wrong *and how to fix it* in the system's own words (`fix`).
- **The least the person must know**: an account identifier pasted as the system shows it (a Snowflake URL, a
  Salesforce domain, an S/4 host) is parsed for them; defaults for everything with one (port, warehouse, API version).
- **The sign-in the system prefers**: a person's own sign-in where the system offers one (OAuth, device code); keys and
  passwords otherwise; a service account where that is the enterprise norm (BigQuery). Read-only always: where the
  system has read-only sessions or roles, the connector uses them and the setup grants only those.

### 2b. How it stands (status)
Every connection already reports ready / starting / degraded / failed (workloads). A connector adds **why**, in words a
person can act on, from three checks it can answer cheaply: *reach* (the address answers), *sign-in* (the credential
works), *access* (what it may read — counted). And, for a SaaS API, **its budget**: the calls left in its window
(Salesforce's daily API limit, HubSpot's per-second limit) — read from the system's own headers, shown beside the
connection, and respected: an index build stops before spending what questions need.

### 2c. Indexed well
- **Phase 1** — names and types, every table or object (as today); plus **what the system already says about them**:
  column comments (Postgres `COMMENT ON`, Snowflake/BigQuery descriptions, HANA comments), Salesforce field labels and
  help text, OData annotations — kept as the source's description (a person's or an AI's never overwritten).
- **Keys and links** — primary keys and foreign keys (Salesforce lookups, OData navigation properties): how tables join,
  for the agents' joins.
- **Phase 2** — row counts, only where cheap (catalog statistics, never a COUNT(*) on a large table).
- **Selective for big systems** — a SaaS org has hundreds of objects, most empty: an object with no rows, or a system's
  own plumbing (history, share, feed objects), is indexed but **disabled by default**; a person enables what matters
  (the index already has enabled/disabled per table and field).

### 2d. When the system changes
Today the index notices tables added and gone (a complete listing), but a table already indexed is skipped — a column
added, renamed or dropped goes unseen. So:
- **A cheap signature per table**, from the system's catalog in one query: its columns and their types, hashed (or the
  system's own last-changed time where it has one — Snowflake `LAST_ALTERED`, BigQuery `lastModifiedTime`, Salesforce
  `If-Modified-Since` on describe). A connector offers it as `signatures()` → `{ table: hash }`.
- **A drift check** on a schedule (by default every 6 hours, a setting) and on demand: the engine reads the signatures,
  the platform compares them with what it holds, and only the tables whose signature changed are read again — added,
  changed and gone, never the whole source.
- **A rename is shown as one**: a table gone and one added with the same columns in the same build are offered as a
  rename, so what people wrote about the old one (descriptions, enabled) can move with it — a person confirms.
- **People hear of it**: "SALES changed: 2 tables added, 1 gone, 3 changed (orders: a column added)" — once, where the
  project's attention items are shown; an agent's knowledge naming a table or column that is gone is marked stale.

### 2e. Used efficiently
- **The work stays in the system**: filters, joins and aggregates are pushed into the source's own query; the 100-row
  limit and paging as everywhere; results cached per person (the key carries the rewritten query and its policies).
- **SaaS reads** honour the budget (2b): batch where the API batches (Salesforce composite, HubSpot batch read), page by
  the system's cursor, back off on 429 with its Retry-After (src/api.ts already does).
- **One pool per connection**, small; a connection idle for a while closes and reopens on the next read.

## 3. The connectors, in order

| # | connector | how it reads | sign-in | index from | change signal | proven by |
|---|---|---|---|---|---|---|
| 1 | **SAP HANA** | SQL (`hdb`, pure JS) | user/password | `SYS.TABLE_COLUMNS`, comments | columns hash | live: HANA express in Docker (~/connector-labs) |
| 2 | **Snowflake** | SQL API v2 (HTTPS) | programmatic access token; key pair | `INFORMATION_SCHEMA`, comments | `LAST_ALTERED` | replayed; live with a trial account |
| 3 | **BigQuery** | REST (jobs.query) | service account (JWT) | dataset/table metadata, descriptions | `lastModifiedTime` | replayed; live with a sandbox project |
| 4 | **Databricks SQL** | Statement Execution API | personal access token | `information_schema` (Unity Catalog), comments | columns hash | replayed; live with a trial |
| 5 | **Amazon Redshift** | SQL (Postgres protocol) | user/password | `SVV_COLUMNS`, comments | columns hash | live: Postgres wire in Docker; a cluster later |
| 6 | **OData** (v2 and v4) | REST, `$metadata` | basic, API key, OAuth client | entity sets, properties, annotations | `$metadata` hash | live: the public OData sample services |
| 7 | **SAP S/4HANA** | OData (6) | basic, API key (sandbox), OAuth | its services' `$metadata` | `$metadata` hash | live: SAP's public sandbox (API key) |
| 8 | **Dynamics 365 Business Central** | OData v4 (6) | Microsoft Entra (client credentials) | API v2.0 `$metadata` | `$metadata` hash | replayed; live with a sandbox |
| 9 | **Salesforce** | REST: SOQL, describe | OAuth client credentials; later each person's sign-in | `describeGlobal` + `describe` (labels, help, lookups) | `If-Modified-Since` | replayed; live with a Developer Edition |
| 10 | **HubSpot** | CRM API v3 | private app token | object and property schemas | properties hash | replayed; live with a test account |
| 11 | **ServiceNow** | Table API | basic; OAuth | `sys_db_object` + `sys_dictionary` | dictionary updated time | replayed; live with a developer instance |

Db2 and Teradata wait: neither has a pure-JavaScript driver, and a native one needs the engine to supply it.

## 4. Proven, and said so
Each connector's status says how far it has been proven: **live** (against the real system — in Docker here, or a
developer account), **replayed** (against recorded real responses or a stand-in following the system's documented
answers), or **from the documentation only**. Live tests read their accounts from `~/.config/superatom/test-accounts.env`
(never committed) and are skipped without them; the replayed tests run in every check.

## 5. Build order
1. The contract's additions — `signatures()` and the drift check (2d), the status reasons (2b) — with the existing
   connectors (Postgres first) giving them; so every new connector is born with them.
2. SAP HANA (live here), then the warehouses (2–5), then OData and the ERPs (6–8), then the CRMs (9–11): each with its
   proven setup steps, its index (descriptions, keys), its signatures, its tests; released to Superatom's registry.
