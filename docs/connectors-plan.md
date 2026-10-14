# Connectors redesign — the plan, step by step

The design: `docs/platform-architecture.md`, "Connectors" and "Workloads". Every decision, in the user's words:
`docs/connector-system-request.md`. How the work runs (the user, 2026-10-15): **design → build → review → one re-design
for consistency → final build → tests** (a quick sanity suite, then end-to-end suites by category).

Each step: built, checked (`scripts/check-all.sh`), committed; a step is ticked only when it is done end to end.

## 0. Design — done 2026-10-15
- [x] Questions 1–9 (connector, where it runs, release, making one, connection, identity, connecting, index, cache)
- [x] The lifecycle protocol (workloads), and a place to see everything happening (the user: Attention is too high level)

## 1. Security — the holes live today
- [ ] 1a. The platform's signing key (Ed25519, a Worker secret, with a key id for rotation); the public key in the engine's welcome
- [ ] 1b. The reader ticket: issued by ProjectDO for each turn and each program run on a person's behalf — principal, session, connections allowed, expiry (the turn, ≤ 15 min); agent keys and background work get their own principal
- [ ] 1c. The engine hands the ticket to whatever reads data for that turn (agents' `query` script, programs); the agent may read it, not forge it
- [ ] 1d. The datasource manager: every data route requires a valid ticket (signature, project, expiry); policies resolved by the manager from the platform for the ticket's principal (cached, cleared on `access:changed`); policies in a request ignored; `raw` refused to tickets — only the engine's own system work (indexing) holds a local system credential
- [ ] 1e. Agents run as another OS user (`sa-agent`) in the Docker image: their processes and workspaces theirs; the engine's data, secrets, and the manager's files not readable by them. Native/PM2 (laptop): says plainly that agents are not isolated
- [ ] 1f. Tests: no ticket / forged / expired / other project → refused; policies from the request ignored; `raw` refused; an agent process cannot read the engine's secrets
- [ ] 1g. Released to Fusion5 and TotalGroup (with the user's word), verified there

## 2. Workloads — the lifecycle protocol
- [ ] 2a. Kinds described once (wanted, status, actions, aspects, permissions); permissions derived into `shared/permissions.ts`
- [ ] 2b. ProjectDO: `workloads` (wanted + generation), `workload_status`, `workload_events` (bounded) — one migration
- [ ] 2c. Engine: pull on welcome and on `workloads:changed`, a reconciler per kind, status reported on change, "unknown since" when silent
- [ ] 2d. Actions (one-off, audited) and inspect (on demand, bounded, paged)
- [ ] 2e. One set of routes; `sacli workloads …` and the same verbs under each noun; hub messages for agents
- [ ] 2f. **The activity view** — everything happening, across kinds: filter (kind, workload, state, person, time), focus on one thing (its status, events, inspect, actions); live. Attention stays for what needs a person, fed generically by each kind's rule
- [ ] 2g. Migrate `engine_sources`, `engine_release`/`engine_switch` (→ `engine/self`), dev-environment status; old paths removed
- [ ] 2h. Tests

## 3. The connector contract and its release
- [ ] 3a. The contract (manifest + one interface: query, introspect, read, act, changedSince, classify)
- [ ] 3b. One catalogue from manifests (`shared/connectors.ts` by hand removed); SQL Server and Postgres real
- [ ] 3c. The one build tool (local = CI); per-platform files for native drivers; dependencies bundled, system needs declared
- [ ] 3d. The registry: GitHub Actions builds only changed folders; local publish with the registry key
- [ ] 3e. Connections pinned to a version; "a newer version exists"; switch and roll back (a workload change)
- [ ] 3f. Move today's bridges (duckdb, mssql, netsuite-suiteql, sa-warehouse) onto the contract; their dialect code (indexers, rewrite hooks) into them
- [ ] 3g. Tests

## 4. The datasource manager as supervisor
- [ ] 4a. One process per connection; restart with backoff; crash loop → status and Attention
- [ ] 4b. Reconciles to the platform's connections (connection workloads); connectors never register themselves; the three bridge doors become one
- [ ] 4c. Tests

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
