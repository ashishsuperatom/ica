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
- [ ] 5a. Pooling, concurrency cap, fair queue; timeouts; cancel when the turn ends
- [ ] 5b. Retry by `classify`, circuit breaker, idle health; one call record (engine and cloud)
- [ ] 5c. Indexing on the contract (one index for every connector, actions included; levels; refresh rules; access applied; per-person index)
- [ ] 5d. Caching (key with version, settings and whose view; freshness; invalidation by table; bounds; single-flight; a person's results in memory only); seen and cleared through workloads' inspect and actions
- [ ] 5e. Cloud sandbox connectors on the same ticket, policies (entity deny, field masks) and record
- [ ] 5f. Tests

## 6. People and organisations
- [ ] 6a. A person's keys in their UserDO; "Connect my account"; per-person instances fetched when a request runs, evicted idle, dropped on revoke
- [ ] 6b. OAuth: apps registered per organisation (OrgDO); the platform runs the flow; refresh tokens in the UserDO; renewed once
- [ ] 6c. Drafts in the UserDO; publish → organisation proposal → org admin approves; Superatom's available by default, an org may restrict
- [ ] 6d. `sacli dev` for connectors (laptop builds, runs on the engine); the connector agent through the same door
- [ ] 6e. Tests

## 7. Review → re-design → final build
- [ ] 7a. Review what was built against the design; list every inconsistency
- [ ] 7b. One re-design pass with the user
- [ ] 7c. Final build

## 8. Tests
- [ ] 8a. Quick sanity suite (minutes): every kind of connection connects, queries, is refused without a ticket
- [ ] 8b. End-to-end, by category: core (connect, query, index, cache, versions), permissions (tickets, policies, levels, approval, per-person), lifecycle (crash, restart, switch, inspect, clear), people (keys, OAuth, revoke, leaving), failure (retry, breaker, offline engine)
