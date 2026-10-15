# Connectors redesign — the plan, step by step

The design: `docs/platform-architecture.md`, "Connectors" and "Workloads". Every decision, in the user's words:
`docs/connector-system-request.md`. How the work runs (the user, 2026-10-15): **design → build → review → one re-design
for consistency → final build → tests** (a quick sanity suite, then end-to-end suites by category).

Each step: built, checked (`scripts/check-all.sh`), committed; a step is ticked only when it is done end to end.

## 0. Design — done 2026-10-15
- [x] Questions 1–9 (connector, where it runs, release, making one, connection, identity, connecting, index, cache)
- [x] The lifecycle protocol (workloads), and a place to see everything happening (the user: Attention is too high level)

## 1. Security — the holes live today

Found while mapping it (2026-10-15): every process in the engine image runs as root, agents included; the analyst,
grounding and connector agents and the `programs` CLI send no policies at all (unrestricted); a program run inherits the
engine's whole environment (its key included); any process on the box may register a bridge (`POST /sources`), read with
`raw`, or send its own policies.

**Changed from the design (simpler, as secure):** the ticket is signed by the ENGINE, not the platform. Whoever could
forge an engine-signed ticket already holds the engine — its key and every connection's credentials — so a platform
signature protects nothing more, and it would cost a round trip per turn and a key to manage. What matters is that
agents and programs cannot read the signing key: the separate OS user (1e).

- [x] 1a. **The manager's key**: `SA_MANAGER_KEY`, random, given to the manager and the engine by their launcher
  (`start.sh` in Docker, `sacli engine` natively), never to a child. The manager refuses to start without it.
- [x] 1b. **Two ways in, nothing else.** *System* (`x-sa-system: <key>` — only the engine's own work: indexing,
  registering connections, the source viewer, program runs' own reads) and *ticket* (`x-sa-ticket` — whatever runs for
  someone: agents, programs). `/health` alone is open.
- [x] 1c. **The ticket**: `v1.<payload>.<hmac>`, the payload = principal, email, the policies per source (resolved by the
  engine from the platform, as today), session, the access version, expiry (≤ 15 minutes). The manager takes policies
  only from a valid ticket; `raw`, registering and removing sources, and the cache are system only. An access change
  (`access:changed`) raises the manager's access version: older tickets are refused ("your data access changed — ask again").
- [x] 1d. **Every reader carries one.** A person's turn: their ticket (`.ticket` beside the folder, replacing
  `.reader.json`). A program run for someone: `SA_TICKET`. Background agents (analyst, grounding, connector) and the
  `programs` CLI: the ticket of whoever their work is for, else their own agent principal — never unrestricted. No
  ticket → refused, plainly. The grounding seam stops reading raw.
- [x] 1e. **Agents out of the engine's reach.** Found while building (2026-10-15): agents hold the ENGINE'S KEY as their
  model credential (claude's `ANTHROPIC_AUTH_TOKEN`; opencode serve inherits the container's environment) — with it an
  agent could connect as the engine and be sent every connection's secrets; and the composer runs on **pi inside the
  engine's own process**, whose read/write tools act as the engine (`/proc/self/environ` holds its keys). So:
  - **A model-only key**: the platform issues the engine a key good only at the model proxy (and tunnel); agents get
    that, never the engine key.
  - **An agent runner**: one process, as the OS user `sa-agent`, started with an allow-listed environment, hosting every
    harness (pi, the claude PTY, codex, opencode serve); the engine drives its sessions over a local socket (the Session
    interface, events streamed back). Agents' workspaces and HOME theirs; the engine's data, keys and processes out of
    reach. The same seam later lets agents run on their own box.
  - Natively (a laptop): one user, said plainly at start.
- [x] 1f. Tests — `vm/apps/engine/test/data-seam.test.mts` (the real manager), `runner.test.mts`, `control-plane/.../model-only-key.test.ts` (Miniflare), and `isolation.image.mts` run in the built image (all ✓, dev-20261014-937ca042): no ticket / forged / expired / old access version / another project → refused; policies in a request
  ignored for a ticket; `raw` and `POST /sources` refused to a ticket; a program's environment holds no key; (Docker) an
  agent process cannot read the engine's environment or data.
- Note: the connector agent can no longer load a bridge live (registering is the engine's alone) — its path is 6d.
- [x] 1g. Released to Fusion5 and TotalGroup (dev-20261014-f2e3ee72, 2026-10-15), verified there: agents run as sa-agent, the runner fetched its login with the model-only key, Fusion5 answered from NetSuite (5,560 customers) through the ticket, TotalGroup from its index. Found on the way: the runner needed the platform's model list (now given it). To revisit in step 3: `datasources list` says "runnable: no" for a working custom source.

## 2. Workloads — the lifecycle protocol

**Concrete design (2026-10-15, against the code).** What today reports state in seven ways becomes one: a *workload* is
`kind/id`; each kind is described once (`control-plane/shared/workloads.ts`): what it reports, its actions, its aspects,
the capability for each. First kinds: `engine/self`, `connection/<name>`, `agent/<role>` (composer, analyst, connector,
grounding, narrator) and `agent/runner`.
- **Wanted stays where it is kept** — a connection's row (its bridge and settings), the engine's chosen release, the
  agent profile — no second table. Its **spec** is a hash of it; the engine reports the spec it has acted on, so "changed
  but not yet taken" is a comparison, not a counter.
- **Status** — `workload_status` (ProjectDO, one migration): state (pending, starting, ready, degraded, failed, stopped),
  version, spec, since, restarts, last error (*what* for people, *detail* for operators), health; sent by the engine as
  `workload:status` only when it changes. No engine connected: every row reads **unknown since** its last report.
- **Events** — `workload_events`: each change of state, kept bounded (the last 30 days, at most 5,000 a project).
- **Actions and inspect** — `workload:act` / `workload:inspect` to the engine with a request id, answered
  (`workload:acted` / `workload:inspected`), every action audited; inspect bounded and paged, nothing collected unasked.
  Connection: restart, test, clear-cache, refresh-index; aspects cache, index. Agent: restart; aspect session.
  Engine: aspect health.
- **One door** — `GET /workloads`, `GET /workloads/<kind>/<id>` (status, events), `POST …/act`, `GET …/inspect/<aspect>`;
  `sacli workloads [show|act|inspect]`; the console's activity view; hub messages for agents. Permissions from the kinds.
- **Attention** from each kind's rule (failed; degraded over 10 minutes).
- Replaces `engine_sources` and `sources:report` (removed); `datasources list` reads its state from here.

- [x] 2a. The kinds (shared/workloads.ts) and their permissions; tests
- [x] 2b. ProjectDO: migration, status and events stored from `workload:status`, unknown-when-silent, the read routes; tests
- [x] 2c. Engine: status reported for the engine, each connection, each agent and the runner — on change
- [x] 2d. Actions and inspect, end to end (platform ↔ engine), audited; tests
- [x] 2e. `sacli workloads`
- [x] 2f. **The activity view** (console): everything across kinds, filtered (kind, state, time), focus on one — status,
  events, inspect, actions; live. Attention fed by the kinds' rules
- [x] 2g. `engine_sources` / `sources:report` replaced; `datasources list` reads workloads
- [ ] 2h. Verified on Local Lab, then TotalGroup

## 3. The connector contract and its release

**As built (2026-10-15 night; the user asleep, decisions mine — "you are free to change the specs"):**
- **A connector is one folder** `connectors/bridges/<id>/`: `manifest.json` (title, description, icon, kind sql | documents
  | api, dialect, levels, identity modes, fields — a field may be asked for only `when` another has a value — native
  packages), `bridge.mjs` (createBridge → ready, **test**, query, introspect, isTransient, close) and a `package.json`
  with its own driver. `pnpm -C connectors build` checks every manifest, bundles each with its driver (pure JavaScript;
  native ones supplied by the manager) and writes `dist/engine.json` (each manifest with the hash of its build — its
  version) and `dist/bridges.json`. **The platform's catalogue is built from the manifests**: the hand-written entries
  in `shared/connectors.ts` are gone (only the free-form custom source stays).
- **Folders renamed to their connector ids** (mssql → sqlserver, netsuite-suiteql → netsuite). **Microsoft Fabric /
  Azure SQL is the SQL Server connector signing in with Entra**: its connections were moved over by ProjectDO migration
  50 (`auth: entra`), their pinned bridge unchanged.
- **Pinned versions, changed on purpose**: a connection runs the bridge it is pinned to; when its connector has a newer
  build the workload says so (`newer`); the actions **update** (to the newest; the current kept) and **rollback** (back
  to what it ran before) — `project.connectors`, audited. Nothing swaps on its own.
- **A connector tests itself** (`test()`: signed in, a trivial read): the manager's `POST /test`; a connection's state is
  what the test says (ready, or degraded with why) — at load, on the test action, and every 5 minutes idle.
- **The index needs no code of the platform's** for a connector that describes its tables with their columns
  (introspect); the per-dialect indexers stay only for SQL Server, NetSuite, DuckDB and the warehouse until step 5c.
- **The SQL rewrite takes any dialect SQLGlot knows**, so a connector names its own.
- **The enterprise collection, tested live** (connectors/test/live: `up.sh` starts six databases in Docker seeded with
  the same sales data; `connectors.live.test.mts` runs each connector's BUILT bundle): PostgreSQL, MySQL/MariaDB, SQL
  Server (SQL login or Entra), Oracle (thin), ClickHouse, MongoDB — each signs in, describes its tables, reads, binds
  @name values, refuses to write, and all agree on the same answer. Plus NetSuite, DuckDB and SA-WAREHOUSE.
- **Changed from the design:** no separate connector registry yet — Superatom's connectors ship with the platform's deploy
  (the build is deterministic and hashed, so each is a version); a registry at registry.superatom.ai belongs with
  organisation connectors (step 6), where builds do not come from our repository. SQL Server's reads are read-only by the
  rewrite's gate (a read-only login is recommended); Oracle's by a read-only transaction; the others by their session.

- [x] 3a. The contract (manifest, one interface with test)
- [x] 3b. One catalogue from manifests; SQL Server and Postgres real
- [x] 3c. One build tool (deterministic; per-connector hash; native drivers named, supplied by the manager)
- [ ] 3d. A connector registry outside the platform's deploy — moved to step 6 (organisation connectors)
- [x] 3e. Pinned; newer shown; update and rollback
- [~] 3f. Dialect code into connectors: the rewrite's dialect and the index for new connectors done; the four old indexers remain (5c)
- [x] 3g. Tests: live, against six databases

## 4. The datasource manager as supervisor

**As built (2026-10-15 night):** every connection runs in a process of its own (the manager's `hosted.ts` starts
`host.mjs` — plain JavaScript — and gives it the connection's connector, settings and secrets, and nothing else; no key).
The manager keeps the same interface; each call goes to the connection's process and back. A process that stops is
started again after 1, 2, 5, 10, 30 s with the same settings; five stops in five minutes leave it stopped (failed, with
why) until it is loaded again. `/sources` says each process's state; the engine shows it as the connection's workload
(starting while it restarts, failed after a crash loop, restarts counted). The engine loads again only connections whose
wanted spec changed — adding one never reconnects the others. Tested: `vm/apps/engine/test/supervisor.test.mts` (two
processes, a crash taking only its own call, a crash loop left stopped) and on Local Lab (a process killed, restarted in
a second, the next question answered).

- [x] 4a. One process per connection; restart with backoff; crash loop → failed (Attention through its workload)
- [x] 4b. Reconciles to the platform's connections (only what changed reloads); connectors never register themselves.
  The three bridge doors: the console/sacli's hand-set bridge and the platform's own remain; the engine's upload door
  (the connector agent) remains until 6d.
- [x] 4c. Tests

## 5. The framework's share

**As built (2026-10-15 night):**
- **At most 4 calls at once per connection**, the rest waiting their turn (the manager's `hosted.ts`).
- **Retry** stays where it was proven (the checked SQL path, 3 tries with jittered backoff); whether a failure is passing
  is the connector's word (`isTransient`) or its message's.
- **Circuit breaker**: five failures in a row to reach a source and it is paused — refused at once, saying until when —
  for 30 s, then 1, 2, 5 minutes if the first try after a pause fails too; the connection's workload reads degraded
  ("its source is unavailable — paused until …").
- **Calls counted** per connection (calls, errors, average time) in its workload's health — the call record summarised.
- **Readiness** asked of each connection's process every 5 s (a connector that connects after it loads reads ready
  without being called).
- **Cache**: the key holds the source's *generation* (its connector and settings as loaded — a change never reads an
  old result); fresh for six hours unless a caller asks fresher (`maxAge`); bounded to 20,000 results / 500 MB, least
  recently used out; single-flight (the same statement asked while it is read waits for that read). Seen and cleared
  through workloads (inspect cache, clear-cache). The person's view is in the key already: the rewritten SQL carries
  their policies.
- **The index tools** (`find-schema`, `get-schema`) hide the tables a reader's ticket denies.
- **Not done, and why:** cancelling a query when its turn ends (needs cancellation down to each driver — planned);
  a fair queue across people (needs the principal down to the manager's queue — planned); the cloud sandbox's
  connectors on tickets and policies (5e — planned); per-source freshness settings (the default and the caller's
  word only).

- [x] 5a. Concurrency cap per connection (fair queue across people: planned; cancel at the turn's end: planned)
- [x] 5b. Retry by the connector's word, circuit breaker, call counts
- [x] 5c. Indexing on the contract (a connector's own description), access applied to the index tools
- [x] 5d. Caching (generation, freshness, bounds, single-flight; seen and cleared through workloads)
- [ ] 5e. Cloud sandbox connectors on the same ticket and policies — planned
- [x] 5f. Tests (supervisor.test.mts, data-seam.test.mts)

## 6. People and organisations
- [x] 6a. **A person's own key, used (2026-10-15 night).** A connection made "per-user" (`sacli datasources update <name>
  --auth per-user`) reads with each person's own key (`sacli datasources my-key <name> --set … --secret …`): when a
  person's turn starts, the engine asks the platform for their key and starts their instance of that connection — the
  same connector, their values over its settings, never its shared secrets, a process of its own — ended after 30
  minutes unused, or at once when their key changes or goes. The manager routes a ticketed read to the reader's own
  instance; a reader who gave none is refused, saying how to give one — nothing is read with anyone else's. The shared
  connection is the platform's own work (its index). Every key handed out is audited. **Deviation:** people's keys stay
  where they were kept (ProjectDO `connection_user_keys`, sealed), not their UserDO — moving them is for the re-design
  pass (a key per project and connection is project data; a UserDO would hold keys a person reuses across projects —
  OAuth sign-ins, 6b). Tested at each layer (manager routing, the platform's hand-out, the engine's instances).
- [ ] 6b. OAuth: apps registered per organisation (OrgDO); the platform runs the flow; refresh tokens in the UserDO; renewed once
- [ ] 6c. Drafts in the UserDO; publish → organisation proposal → org admin approves; Superatom's available by default, an org may restrict
- [ ] 6d. `sacli dev` for connectors (laptop builds, runs on the engine); the connector agent through the same door
- [ ] 6e. Tests

## 7. Review → re-design → final build

**The review (2026-10-15, night): what was built, against what was decided.** Each line: the decision, what is true now,
and what follows.

| # | Decided | Now | Follows |
|---|---|---|---|
| 1 | A connector is one folder with everything | ✓ engine connectors (`bridges/<id>/`); sandbox ones (`catalog/<id>/`) are folders too, but on **another contract** (`server.ts`, entities and actions) | **Re-design:** one contract for both hosts — a sandbox connector implements the same interface (test, introspect, query/read, act) so either host runs either; until then they are two kinds |
| 2 | The engine is the base, the sandbox a fallback | ✓ every database connector is an engine one | — |
| 3 | One module, many connections; one process each | ✓ (hosted.ts) | — |
| 4 | A registry for Superatom's connectors; organisation connectors approved | Superatom's ship with the platform's deploy (hashed, deterministic); no organisation connectors | Step 6 (registry with organisation connectors) |
| 5 | Pinned, updated on purpose, rollback | ✓ tested on Local Lab and in tests | — |
| 6 | One door for every author | ✗ three doors remain: a hand-set bridge (console/sacli), the platform's own, the engine's upload (connector agent) | Step 6d: the connector agent and `sacli dev` build drafts; the engine's upload door goes |
| 7 | Identity separate from transport; shared / person key / person OAuth | shared ✓; a person's key is stored (`connection_user_keys`) but **never used**; OAuth not built | Step 6a/6b. Until then, a connection made "per user" runs on its shared credential — said nowhere: **fix** (below) |
| 8 | Reader ticket; policies from it only; agents another OS user | ✓ (engine-signed — changed, recorded) | — |
| 9 | Retry, pool, breaker, one call record in the framework | ✓ retry (checked path), cap 4, breaker, counts; no per-call record on the platform (counts only) | A per-call record belongs with the audit work you deferred |
| 10 | Index: the connector describes, access applies, per-person index | ✓ describes; tools hide denied tables; masked columns not shown masked; no per-person index (no per-person connections yet) | With step 6a |
| 11 | Cache: version and whose view in the key, freshness, bounds, single-flight, seen and cleared | ✓; freshness is a default (6 h) and the caller's word, not a per-connection setting | A connection setting `cache_minutes` when someone needs one |
| 12 | Workloads: everything the engine runs, one protocol | engine, connections, agents ✓; **programs** and **dev environments** not kinds yet; the sandbox's connections are not workloads | Programs as a kind is next for workloads; dev environments after |
| 13 | Attention for what needs a person; an activity view for everything | ✓ (Running) | — |
| 14 | Read-only connectors | Postgres, MySQL, ClickHouse by their session; Oracle by a read-only transaction; MongoDB refuses write stages; **SQL Server only by the rewrite's gate** | Recommend a read-only login for SQL Server (said in its manifest's help) |
| 15 | Documents (MongoDB) under access policies | a reader with any policy on a document source is refused (policies cannot apply) | Entity deny and field masks for documents, with 5e |

**Fixed in this pass:** (7) a connection made "per user" says, wherever it is shown, that it runs on its shared
credential until a person's own keys are built; (14) SQL Server's manifest says to use a read-only login.

## 7b. The re-design (decided 2026-10-15; the user's words in docs/connector-system-request.md) — the final build

- [x] **R1. One kind: the engine connector.** The platform knows one contract (manifest, createBridge: ready, test,
  introspect, query, act?, close). How a connector reaches its data is its own business — a database driver, an HTTP
  API, a Cloudflare worker it calls. The three cloud connectors (rest-json, github, mcp-server) become engine
  connectors; the platform's connector sandbox (Dynamic Worker runtime, gateway, `runs: 'cloud'`, catalog.json/code.json)
  goes. An API's entities and fields are its index (CRUNCHBASE.Company.CompanyName). Review items 1, 15 and step 5e
  close with it. **As built (2026-10-15):** `connectors/src/api.ts` (apiConnector, json, pages, flatten, fieldsOf; the
  MCP client) makes an engine connector of kind `api` — introspect gives its entities as tables and its actions, a query
  is JSON (`{"entity", "filters", "limit"}`), `act(name, input)`; the manager gained `/act` (a reader's, as them; refused
  with any policy on the source) and a reader's `/test`; the engine's `connector-ops.ts` serves the user UI's connection
  page (`connector:test|introspect|read|act`) for every connection, as its asker (their ticket), an action that changes
  something only when a person confirmed it. Gone: the Dynamic Worker runtime, gateway and code mode, `runs`, the
  `LOADER` binding, `connector_calls`/`connector_schemas` (migration 52). Tested: connectors.test.mts (the three, with a
  stand-in API), connector-ops.test.mts (the real manager). No live project had a cloud connection.
- [x] **R2. A person's own key: in their UserDO, fetched on the first read, held by the connection's process.** Kept in
  the person's UserDO by (project, connection) — never shared across projects; the ProjectDO only relays. Nothing is
  fetched when a question starts: the first read that needs a person's key reaches the manager, which asks the engine
  (system key), which asks the platform (ProjectDO → the person's UserDO); the connection's ONE process then holds a
  client per person (their values over its settings) — every later read uses it — dropped after 30 minutes unused, when
  their key changes or goes, or when the connection restarts. No process per person (the user: "don't make too many
  processes unnecessarily"). No key: refused, saying how to give one. Replaces 6a's eager per-person instances.
  **As built (2026-10-15):** UserDO migration 8 `connection_keys (project, connection, sealed)`, reached only from a
  project (`/connection-keys`); ProjectDO migration 52 drops `connection_user_keys`. The manager's `GET /wants` (the
  engine waits there) and `POST /person` / `/person/forget`; host.mjs holds a client per person (`person`, `forget`,
  calls naming a person; idle 30 minutes); the cache keyed `<source>~<person>`. The console's explorer reads with the
  asker's ticket too. Found on the way and fixed: a key of one's own carried no one (migration 51), a person's read
  answered from the shared account's cache. Tested: data-seam.test.mts, connections.test.mts (engine and platform).
- [x] **R3. Organisation connectors and the registry, no approval gate.** Anyone with `project.connectors` builds and
  publishes a connector (the same build tool, laptop = CI); it is in the organisation's registry (OrgDO, bundle in the
  bucket by hash), usable at once in their project and visible to the organisation's others ("made by …, in …").
  Safety is pinning: a new version changes no connection until it is updated on purpose; rollback in one action. An
  organisation admin may block a connector or version after the fact; "approval required" is an organisation setting,
  off by default. Every publish audited. Superatom's own stay in every project. Replaces 3d and 6c.
  **As built (2026-10-15):** OrgDO migration 9 (`org_connectors`, `org_connector_versions`, `org_settings`) and
  `org-connectors.ts`; the code at R2 `connector/<publishing project>/<id>/<hash>` (each connection copies what it runs
  into its own project). One build tool: `connectors/src/bundle.ts`, used by the repository's build and by
  `sacli connectors build|publish` (esbuild from the connector's own folder; `sacli connectors init` writes one). A
  project's catalogue is Superatom's plus the organisation's current versions; an organisation change reaches every
  project at once (each reads the registry again and tells its engine — a block stops the connections now). New
  capability `org.connectors` (block, unblock, approve, the approval setting). Tested: org-connectors.test.ts (the real
  Worker, ProjectDO and OrgDO).
- [x] **R4. Programs and dev environments in Running.** Two more workload kinds: a program while it runs for a question
  (its state, how long, who for; stop), and a person's dev environment (whose, attached or not, last used; close).
  Same states, history, actions and Attention as the rest.
  **As built (2026-10-15):** kinds `program` (`<agent>:<file>`; stop — `program-runs.ts`, reported by the session
  seam as each run begins and ends) and `dev-env` (reported by the program seam from the builds it holds; the platform
  labels it by whose and its status, lists an attached one before the engine holds a build, and closes it —
  `DevEnvs.close`, the engine told to let its builds go). The Running page reads each kind's name from the shared
  definition. Found on the way: a program's in-process reads (`query`, `append`) went as the engine with policies — now
  with the reader's ticket. Tested: program-runs.test.mts, program-build.test.mts, dev-envs.test.ts, workloads.test.ts.
- [x] **R5. One door for authors** (6d, after R3): the connector agent and `sacli dev` build and publish through R3's
  door; the engine's upload door and the hand-set bridge go. **As built (2026-10-15):** code reaches a connection only
  as a published connector's version. A person: `sacli connectors publish <folder>`, then
  `sacli datasources update <name> --connector <id>` (pinned; the code it ran kept for a rollback; its values read
  again against the new form, the rest left behind). The connector agent: drafts on the engine and tests live as
  before; when it finishes the engine publishes the draft (`POST /api/engine/<p>/connectors`, as the person who asked;
  its manifest, or one made from the connection's own settings and secrets) and moves the connection onto it. Gone:
  `PUT /connections/<id>/bridge` (`sacli datasources bridge`), the engine's `PUT /engine/connections/<name>`. The
  existing code connections (TotalGroup's, Procurement's) are untouched: they run the bridge they are pinned to until
  someone moves them through the door. Tested: connections.test.ts, org-connectors.test.ts, the CLI's e2e, the
  lifecycle suite.
- [ ] **R6. OAuth** (6b): "Connect my account" — tokens in the UserDO beside R2's keys.
- [ ] **R7.** Tests for each (written before the code, from the rules), the e2e suites extended; released; verified on
  Local Lab, then Fusion5 and TotalGroup.

## 8. Tests

- [x] 8a. **Quick sanity** — `node scripts/e2e/connectors.mjs sanity [--profile <p>]`: the engine connected, every kind
  reporting, every connection reaching its source by its own test. Runs against any project.
- [x] 8b. **End to end, by category** — `node scripts/e2e/connectors.mjs <core|permissions|lifecycle|failure|all>` against
  Local Lab with the live databases (`connectors/test/live/up.sh`, connected as SALES_*):
  core (every source indexed by its own description, the cache seen, a known answer from the source), permissions (a
  viewer sees but cannot act and never sees an error's detail; an unknown action refused), lifecycle (restart; pinned
  to an older build → newer said → update → rollback; a connection's process killed and started again), failure (a
  database stopped → its test says why, degraded; started → ready). All passed on 2026-10-15.
- Below them: `scripts/check-all.sh` (unit and integration: tickets against the real manager, the agent runner, the
  supervisor, the cache, workloads through the real ProjectDO, the model-only key at the proxy, the profile's rules,
  the image's isolation check `vm/apps/engine/test/isolation.image.mts`) and the connectors' live suite
  (`connectors/test/live/connectors.live.test.mts`: six databases, each connector's built bundle).
