# Storage — where everything is kept

One index of every place the platform keeps data: what is there, who writes and reads it, its limits and how long it
lives. Keep it current: a new table, bucket prefix, KV key, secret or engine file is added here in the same change.
Code that names keys: `control-plane/superadmin/src/files.ts` (R2), `migrations.ts` (every Durable Object's tables),
`vm/apps/engine/engine.ts` (the engine's roots).

## 1. Cloudflare bindings (`control-plane/superadmin/wrangler.jsonc`)

| Kind | Binding | What |
|---|---|---|
| Durable Objects | `GLOBAL` `ORG` `PROJECT` `USER` `DECISION` `CHANNEL` | the six objects (§4) |
| R2 | `PACKAGES` → `frontend-packages` | the platform's files (§2) |
| R2 | `WAREHOUSE` → `sa-iceberg-warehouse` | organisations' Iceberg warehouses (§8) |
| KV | `DOMAINS` | subdomain → project cache |
| KV | `CREDENTIALS` | the provider-credential vault, throttles, credential audit, usage snapshots (§3) |
| Pipeline | `AUDIT` | the audit stream → Parquet in the `superatom-platform` Basin |
| Worker loader | `LOADER` | cloud connectors as Dynamic Workers |
| Assets | `ASSETS` | the admin and user SPAs (`dist/client`) |

Vars (not secret): `VM_URL`, `FLY_ORG_SLUG`, `CLERK_PUBLISHABLE_KEY`, `REPORTING_URL`, `PLATFORM_DOMAIN`,
`WAREHOUSE_ACCOUNT_ID`, `WAREHOUSE_BUCKET`, `TRANSCRIBE_MODEL`.

### Secrets (`wrangler secret`; `.dev.vars` locally)
| Secret | For |
|---|---|
| `JWT_SECRET` | signs and verifies the platform JWT (people 30 days, services up to years); the parcel tickets' HMAC |
| `CLERK_SECRET_KEY` | exchanging a Clerk session for the platform JWT |
| `FLY_API_TOKEN` | managed engine machines (create, start, suspend, stop) |
| `CREDENTIALS_MASTER_KEY` | AES-256-GCM key sealing the credential vault (KV) and connection secrets (ProjectDO) |
| `WAREHOUSE_CATALOG_TOKEN` (+ optional `WAREHOUSE_SQL_TOKEN`, `_CATALOG_URI`, `_SQL_ENDPOINT`) | the Basin catalog and Basin SQL |
| `REPORTING_TOKEN` | the reporting renderer (`REPORTING_URL/render`) |
| `OPENROUTER_API_KEY` | transcription only |

## 2. R2 `PACKAGES` — the platform's files (`files.ts`)

Every key is made by `files.ts`, under its kind and its project; a project's files are found (and removed) by prefix.

| Key | Holds | Writer → reader | Limit · check · lifetime |
|---|---|---|---|
| `parcel/<project>/<sha256>` | a message body too large for one hub frame (JSON) | `putParcel` (via `PUT /api/projects/<p>/parcels/<hash>`, project key or member) → ticketed GET, `bucketStore` in ProjectDO, ChannelDO, UserDO | 64 MB · hashes to its name · ticket and file 30 days, pruned after a later put |
| `programs/<project>/<sha256>.json` | a program bundle (all files as JSON) | engine `PUT /api/engine/<p>/programs/<hash>` → `ProgramCatalogue` | 16 MB · bundle verified in and out · kept (immutable by hash) |
| `dashboard/<project>/<dashboard>/<build>/<path>` | a dashboard build's files | `uploadDashboardBuild` (worker.ts) → `serveDashboard` | 25 MB a file, 200 MB a build · content hash dedupes · current + 5 newest builds kept; all go with the dashboard |
| `attachments/<project>/<session>/<sha256>` | a file a person added to a session | the person's UserDO (`POST /api/sessions/<p>/<s>/attachments`) → the engine `GET /api/engine/<p>/attachments/<s>/<hash>` | 20 MB (checked before reading, both ways) · hashes to its name · goes with its session (`prefixOf.session`) |

## 3. KV

`DOMAINS`: `dom:<subdomain>` → project id, 1 h (GlobalDO `domains` is the truth).

`CREDENTIALS`:
| Key | Holds | Lifetime |
|---|---|---|
| `agent-credentials` | the vault: provider keys for agents (`{entries, groups, spent}`), sealed `v1.<iv>.<ct>` with `CREDENTIALS_MASTER_KEY` | kept |
| `throttle:<project or ->\|<ip>` | failed credential fetches | 5 min window |
| `audit:<project>:<ms>-<rand>` | a credential handed out (provider, key id, ip) | 30 days |
| `usage:<entryId>` | a provider key's observed usage | refreshed after 5 min |

## 4. Durable Objects (SQLite, migrated by `@superatom/migrate`; each has `_migrations`)

**GlobalDO** `global` — `superatom_users` (platform admins), `organizations` (registry, DO name), `domains`
(subdomain → project, the truth), `model_catalogue`, `mobile_login_code` (one-time code → JWT, 60 s, single use),
`price_list`.

**OrgDO** `<org>` — `users` (email, clerk id, org role), `projects` (soft-deleted), `org_roles`, `org_keys`
(`sak_org_…`, SHA-256 only), `org_audit`, `credit_ledger`, `budgets`, `billing_details`, `warehouse_ops` (what was done
to the warehouse, with ms), `warehouse_tables` (owners); legacy `datasources`, `conversations`, `messages`.

**ProjectDO** `proj:<project>` — the project's record and hub. Storage keys `projectName`, `orgId`. Tables:
- who may do what: `access` (by email), `access_domains`, `roles`, `groups`, `group_members`, `members` (legacy +
  service identities `svc:<channel>`), `agent_keys` (`sak_<project>_…`, SHA-256 only), `access_policies`,
  `access_attributes`, `access_version`, `warehouse_grants`;
- the engine: `api_key` (the project key `sk-proj-…`), `fly_machine`, `engine_running`, `profile`, `message_queue`
  (for a sleeping engine, 60 min), `engine_sources`;
- the hub: `person_links` (each person linked through their UserDO), `logs` (event log);
- knowledge and work: `graph_records`, `graph_content` (the composition graph), `programs` (catalogue; bundles in R2),
  `dashboards`, `dashboard_builds`, `decision_register`, `activities`, `connections` (settings; `secrets_sealed` with the
  master key), `connector_calls`, `connector_schemas`;
- who asked what: `answer_buffer` (only who asked each question — it decides whose logs reach whom), `session_owners`
  (whom usage is charged to), `sessions_known` (each session's owner → which UserDO holds it);
- the record: `audit_log` (append-only, also to `AUDIT`), `usage_events`, `view_events`.

**UserDO** `user:<id>` (or an agent key's principal) — one person: `sessions` (their index), `session_entries`
(every session's log — the platform's copy is the truth), `session_artifacts`, `answer_buffer` + `session_snapshot`
(their inbox, by project), `asked` (which tab sent which request or question, 6 h), `warehouse_queries` (recent and
saved, with 5 sample rows), `state` (personal key/value). Each tab's socket carries its project, surface, sign-in and
lanes.

**DecisionDO** `dec:<project>` — `experiences`, `outcomes`, `versions` (decision states), `cue_index`, `settings`, `meta`.

**ChannelDO** `chan:<project>` — storage keys only: `config` (service token, bot secrets per channel), `channelMeta`,
`pending:<qid>` (15 min).

## 5. Keys and credentials

| What | Format | Kept in | How |
|---|---|---|---|
| project key | `sk-proj-<uuid>` | ProjectDO `api_key`; the engine's `<home>/.env` (`ICA_KEY`) | plaintext (see risks) |
| agent key | `sak_<project>_<43>` | ProjectDO `agent_keys` | SHA-256 + prefix; expiry, revocation |
| organisation key | `sak_org_<org>_<43>` | OrgDO `org_keys` | SHA-256 |
| platform JWT | HS256 `{userId,email,name,role,exp}` | the client (`sa-token`, iOS Keychain) | `JWT_SECRET` |
| provider keys for agents | — | KV `agent-credentials` | sealed with `CREDENTIALS_MASTER_KEY`; the engine holds them in its environment only |
| connector secrets | — | ProjectDO `connections.secrets_sealed` | sealed; refused without the master key |
| engine-run source credentials (e.g. NetSuite) | — | `<home>/.env`, `<home>/secrets/*.pem` | files on the engine's disk |
| bot secrets (Teams) | — | ChannelDO `config` | plaintext (see risks) |

## 6. The engine's disk

Roots (`engine.ts`): `STATE_ROOT` = `$ENGINE_STATE_DIR` or `~/.superatom/state`; a project's home `<home>` =
`STATE_ROOT/<project>`. On Fly the state is on the machine's volume (`/app/data/state`, datasources `/app/data/datasources`).

| Path under `<home>` | Holds | To the platform |
|---|---|---|
| `.env`, `settings.json`, `profile.json`, `secrets/` | the engine's settings and credentials, org settings, last profile | no (profile mirrors ProjectDO) |
| `db/composition.sqlite` | the composition graph | yes → ProjectDO `graph_records`/`graph_content` (`graph:sync`) |
| `db/datasource-index.sqlite`, `db/grounding.sqlite`, `db/agent-sessions.sqlite`, `db/backups/` | rebuildable indexes, harness session ids, backups | no |
| `sessions/<sid>/session.jsonl` | a session's log — the engine writes it first | yes → the owner's UserDO `session_entries` (`session:sync`, per session; after a reconnect one session at a time); `synced.json` says how far |
| `sessions/<sid>/STATE.json`, `ANSWER_HISTORY.jsonl`, `context.md`, `<qid>/answer.md` (+ `blocks.json`, `queries.jsonl`), `attachments/` | the session as files: current STATE, answer history, start context, each answer committed, its files | the log is; these are written from it (attachments come from R2) |
| `sessions/<sid>/work/` | the session's agent's own folder (its tools, data, out/, harness notes) | no |
| `workspace/` | the shared folder of the connector and grounding agents | no |
| `programs/store/<sha256>/`, `programs/src/`, `programs/incoming/` | built programs, sources, staging | built bundles → R2 `programs/` |
| `knowledge/`, `app/`, `agents/`, `datasources/` | domain knowledge, the project's own app, agent files, the datasource manager's state (`registry.json`, `query-results.sqlite`) | knowledge via the graph; dashboards upload to R2 |

Outside the home: the harnesses' own login files (`~/.claude.json`, `~/.codex/auth.json`, pi's `auth.json`).

## 7. Clients

- **Admin console** — `localStorage` `sa-token`; `sa.admin-cache:<who>|<org>|<path>` (LRU 300 / 4 MB); `sessionStorage`
  `sa-reauth`.
- **UI framework** — `sa.<project>.<name>` (view preferences), `sa.arrange:<scope>`, `sa.lru.<space>:<key>` (LRU 400 /
  3 MB; the warehouse explorer's results).
- **User UI** — `sa-token`; `sa-sessions:<p>`, `sa-feed:<p>:<id>` (answers), `sa-lanes:<p>`, `sa-lane-log:…`,
  `sa-hist:<p>`, `sa-sidebar-collapsed`, `sa-session:<host>:<agent>`.
- **iOS** — Keychain `ai.superatom.ask` / `sa.token.<account>`; UserDefaults `sa.*`; SQLite per account
  (`Application Support/Superatom/accounts/<account>/superatom.sqlite`: sessions, questions, answers, narration, audio);
  recordings in `<account>/Audio/`.

## 8. The warehouse

One Iceberg namespace per organisation in the shared Basin catalog: `org_<org id, lower-cased, non-alphanumerics → _>`.
Tables are unpartitioned, files in `WAREHOUSE`: `<table location>/data/<uuid>.parquet`, `metadata/<uuid>-m0.avro`,
`metadata/snap-<id>-<attempt>-<uuid>.avro`; the catalog writes the metadata JSON and compacts small files. Records:
OrgDO `warehouse_ops`, `warehouse_tables`; ProjectDO `warehouse_grants`; each person's queries in their UserDO.

## Risks found (2026-10-06) — to fix

1. The project key is plaintext in ProjectDO and travels in the external engine's URL; agent and organisation keys are hashed.
2. The vault is written in plaintext if `CREDENTIALS_MASTER_KEY` is missing (it should refuse), and older comments say values live in Worker secrets.
3. Plaintext secrets in DO storage: ChannelDO `config` (bot password, a long-lived service token).
4. `RECORDS` (the platform-records stream) is referenced but not bound: those records go nowhere; only `AUDIT` flows.
5. Nothing removes a project's data when it is deleted (projects are soft-deleted; `files.prefixOf.project` exists, unused) and no session can be deleted yet (`files.prefixOf.session` is ready for it).
6. Parcels are pruned only after a later put to the same project; no bucket lifecycle rule.
7. Unbounded or dead: ProjectDO `logs` (never pruned), the engine's `query-results.sqlite` (kept forever, holds source rows), `usage_turns` (unused), UserDO `state` (no caller).
8. Copies that outlive a revoked grant or a sign-out: `warehouse_queries.last_sample`, the explorer's browser cache, user UI `sa-feed:*`, iOS answers; the admin cache is not cleared on sign-out.
9. `namespaceOf` can map two organisation ids differing only in punctuation or case to one namespace.
10. `worker-configuration.d.ts` is stale against `wrangler.jsonc`.
