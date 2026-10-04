# Features

One line per major feature. **Built** means done and working; anything partly done is listed under **Planned**.
Keep this list current: when a feature is finished, move it up; when one is agreed, add it below.

## Built

**Engine and agents**
- An engine per project that connects out to its Durable Object over WebSocket; screens never talk to it directly.
- Four coding-agent harnesses (Claude Code, pi, opencode, codex) behind one session interface; each agent is one session behind a queue.
- Agent sessions persist and resume across restarts.
- Composer agent: one per conversation, answers in markdown whose marker lines name the tables and charts it wrote.
- Narrator: one live line about what the agent is doing while work runs.
- Analyst terminal: a shared workspace with the data tools.
- Connector agent: the admin connects a new data source from a terminal tab; it writes, tests and registers the bridge live.
- Grounding: resolves values people type to the source's ids.
- Agent data tools: `sources`, `find-schema`, `get-schema`, `query`.

**Data**
- Datasource manager: one endpoint that routes every query to its source's bridge, with retries, a protective row cap and a query cache.
- SQL rewriting through a SQLGlot worker pool, with per-dialect hooks.
- Datasource index built by the system and searched (`find-schema`) or read whole (`get-schema`).
- Two live projects: Fusion5 (NetSuite through a SuiteQL bridge) and Total Group (Microsoft SQL Server).

**Knowledge and computation**
- Composition graph: concepts, domains, files and settings stored by hash, an append-only change log, time travel, scopes and owners, join/leave, and a CLI for every change.
- Migrations for every database, engine and Durable Objects alike: one runner, no down migrations, a fast check, backups.
- Platform types: the shapes of STATE, ops, intents, programs, answers, agents, sessions and the governance log, each with checks that answer in sentences.
- STATE engine: every function gets the whole STATE frozen and can set only its own slice; it re-runs whatever reads a changed path, in dependency order.
- Programs: a Node side and a React side built with TypeScript, identified by hash, kept immutable in a store, loaded into STATE, inspectable; with a CLI.
- Sessions: one user's blocks as a tree (each path through it a thread), current-view vs new-block intents, branching from earlier blocks, the answer history, stale runs dropped, an append-only log readable as of any moment.
- Agent sessions on the engine: an agent defined in the project home runs its programs as sessions of blocks over the hub (`session:*`), each answer drawn as the answer card and each program's own view in its block.
- UI library: `<Intent>` with one delegated listener and a list of every intent on screen, the thread view with branches, and loading a program's React side with the platform's own React.
- Project homes under `~/.superatom/state/<projectId>`, and a project template (new, check, sync).
- A per-project deterministic application behind the engine's `app:` seam (the Fusion5 and Total Group dashboards).
- A guard that keeps platform code free of any one dataset's vocabulary.

**Agents and the CLI**
- Agent API keys per project: made by the project's admin, shown once and stored only as a hash, scoped, expiring and revocable (revoking ends open connections).
- Agent connections to the hub: only to the engine, only within the key's scopes, the agent's identity stamped on every message.
- The hub stamps who sent every message, so the engine always knows the user.
- Audit history in each project's Durable Object: every question, intent, refusal, key change and project API change, append-only.
- `sacli`, the Superatom CLI: login with profiles (one project each), agents, sessions, asking questions, JSON output, exit codes, and one background connection per project that cleans up after an hour idle.

**Platform (Cloudflare)**
- Control-plane Worker with Org, Project, Global and Channel Durable Objects, serving the admin console and each project's user UI on superatom.site.
- Sign-in through Clerk to our own tokens, plus browser-redirect PKCE login for mobile.
- Answer durability: the project's Durable Object buffers answers, and web and iOS pull the ones they missed.
- Parcel transport: large bodies stored in R2 by hash with HMAC tickets.
- Model proxy: provider keys held in a vault, per-project metering and throttling, and a tunnel for codex.
- Speech-to-text endpoint.
- Dashboard publishing: a built app is uploaded to R2 and served per project, with versioned builds and rollback.
- Admin console: analyst, connector and grounding terminals, models, credentials, dashboards and an inspector.
- Reporting worker: renders an answer as HTML and PNG.
- Cloudflare config on wrangler.jsonc with a current compatibility date and pinned tool versions.

**Deployment and clients**
- Docker image for the engine, and provisioning of one Fly.io machine per project.
- iOS voice-first client.

## Planned (not built)

**Product**
- The user UI rebuilt on blocks, cards and the thread, using the session runtime and `<Intent>`.
- The existing answer card made the platform's one answer component.
- A data hub (bounded cache refreshed by server events) and a design system for the new UI.
- Agents as defined (a domain + programs + STATE + a starting UI + an ICA), with dashboards as agents.
- The default agent for questions no other agent fits.
- The builder agent, which writes programs and the concepts that tell agents how to use them.
- The org knowledge index that programs attach to.
- Decision state: states with their outcomes, actions, paths and reasoning.
- Borrowing knowledge from another agent within a session.

**Agents, CLI, audit**
- The audit history flowing to the platform's own Basin (Pipelines → Catalog → SQL), with metrics in Analytics Engine and Workers Traces.
- The engine's own audit events, through an ingest endpoint signed with the project key.
- Agent HTTP API with the agent key: domains, concepts, suggestions, programs.
- Organisation keys (creating projects through the CLI).
- Installing the CLI and the engine with one command, from per-OS releases kept in R2 (latest and every version).
- CLI extras: self-update, shell completion, OS keychain, `watch`, proxy support, standalone binaries.

**Platform**
- User, session and state Durable Objects, with the platform as source of truth and engine↔platform sync.
- Governance: owners, hierarchical admins, suggest/approve and a governance log.
- Authorization and permissions enforced in one place.
- Enterprise single sign-on.
- Payment, credits and usage billing.
- The data protocol for many users at once, and for showing what agents are doing in the background.
- A data warehouse like Fabric or Databricks, on both the engine and the Durable Object side (R2 SQL).
- Data sources as templates copied per project, with dialect code moved out of the platform.
- Running without Docker (Windows, macOS, Linux, Electron) with a per-project port registry.
- Programs running in dynamic workers.
- Evicting idle sessions from the engine's disk and syncing them back on demand.
- Agents running on their own remote boxes.

**Agents and thinking**
- System 2 (medium thinking).
- System 3 extending the graph from feedback and the data.
- System 4: offline consolidation.
- An agent end-to-end test suite.

**Clients**
- Microsoft Teams and Slack bots.
- Android client.
