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
- [ ] 1e. **Agents out of the engine's reach.** Found while building (2026-10-15): agents hold the ENGINE'S KEY as their
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
- [ ] 1f. Tests (the manager's half done: `vm/apps/engine/test/data-seam.test.mts`, against the real manager): no ticket / forged / expired / old access version / another project → refused; policies in a request
  ignored for a ticket; `raw` and `POST /sources` refused to a ticket; a program's environment holds no key; (Docker) an
  agent process cannot read the engine's environment or data.
- Note: the connector agent can no longer load a bridge live (registering is the engine's alone) — its path is 6d.
- [ ] 1g. Released to Fusion5 and TotalGroup (with the user's word), verified there.

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
