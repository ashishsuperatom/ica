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
- Each source's index held by the platform (ProjectDO): tables and fields, three descriptions (a person's > the source's > an AI's), table- and field-level disable (hidden from find-schema/get-schema, queries not blocked), nothing deleted (gone), every change logged — the index as of any time; one snapshot file for screens.
- Index builds run where the connector runs (the engine today): phase 1 names/types/descriptions, phase 2 cheap row counts; checkpoints on the platform (resume after any failure or restart, nothing read twice); an unreadable table never counts as empty; targeted rebuild of named tables; one build at a time (lease + heartbeat); resumes by itself when the engine is back.
- The engine's index replica follows the platform by cursor (current state of what changed, never history); per-source fingerprints after each catch-up — only a source that differs is pulled again, never everything. The graph replica checks its change log's fingerprint and rebuilds when it differs.
- Storage ledger: every object in the shared bucket written and removed through one module and recorded in its project's ledger (key, kind, size, who, when); usage per project (by kind, by person) and per organisation (summed); a person lists and deletes their own (or everything of theirs), someone who runs the project anyone's — never what is in use; sacli storage. Secrets on their own path: sealed on entry, sent only in SECRET_PAYLOADS inline on the engine's socket, never a parcel or a bucket object.
- One transport in every direction: big bodies go beside the wire as parcels from the platform, the engine (its messages to the platform too), browsers, the admin console and the CLI; packed in one place and opened in one place per end; a parcel whose body is not the message its pointer names is refused. One route for every stored thing (`/api/projects/<p>/objects/<kind>/<id>`: parcels by ticket; program builds, bridges, session files by the engine's key). Secrets travel only inline on the authenticated socket.
- One job protocol for long work (job:start/beat/end, kind, lease, stage, doing, counts, stale after a minute), seen live by the project's admins.
- Data sources carry kind, dialect, description, and shared or per-user keys (a person's own key kept sealed); updated in place (a secret left out is kept).
- A data source's bridge goes in through the platform (sacli datasources bridge / --bridge): the SQL Server-protocol bridge template (SQL Server, Azure SQL, Microsoft Fabric — Entra service principal or SQL login); a source can say its metadata cannot count rows (cheapCounts: false), and the build then skips phase 2.
- Console "Data sources" page (first in the Data area): the project at the centre (its name and size growing in as known) with every source branching out, each with its logo (from its connector, else its dialect, else its letters) and state; a source chosen opens tree columns (TreeColumns: sources, tables, fields, details — edge to edge, each column scrolls on its own and is resized by dragging, arrow keys walk it as a grid) with one search over every source (names, types, descriptions); the details column does everything: a source's summary, builds and what was not read (read again), a table's or field's descriptions (write one), enable/disable, read again.
- One data explorer for the warehouse and every connected source (the Warehouse place; each source a group): the same reads (rows searched, filtered, sorted, paged; columns profiled) from one module, clients/explore.ts — a warehouse read checked by the organisation, a source's read run on the engine through the datasource manager in the source's dialect, as the asker (their data access applied). SQL sources; files and APIs planned.
- A general domain marked fallback: a question no specialised domain separates goes there (routing counts only words that tell the domains apart, or a domain's own intents); it carries {{sources}} and the schema and query tools.
- A data source's lifecycle from every door: its connector's ready bridge (bundled with its own driver — the engine installs nothing per connector) attached on create; state from the engine's proof (no code yet, waiting for the engine, ready, not reachable); index built; tables become lineage datasets; a removed source's index marked gone.
- Concepts carry {{variables}} filled when an agent is composed — {{sources}}: the project's live data sources (kind, dialect, tables, reachable) — kept with the composition; no knowledge names its sources by hand.
- Owners and sensitivity (public, internal, confidential, personal) per table and field, kept with their history; shown and set in the source's details.
- Lineage, kept by the platform: datasets and "made from" links with who told us — pipelines (OpenLineage run events posted with a project key), people and agents; a Lineage page lists and declares them.
- Browser cache for every web client (IndexedDB, clients/kept.ts): parcels kept by hash (checked, never fetched twice); console requests show the last answer at once and refresh when it differs (hub.kept). Cleared on Log out.
- sacli datasources (list/show/create/update/remove/my-key; values from flags, a prefixed KEY=VALUE file, secrets read from files) and sacli dsi (stats/show --as-of/describe --by/enable/disable/build --tables/status --watch/snapshot).
- Two live projects: Fusion5 (NetSuite through a SuiteQL bridge) and Total Group (Microsoft SQL Server).

**Knowledge and computation**
- Composition graph: concepts, domains, files and settings stored by hash, an append-only change log, time travel, scopes and owners, join/leave, and a CLI for every change.
- Nothing jumps: lists show loading rows of their size until read, with search and pages; figures and charts hold their size while their numbers load; the platform's organisations and an organisation's projects are searchable, paged lists.
- Arrange in the framework (from slob): move a block's or a page's cards up and down, hide and bring back, kept in this browser — every block, every console page, the user UI and the project template's app.
- The admin console in three layers with their own addresses: the platform (`/`), an organisation (`/o/<org>/…`: projects, people and roles, warehouse, usage, billing details, settings), a project (`/o/<org>/p/<project>/…`); a sidebar per layer, breadcrumbs with switchers, places shown by what one's role holds, old addresses redirected, a failing page contained.
- Intermediate concepts (a combination of atomic concepts, in order) between domains and atomic concepts; attach and detach at either level; the console's composition graph as three columns (domains → intermediate → atomic), what is attached first, each column searchable and scrolling on its own, new concepts made and attached in place.
- Draft and published versions of the composition graph: edits are a draft; Publish makes v1, v2, … which is what the agents read (picking, composing, listing); Discard sets the draft back; an older version brought into the draft and published starts a new line; versions drawn as a git graph on the graph page and the changes page (List / Graph); CLI, hub and replicated to the platform.
- The warehouse explorer: the organisation's tables as the whole page (tables by owner, rows searched/filtered/sorted/paged, columns profiled with spreads and commonest values), table owners, the same explorer for a project over its grant, structured reads checked by the organisation; `sacli warehouse explore`.
- The warehouse explorer, round two: one search (tables and columns on the left, the open table's rows in the warehouse); rows as a sheet (select, arrows, shift ranges, Ctrl/⌘-C); queries explored like tables, each person's own in their UserDO (every run recorded with a few rows, named ones saved; from the organisation or a project); Rill's column panel (sort, summary or example, a small histogram per number and date column, distributions with shares); a browser LRU of its own; `sacli warehouse explore --sql`.
- Project access in the console: who has access and their role (changed in place), the project's roles in plain words, a project's own roles made from the capabilities its maker holds.
- Migrations for every database, engine and Durable Objects alike: one runner, no down migrations, a fast check; engine databases backed up beside themselves (no off-box backup, none for Durable Objects).
- Platform types: the shapes of STATE, ops, intents, programs, answers, agents, sessions and the governance log, each with checks that answer in sentences.
- STATE engine: every function gets the whole STATE frozen and can set only its own slice; it re-runs whatever reads a changed path, in dependency order.
- Programs: a Node side and a React side built with TypeScript, identified by hash, kept immutable in a store, loaded into STATE, inspectable; with a CLI.
- Programs' views loaded by screens from the platform (R2, by hash) — the engine is not needed to draw them; the engine uploads every program it built on each connect.
- The program contract (`docs/program-contract.md`) and template (`programs init`), the one standard every builder works to.
- Agents as first-class nodes of the composition graph (owned, scoped, governed, versioned, kept by the platform), made with `graph:agent`.
- Program pipeline: source sent by a person or agent, built by the engine, uploaded as a hash-checked bundle to R2 and the project's catalogue, published by its owner (over the hub; no screen or named CLI command yet), fetched and checked by any engine that runs it.
- Governance in the composition graph: one owner per node, others suggest, the owner approves or rejects (stale suggestions refused), all append-only; the graph read and changed over the hub (`graph:*`).
- Agents over HTTP: one route that sends an agent's message through the same path as its WebSocket.
- Sessions: one user's blocks as a tree (each path through it a thread), current-view vs new-block intents, branching from earlier blocks, the answer history, stale runs dropped, an append-only log readable as of any moment.
- Agent sessions on the engine: an agent defined in the project home runs its programs as sessions of blocks over the hub (`session:*`), each answer drawn as the answer card and each program's own view in its block.
- UI library: `<Intent>` with one delegated listener and a list of every intent on screen, the thread view with branches, and loading a program's React side with the platform's own React.
- Project homes under `~/.superatom/<projectId>`, and a project template (new, check, sync).
- A per-project deterministic application behind the engine's `app:` seam (the Fusion5 and Total Group dashboards).
- A guard that keeps platform code free of any one dataset's vocabulary.

**Agents and the CLI**
- One key tree: organisation keys (`sak_org_<org>_…`) and project keys (`sak_<project>_…`) hold capabilities — the names roles use — never more than their maker holds now; a key holding `org.keys`/`project.keys` makes keys at or below its node; a key revokes only keys below it; revoking a key ends its and its descendants' connections and calls; an organisation key with `org.projects` creates, deletes and restores projects and holds every project capability in them; no key makes an organisation. Shown once, stored only as a hash, expiring.
- Keys accepted at every door: the hub socket, `POST /api/agent/<project>`, and the REST API (`Authorization: Bearer sak_…`), with the same checks and audit as a person.
- Agent connections to the hub: only to the engine and the platform, only what the key holds, the agent's identity stamped on every message.
- The hub stamps who sent every message, so the engine always knows the user.
- Audit history in each project's Durable Object, from one path only: every message through its relay and every HTTP call through its one gate, recorded once (specific event or the call itself); append-only, never written from outside. The engine's own events are not recorded yet.
- Background work visible: program builds and session runs reported as activities (running, done, failed), kept by the hub and sent to their owner and admins; listed on reconnect and by `sacli activity`.
- Credit assignment: budgets for people and groups within an organisation (monthly or total), usage attributed to a session's owner, people over budget refused new work.
- Usage metering and credits: every model call's tokens kept per project and priced from the platform's price list (versions kept); an append-only credit ledger per organisation (grants by the platform, debits by usage); work refused, with a sentence, when an organisation on a plan has used its credits.
- Enterprise sign-in provisioned on first arrival: a project lets a company domain in with a role (the domain's ownership is not checked yet; Clerk runs on a development instance) (never admin, never a public mail domain), the grant audited; the identity provider itself is connected in Clerk.
- User UI pages: Agents (list, open, make a new agent — its domain, programs, who sees it), Activity (live background work), Connections; the admin console's Groups panel.
- Connections to other systems, one thing in two kinds — code connectors (our bridges in the engine) and API connectors (HTTP APIs, MCP servers): a registry of connectors with their forms; connections shared by the project (admins) or a person's own; secrets sealed with the platform's master key, never shown again, handed to the engine only when it runs them (a personal one only for its owner); the engine's own sources listed beside them; a Connections page in the user UI.
- Groups and scope everywhere it matters: groups per project; the hub stamps each sender's scopes on every message; knowledge, agents and programs show only what those scopes see; policies can apply to a group.
- Agents' own data tools apply the asker's data access (written per turn; unresolvable means nothing is read).
- Data access page: rules read as sentences, a New rule dialog picking source, table and column from the data source index; readers listed with their attributes; company sign-in.
- Data access per reader: row filters, denials and column masks per source and table (SQL sources; other sources are not filtered yet), for everyone, a role, a person or an agent key, with per-reader attributes (fail closed); resolved by the platform, carried with each session intent, applied by the SQL rewrite to every table read.
- Permissions, one system for everything (shared/permissions.ts): capabilities in one vocabulary; organisation roles (owner, admin, member, custom — e.g. a data engineer who queries and writes the warehouse) and project roles (admin, member, viewer, custom) as sets of them; every project route, organisation route and hub message names what it needs (unnamed: the strongest); no one gives a role, custom role or key more than they hold; an organisation keeps an owner; a viewer never asks; a message sent in parts is checked whole; a key holds its maker's capabilities cut to its scopes, at every use; publishing (widening what others see) is a capability and a key scope; a new graph node starts in its maker's own scope; graph history and suggestions only for what one sees; members no longer read others' usage, logs or sessions; a domain is released only by its project; the organisation's own record of people, roles and keys.
- Organisation keys (`sak_org_<org>_…`) for the warehouse; warehouse grants that also allow writing (whole tables); `warehouse:append` from a project within its grant (capability `warehouse.append`).
- `sacli`, the Superatom CLI: login with profiles (one project or organisation each), the warehouse (tables, query, append; create and grant with an organisation key), agents, sessions, asking questions, JSON output, exit codes, and one background connection per project that cleans up after an hour idle.
- `sacli engine start|status|stop|logs`: where a project's engine runs, from the CLI — in Docker by default (a container and volume per project, restarted unless stopped; the image built from the repo when missing; started again it changes nothing, or remakes the container on the same volume when the image changed), or `--native` under PM2 from the project's home — the same on every OS (Docker is Docker on Mac, Windows and Linux; native is always PM2); what it connects with comes from the platform (`/engine-credentials`, project.manage); one engine per project, refused when the hub already has one; waits until the hub has it. The engine image carries `clients/` (it had stopped booting without it).

**Platform (Cloudflare)**
- Control-plane Worker with Org, Project, Global and Channel Durable Objects, serving the admin console and each project's user UI on superatom.site.
- Sign-in through Clerk to our own tokens, plus browser-redirect PKCE login for mobile.
- Every person through their own UserDO: all their tabs and devices (web app, console, iOS, project apps) connect there, linked to each project by RPC; each tab gets only its own replies, the answers and news of the sessions it has open, and the logs and terminals it attached to.
- Sessions kept by the platform, in their owner's UserDO: each session's log (append-only, ordered, conflicts refused), the engine syncs every append and catches up on reconnect, and a person reads their sessions back without the engine.
- The composition graph held by the platform (2026-10-07): the project's Durable Object holds it (the composition-graph package over its SQLite) and answers every read and governed change people and agents make, and the console's graph views — no engine needed; each engine keeps a replica it only pulls (on welcome and when told it changed), rebuilt from the platform when it disagrees; nodes an engine generates (an agent made from a session) are written by the platform, as the person; routed questions are recorded there. The project's written knowledge is imported straight into it (`sacli graph import knowledge/index.mts`, by someone who may publish); the `composition-graph` CLI only reads an engine's replica; the engine reads no knowledge or agent files from disk.
- Connections held by the platform (2026-10-07): a code connection carries its bridge (by hash) beside its settings and sealed secrets; the engine downloads them on welcome and when told they changed, writes each bridge and registers it with the data source manager, settings and secrets in memory only; a manager that restarted is given its sources again; a bridge the connector agent writes goes up to the platform; credentials are entered only in the console.
- A UserDO per person: the index of their sessions across projects (its personal-state store is not used yet).
- Answer durability: each person's UserDO buffers their answers, and iOS pulls the ones it missed.
- Parcel transport: large bodies stored in R2 by hash with HMAC tickets.
- Model proxy: provider keys held in a vault, per-project metering, failed-login throttling (no request rate limits yet), and a tunnel for codex.
- Speech-to-text endpoint.
- Dashboard publishing: a built app is uploaded to R2 and served per project, with versioned builds and rollback.
- Admin console: analyst, connector and grounding terminals, models, credentials, dashboards and an inspector.
- Models through OpenRouter with an API key for every harness (Claude Code, codex, pi, opencode): the proxy proves the project, attaches the vault key for the project's credential group (platform or organisation) and meters the call; subscription logins stay as options.
- One model, many names: a profile names a model once; it is translated to each account's spelling, checked against the account's own list when saved (refused with the nearest names), and no harness ever substitutes another model.
- Artifacts and the decision register: a decision recorded from a step (what was decided, the options, the path chosen, why, and what it rested on — the step's answer, STATE and figures, filled in by the platform) is a versioned, append-only artifact of the session; approval by someone other than its maker; approved, rejected, reversed or superseded as new versions; every decision in the project's register (as of any moment); recording one tells the decision memory how the steps that led to it turned out; hub artifact:record/decide/list/get and decision:register.
- Programs reach a domain's logic through ctx.services.program(domain, file, args) (the composition graph's programs, run where the platform places them, with the asker's data access); answers name the figures they showed (world). First Fusion5 scenario on it: the PMO health program and agent (real NetSuite data in a session: KPIs, RAG bars, go-lives; actions only red/amber, by pillar/manager, 30 days, the whole).
- Agents open on their starting screen (their programs run as the session opens — a dashboard shows its data at once); an agent made from a session (forked with lineage, on a domain of its own holding what the session learned as worked examples, the person's own); publishing decided — widening a node's scope is suggested (graph:publish) and an admin approves; Publish on the Agents page, Make an agent in the workspace.
- Every Fusion5 and TotalGroup scenario is an agent in the workspace: the generic app-views program (the project's application asked through ctx.services.app — run, next moves, rows clicked to drill) with one agent per scenario starting from its root view; verified on real data (F5 allocation, utilisation, revenue; TG bookings, hire, receivables, revenue).
- The default agent: a question asked from home with no agent picked goes to the agent whose domain its words reach, else to the project's default agent (an agent marked isDefault, answering from whichever domain the words reach); session:start opens the session, runs its programs and answers; the workspace home asks anything.
- Words in a session: the composer answers on the agent's domain, told the step's STATE, what it shows and the programs' docs; an :::intent line in its answer changes STATE or calls a program, here or in a new step.
- The admin console rethought around decisions: Attention first (per project: engine away, work that failed, decisions awaiting approval, suggestions to decide — /api/projects/<id>/attention; for the platform: credentials expiring, engines that have not reported), each item opening its step (an approval with approve/reject and a note; a suggestion to decide) and leaving a receipt; places grouped by purpose for the scope in view (Knowledge, Data, Agents at work, People and access, Operations; the organisation's projects, members, usage; the platform's credentials and models); the addresses name the current block (reload and links land on it).
- A semantic design system: Form, Field, Choices, Receipt, RecordList, Status, AttentionList, ActionBar, Empty — each owning its styles on the tokens (design/semantic.css); screens compose them and write no CSS; theming is token overrides.
- The admin console is a thread of blocks (the admin workspace, its default): every console screen is a block drawn in a router of its own; a move elsewhere (a tab, a view, another project) opens a new block below; the screen's section links are the block's actions; on the platform's design system; the classic pages stay at ?classic=1.
- Every surface a thread of blocks: a thread kept in the browser (LocalThread in @superatom/ui: a tree of blocks in the history, branches, a registry of block types, the same frames); the user UI's pages are blocks of it — home (ask anything, agents, sessions), agents (publish), making an agent (a form that locks and leaves its receipt), activity, connections (connecting: form → receipt); an agent made from a session is an artifact of it; /w?page=<block> opens one.
- The workspace (user UI at /w, on the framework), like a chat app: left — a rail always there (Home, Agents, Connections; the person's menu at its foot: profile, settings, agents, connections, activity, help ▸ keyboard shortcuts, log out) and beside it the panel of the place picked (pinned beside, or opened over the page on hover): Home's is New chat and the conversations (pinned, each collection, the rest, a page at a time; a "…" menu each: rename, pin, keep in a collection, archive), Agents' the agents; activity (bell, ⌥⌘U) and search (⌘K) in the panel's head; Profile (who, what one may do) and Settings (archived conversations, collections, shortcuts) pages; the ask bar at the foot of every page, a question from a new chat starting a session like any other; middle — a session's steps (each with what opened it, the answer component, the programs' views, paths from here with the decision memory's learned paths and the programs' actions, recording a decision), branches at forks, asking in words with live narration; right — the session's artifacts. It is the only view: the earlier chat and agent consoles are gone (old /c/<id> and /s/<agent> addresses open here); a project admin can watch a session's agent work beside its artifacts.
- The first learner: where people reached the same step (one agent, the same STATE) at least twice and took paths from it, a decision state of those paths with how often each was taken — written only through the named operations, every six hours while experiences arrive (a DO alarm) or on demand (decision:learn); replaceable by System 4 without other change.
- One UI framework (@superatom/ui): slob's design system in plain CSS, the shell (left navigation, the thread, the artifacts pane on the right), block frames and branch bars, the one answer component and its block renderers, paths from here, artifacts, primitives (Section, Select, MultiSelect, ViewToggle, Donut, StackedBars), helpers; the project template and both project dashboards draw from it instead of copies (sync retires moved files).
- Decision memory (DecisionDO, one per project, on the stable-attractor pattern): every intent in a session recorded as an experience (the step's cues and world, the path taken); decision states made and changed only through named operations (create, reinforce, weaken, merge, generalise, specialise, supersede, split, compete, invalidate), append-only and readable as of any moment; recognition of a step (learned · similar, learned · changed with what moved, not learned) with each path's reasoning and record; outcomes; hub messages decision:paths/outcome/states/state/change; agent-key scopes decisions and learn.
- Usage per person for every harness: each model call's usage as the harness itself reports it (pi, opencode, Claude Code's transcript, codex's session log), stamped with the turn's session and person, kept append-only with cache tokens; organisation admins see usage per person per month across projects.
- Reporting worker: renders an answer as HTML and PNG (used by the channel bots, on the earlier chat path).
- Cloudflare config on wrangler.jsonc with a current compatibility date and pinned tool versions.

**Deployment and clients**
- Docker image for the engine, and provisioning of one Fly.io machine per project.
- iOS voice-first client, through its person's UserDO; each question is a composer turn in a session (the app's own conversation), answers drawn by its own renderer. No agents list or session views yet; not yet on TestFlight (scripts/testflight.sh needs App Store Connect access).

- The organisation's data warehouse (inside the Worker; live on Cloudflare R2 Data Catalog + R2 SQL, verified 2026-10-06 with a 3,000-row table in the TotalGroup organisation; the catalog's automatic compaction on, 128 MB files): one Iceberg warehouse per organisation in the shared Basin Catalog; the Data Source Bridge (tables, describe, query) and Ingest (make a table, append) apart; appends written from the Worker (Parquet + Avro manifests + a conflict-safe commit, verified with DuckDB and PyIceberg); Basin SQL reads behind a fail-closed access check; project grants by table and column (ProjectDO), the OrgDO's record of what was done; hub `warehouse:*` with the `warehouse` scope; the console's Warehouse tab.
- The admin console on the semantic design system: every screen built from PageHeader, Section, RecordList, Receipt, Form, Figures, Tabs, Status, Notice, Code, Empty, Dialog — no inline styles or legacy classes left (xterm's sizing aside).
- The workspace steady and whole: a step appears complete (its program views loaded, its paths read), a new step stands at once as an answer-shaped skeleton, an edit in place dims the step; the step anatomy of the dashboards (header from the answer's first line, controls above, next moves as pills, about these numbers); the artifacts pane opens and closes from one corner.
- Agents carry their look (icon, accent, one line) and starting points; home is the dashboards' front door (a section per agent, its starting points as cards); `session:open { startAt }`.
- A view's question as framework components: QuestionControls (filter chips, adding a filter with members searched, breakdown, window by kind, assumptions), NextMoves, AboutNumbers — used by the app-views program; programs' views may read through the surface (`ProgramEnv`) while changes stay intents.
- Connectors (`connectors/`): a package of its own — manifest, server module on one SDK (HTTP with retries and paging, rows and types from JSON, one MCP client), built by hash; run in Cloudflare Dynamic Workers whose only way out is the gateway (allowed hosts, credentials added there, every request recorded); data and actions apart (a change needs a person's confirmation); code mode (a program over the connections, no network of its own); github, rest-json, mcp-server built; in the one connections catalog; the user UI opens a connection (test, entities, rows, actions, record).
- Views and sessions: an agent is browsed as a view kept by the browser (steps in the history, the current STATE in the address, nothing written on the server but a usage row); it becomes a session only at a question to the agent or a recorded decision, by replaying the path in the engine.

## Planned
- Recording a decision from a step in the user app: taken off the steps (2026-10-08) until how decisions happen is rethought (the user); the decision register stays on the platform.
- Data area, next: the explorer's reads for files and APIs, and saved queries over a source; lineage read from the sources (a view's SQL, parsed) and from our own reads (the datasource manager's record of what each program and agent reads); a lineage map drawn, around one dataset; freshness and schema-change watch per source; quality checks with their history; usage (what is read, by whom, what never is); trust marks on tables; columns linked to the graph's concepts (a glossary); sensitivity tags suggesting masks in data access.
- Data sources: queries through each person's own key for per-user sources; connectors running in a Cloudflare worker building their index; the index's console page in its own design; profiling/linking/AI descriptions of the index.

- Rate limits on creating organisations and on creating projects per organisation — tight: e.g. at most ~10 new projects a day and ~100 in all per organisation (the user, 2026-10-07: "we want to do rate limit on project creation and organization creation"; not now).

- Every data flow platform → engine by default, engine → platform only for what the engine generates (in progress: connections and credentials, program and app source, settings, grounding, sessions back down).

- Conversations: delete (the session log is append-only — needs a decision), share, and the final word for a collection of conversations. The person's menu: upgrade plan (with Stripe), personalisation. (not built)
- Backups and restore: project homes off the box, Durable Objects exported, a restore drill.
- Production identity: Clerk on a production instance, company domains verified (DNS), SCIM provisioning and deprovisioning, token revocation.
- Audit complete: the engine's own events recorded; the platform recorder bound (its RECORDS stream is unbound, so records are dropped).
- Observability: alerts when an engine stops reporting, a sync diverges or errors rise; the engine's logs shipped.
- Rate limits and fairness per person and per project (requests, agent turns), beyond credits.
- Onboarding: organisations made self-serve, invitations and email, a one-command engine install.
- Programs sandboxed: their server side off the engine's process, their React side out of the page's origin.
- Prices for prompt-cache tokens (counted per call, not yet priced).

**Product**
- The `analyse` door retired: iOS, the channel bots and `sacli ask` speak sessions themselves (today it is a turn in a session, answered in the older answer shape).
- A data hub (bounded cache refreshed by server events) and a design system for the new UI.
- The builder agent, which writes programs and the concepts that tell agents how to use them.
- The org knowledge index that programs attach to.
- Decision state in the screens: paths from here on every step, the learning path (System 4) writing decision states, artifacts on the right.
- Borrowing knowledge from another agent within a session.

**Agents, CLI, audit**
- The audit history flowing to the platform's own Basin (Pipelines → Catalog → R2 SQL); Analytics Engine dropped, Workers Logs and Traces on.
- The engine's own audit events, through an ingest endpoint signed with the project key.
- Organisation keys creating projects through the CLI.
- Permissions still to do: one principal name for a person everywhere; revocable sign-in tokens; service tokens bound to one project; the consoles showing only what one's capabilities allow (the server already refuses); roles and organisation keys in the console.
- Installing the CLI and the engine with one command, from per-OS releases kept in R2 (latest and every version).
- CLI extras: self-update, shell completion, OS keychain, `watch`, proxy support, standalone binaries.

**Platform**
- Changing knowledge on the platform with the engine offline (today every change goes through an engine and is replicated up).
- The user DO's personalised view (what it keeps beyond sessions and personal state is still being decided).
- Sandboxing agents so their tools cannot bypass data access deliberately (dynamic workers).
- Engine bridges for the SQL Server, Postgres and REST connectors run from a connection's settings; API and MCP connections in the data source index; organisation-level connections across projects; hundreds more connectors.
- SCIM directory sync and deprovisioning from the identity provider.
- Payment through Stripe (a checkout whose webhook adds credits), invoices and per-plan limits; metering engine time and queries.
- The data protocol for many users at once (fairness and queueing across users); activities in the user UI.
- The platform's own data warehouse: every DO's records in one Basin, queryable with SQL (customer warehouses stopped: Pipelines' 20-per-account limit).
- Connectors next: the datasource index over connector schemas; a `cloud` source kind in the datasource manager; OAuth 2 connections; connectors' own React views; an approval flow for actions agents propose; semantic models over connector entities; more connectors.
- A `warehouse` source kind in the datasource manager; partition specs for large time-series tables (Iceberg, `month(column)`).
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
- Microsoft Teams and Slack bots. Teams has its path: a conversation is one session, the composer answers in a few lines for a chat, and the reply card carries the report's image and a link to the full report (narration at most a line a minute). Not yet tried in a live Teams chat; Slack has no path yet.
- Android client.
