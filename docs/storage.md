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
| R2 | `REGISTRY` → `superatom-registry` | what we ship, read-only here: `releases/<product>/<version>/<file>` + `manifest.json`, `releases/<product>/channels/<channel>.json` (get.superatom.site), and the engine's images `v2/…` (registry.superatom.site and .ai); written only by `scripts/release.sh` and `scripts/registry-push.sh` from GitHub Actions — docs/releases.md |
| KV | `DOMAINS` | subdomain → project cache |
| KV | `CREDENTIALS` | the provider-credential vault, throttles, credential audit, usage snapshots (§3) |
| Pipeline | `AUDIT` | the audit stream → Parquet in the `superatom-platform` Basin |
| Worker loader | `LOADER` | cloud connectors as Dynamic Workers |
| Assets | `ASSETS` | the admin and user SPAs (`dist/client`) |

Vars (not secret): `FLY_ORG_SLUG`, `REPORTING_URL`, `PLATFORM_DOMAIN`,
`WAREHOUSE_ACCOUNT_ID`, `WAREHOUSE_BUCKET`, `TRANSCRIBE_MODEL`.

### Secrets (`wrangler secret`; `.dev.vars` locally)
| Secret | For |
|---|---|
| `JWT_SECRET` | signs and verifies the platform JWT (people 30 days, services up to years); the parcel tickets' HMAC |
| `CLERK_SECRET_KEY` | exchanging a session from the production Clerk instance (clerk.superatom.site) for the platform JWT |
| `CLERK_DEV_SECRET_KEY` | the same for the development instance — local dev servers sign in there (shared/clerk.ts; the publishable keys are in that file) |
| `FLY_API_TOKEN` | engines on Fly: an organisation token (each project's app, volume and machine: place, switch, suspend, stop, start) |
| `CREDENTIALS_MASTER_KEY` | AES-256-GCM key sealing the credential vault (KV) and connection secrets (ProjectDO) |
| `WAREHOUSE_CATALOG_TOKEN` (+ optional `WAREHOUSE_SQL_TOKEN`, `_CATALOG_URI`, `_SQL_ENDPOINT`) | the Basin catalog and Basin SQL |
| `REPORTING_TOKEN` | the reporting renderer (`REPORTING_URL/render`) |
| `OPENROUTER_API_KEY` | transcription only |

## 2. R2 `PACKAGES` — the platform's files (`files.ts`)

Every key is made by `files.ts`, under its kind and its project; a project's files are found (and removed) by prefix.

| Key | Holds | Writer → reader | Limit · check · lifetime |
|---|---|---|---|
| `parcel/<project>/<sha256>` | a message body too large for one hub frame (JSON) | `putParcel` (via `PUT /api/projects/<p>/objects/parcel/<hash>`, project key or member) → ticketed GET, `bucketStore` in ProjectDO, ChannelDO, UserDO | 64 MB · hashes to its name · ticket and file 30 days, pruned after a later put |
| `programs/<project>/<sha256>.json` | a program bundle (all files as JSON) | engine `PUT /api/engine/<p>/programs/<hash>` → `ProgramCatalogue` | 16 MB · bundle verified in and out · kept (immutable by hash) |
| `dashboard/<project>/<dashboard>/<build>/<path>` | a dashboard build's files | `uploadDashboardBuild` (worker.ts) → `serveDashboard` | 25 MB a file, 200 MB a build · content hash dedupes · current + 5 newest builds kept; all go with the dashboard |
| `attachments/<project>/<session>/<sha256>` | a file a person added to a session | the person's UserDO (`POST /api/sessions/<p>/<s>/attachments`) → the engine `GET /api/engine/<p>/attachments/<s>/<hash>` | 20 MB (checked before reading, both ways) · hashes to its name · goes with its session (`prefixOf.session`) |

## 3. KV

`DOMAINS`: `dom:<subdomain>` → project id, 1 h (GlobalDO `domains` is the truth).

`CREDENTIALS`:
| Key | Holds | Lifetime |
|---|---|---|
| `agent-credentials` | the vault: provider keys for agents (`{entries, groups, spent}`), sealed `v1.<iv>.<ct>` with `CREDENTIALS_MASTER_KEY`. A ChatGPT login (`openai-codex`) is kept as `{access, refresh, accountId}` and renewed by the platform alone (GlobalDO, one renewal at a time per login, 2 days before its access token ends); engines get the access token only, in memory | kept |
| `throttle:<project or ->\|<ip>` | failed credential fetches | 5 min window |
| `audit:<project>:<ms>-<rand>` | a credential handed out (provider, key id, ip) | 30 days |
| `usage:<entryId>` | a provider key's observed usage | refreshed after 5 min |

## 4. Durable Objects (SQLite, migrated by `@superatom/migrate`; each has `_migrations`)

**GlobalDO** `global` — `organizations` (registry, DO name), `domains`
(subdomain → project, the truth), `mobile_login_code` (one-time code → JWT, 60 s, single use),
`price_list`.

**OrgDO** `<org>` — `users` (email, org role; an old `clerk_id` column, unused), `projects` (soft-deleted), `org_roles`, `org_keys`
(`sak_org_…`, SHA-256 only), `org_audit`, `credit_ledger`, `budgets`, `billing_details`, `warehouse_ops` (what was done
to the warehouse, with ms), `warehouse_tables` (owners); legacy `datasources`, `conversations`, `messages`. Storage keys
`flyAllowance` (whether its engines may run on Fly, how many, on creation — set by the platform only) and `flyClaims`
(the projects whose engines hold one of those machines).

**ProjectDO** `proj:<project>` — the project's record and hub. Storage keys `projectName`, `orgId`. Tables:
- who may do what: `access` (by email), `access_domains`, `roles`, `groups`, `group_members`, `members` (legacy +
  service identities `svc:<channel>`), `agent_keys` (`sak_<project>_…`, SHA-256 only; capabilities, the person it acts for, the key that made it — `org:<id>` for an organisation's), `access_policies`,
  `access_attributes`, `access_version`, `warehouse_grants`;
- the engine: `api_key` (the project key `sk-proj-…`), `fly_machine` (where it runs — `provider` fly or external — and the idle clock), the `flyPlace` key (its Fly app, machine, volume, region), `engine_running`, `profile`, `message_queue` (a person's messages while the machine on Fly wakes)
  (for a sleeping engine, 60 min), `workload_status` and `workload_events` (what the engine runs and how each stands, as it reports; events 30 days / 5,000 — migrations 48, 49 replaced `engine_sources`);
- the hub: `person_links` (each person linked through their UserDO), `logs` (event log);
- each source's index (`dsi.ts`): `dsi_items` (each table — field '' — and field as it is now: type, three descriptions
  kept apart, enabled and who set it, gone, the log entry that made it), `dsi_log` (every change appended: the item as
  it became, when, by whom — the index as of any time), `dsi_plan` and `dsi_progress` (each build's work list and its
  checkpoints per source and phase); the whole current index is the reply to `dsi:snapshot` (a parcel when big — no file of its own); `connection_user_keys` (a person's own key for a per-user source, sealed);
- lineage (`lineage.ts`): `lineage_datasets` (each dataset seen: id, kind, first and last seen) and `lineage_edges`
  ("made from": from, to, how, who told us — pipeline, source, person, agent, usage — never changed; removed with when
  and by whom). Written by people and agents over the hub and by pipelines (POST lineage/openlineage, a project key).
- data tags (`dsi.ts`): `data_tags` — who owns a source's table or field and how sensitive it is; appended, the latest
  per item holds.
- what the project keeps in the bucket (`storage.ts`): `stored_objects` — every object (key, kind, bytes, who put it,
  when), written by the one storage module whatever writes the object (parcels, program builds, bridges, app versions,
  session files, dashboard builds); usage by kind and person, listing and deletion read it;
- long work (`jobs.ts`): `jobs` (kind, lease — one running per lease —, holder, stage, what it is doing, counts,
  heartbeat; stale after a minute without one);
- knowledge and work: the composition graph itself — its own tables (`content`, `name`, `change`, `question`, `suggestion`, `decision`, `version`, by its own migrations in `_graph_migrations`; `graph.ts`) and `graph_people` (who changed it, by email), `programs` (catalogue; bundles in R2),
  `dashboards`, `dashboard_builds`, `decision_register`, `activities`, `connections` (settings; `secrets_sealed` with the
  master key; `bridge` — a code connection's bridge, its code in R2 `bridge/<project>/<sha256>`, downloaded by the engine), `connector_calls`, `connector_schemas`;
- who asked what: `answer_buffer` (only who asked each question — it decides whose logs reach whom), `session_owners`
  (whom usage is charged to), `sessions_known` (each session's owner → which UserDO holds it);
- the record: `audit_log` (append-only, also to `AUDIT`), `usage_events`, `view_events`.

**UserDO** `person:<org>:<personId>` — one person in one organisation (the same email in two organisations is two people; `personId` = the first 32 hex of SHA-256 over the lower-cased email, `control-plane/shared/identity.ts`), or an agent key's own (`agent:<key>`); `sessions` (their index, with how they keep each: their name for it, pinned, archived, its collection — `session:keep`), `session_entries`
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
| engine key | `sk-proj-<uuid>` | ProjectDO `api_key`; the engine's settings (`ICA_KEY`: the container's or Fly machine's environment, set by the installer or the platform; a laptop home's `.env`) | plaintext (see risks) |
| model-only key | `sk-proj-m-<43>` | nowhere: derived from the engine key (HMAC-SHA256, agent-contract `modelOnlyKeyOf`) by the engine, checked the same way by ProjectDO (`/verify-model`) | the only key agents hold (`SA_MODEL_KEY`); good at the model proxy and tunnel, refused at the hub; rotates with the engine key |
| manager key | 64 hex | nowhere on disk in Docker: made by `start.sh` at each start and given to the engine and its datasource manager (`SA_MANAGER_KEY`); a laptop home's `.env` | never given to a child process; signs reader tickets |
| reader ticket | `v1.<payload>.<hmac>` | `.ticket` beside a turn's folder (renewed while the turn runs, emptied after); `SA_TICKET` for a program run | signed with the manager key; the reader, their policies, ≤ 15 minutes, voided by an access change |
| agent key | `sak_<project>_<43>` | ProjectDO `agent_keys` | SHA-256 + prefix; capabilities, made_by_key; expiry, revocation (cascades to keys it made) |
| organisation key | `sak_org_<org>_<43>` | OrgDO `org_keys` | SHA-256 + prefix; capabilities, made_by_key; expiry, revocation (cascades) |
| platform JWT | HS256 `{userId,email,name,role,exp}` | the client (`sa-token`, iOS Keychain) | `JWT_SECRET` |
| provider keys for agents | — | KV `agent-credentials` | sealed with `CREDENTIALS_MASTER_KEY`; relayed keys never leave the platform (the proxy adds them); Claude's login and ChatGPT's access token are handed to an engine in memory only |
| connector secrets | — | ProjectDO `connections.secrets_sealed` | sealed; refused without the master key |
| bot secrets (Teams) | — | ChannelDO `config` | plaintext (see risks) |

## 6. The engine's disk

Roots (`engine.ts`): `SUPERATOM_ROOT` = `$SUPERATOM_HOME` or `~/.superatom`; a project's home `<home>` =
`SUPERATOM_ROOT/<project>`. On Fly the homes are on the machine's volume (`/app/data/<project>`, datasources `/app/data/datasources`).

| Path under `<home>` | Holds | To the platform |
|---|---|---|
| `profile.json` (+ `.env` on a laptop only) | the last agent profile adopted; on a laptop (`sacli engine start --native`) the engine's start-up settings | no (the profile mirrors ProjectDO); no credential of a connection or a model is ever here |
| `models.json` | the platform's model list (control-plane/shared/models.json, deployed with the platform): every model an agent may run, pi's description of each — received in the welcome when the engine's copy differs (its hello names the hash it holds); pi reads models only from here | ← the platform (in its code) |
| `db/composition.sqlite` | the composition graph's REPLICA: pulled from the ProjectDO (`graph:pull` on welcome and on `graph:changed`), never written here; set aside (`.differs-<ms>`) and rebuilt when it disagrees | ← ProjectDO (the graph lives there) |
| `db/datasource-index.sqlite` | the replica of each source's index (`dsi_tables`, `datasource_index` fields, `dsi_meta` cursor) — pulled from the platform, never written otherwise; find-schema and get-schema read it | ← ProjectDO `dsi_items` |
| `db/grounding.sqlite`, `db/agent-sessions.sqlite`, `db/backups/` | rebuildable indexes, harness session ids, migration backups (engine-only: they make sense only where the engine runs) | no |
| `sessions/<sid>/session.jsonl` | a session's log — the engine writes it first | yes → the owner's UserDO `session_entries` (`session:sync`, per session; after a reconnect one session at a time); `synced.json` says how far |
| `sessions/<sid>/STATE.json`, `ANSWER_HISTORY.jsonl`, `context.md`, `<qid>/answer.md` (+ `blocks.json`, `queries.jsonl`), `attachments/` | the session as files: current STATE, answer history, start context, each answer committed, its files | the log is; these are written from it (attachments come from R2) |
| `sessions/<sid>/work/` | the session's agent's own folder (its tools, data, out/, harness notes) | no |
| `workspace/` | the shared folder of the connector and grounding agents | no |
| `programs/store/<sha256>/`, `programs/incoming/` | built programs — each with the source it was built from (`source/`, inside its hash) — and build staging; no program source is kept in a home (authors build with `sacli program build`) | bundles, source included → R2 `programs/`; fetched back by hash |
| `datasources/<name>/bridge.mjs`, `datasources/query-results.sqlite` | each code connection's bridge, downloaded by hash (its settings and secrets only in memory); the manager's result cache (keyed with each source's generation; fresh 6 h unless asked fresher; at most 20,000 results / 500 MB, least recently used out — migration 2) | bridges ← ProjectDO `connections` + R2 `bridge/<project>/<hash>`; the cache: no |
| (in memory) each connection's process | the data source manager runs every connection in a process of its own (`host.mjs`): its connector, settings and secrets there only; restarted after a crash, left stopped after five in five minutes | no — its state is the connection's workload |

**Who may write what (the image, 2026-10-15):** the engine runs as root, its agents as `sa-agent` (group `sa`). The agents'
HOME (`/app/data/agent-home`: their logins, caches) is theirs; in a home, `sessions/<sid>/work/`, `workspace/` and `db/`
are shared with group `sa` (setgid, the engine's umask 002); `datasources/`, `programs/` and `.programs-run/` are the
engine's alone (what it runs). On a laptop there is one user.

Authors never write in an engine's home: they work in a clone of the project on their own machine (`sacli clone`), and
what they change reaches the platform by import, build or publish, and the engine from there. The agents' shared
`workspace/` holds only what the engine puts there (it is swept of anything else). The platform keeps program source with
each build; knowledge as graph nodes.

Outside the home, on a developer's laptop only: the harnesses' own login files (`~/.claude.json`, `~/.codex/auth.json`,
pi's `auth.json`), used where the vault has no credential for the project.

## 7. Clients

- **Admin console** — `localStorage` `sa-token`; `sa.admin-cache:<who>|<org>|<path>` (LRU 300 / 4 MB); `sessionStorage`
  `sa-reauth`.
- **Every web client (IndexedDB `superatom` / `kept`, `clients/kept.ts`)** — copies only, least recently used out past
  200 MB: `parcel:<sha256>` (a parcel's body, checked against its hash when fetched — never fetched twice) and
  `answer:<project>:<request>` (a console request's last answer, shown at once on the next visit and replaced when the
  fresh one differs; refusals are not kept). Cleared on Log out. No secrets: they never travel as parcels or answers.
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
