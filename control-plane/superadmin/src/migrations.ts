// Every Durable Object's SQLite changes shape only through these migrations (@superatom/migrate): numbered, never
// edited once shipped — a change is a new migration at the end of its list. Each DO runs its list once per wake, in
// its constructor under blockConcurrencyWhile; with nothing pending that is a single-row read.

import { addColumnIfMissing, type Migration, type MigrationDb } from '../../../vm/packages/migrate/src/index.js'

// ── ProjectDO ────────────────────────────────────────────────────────────────────────────────────────────────────
// Migrations 1–14 are the ProjectDO's earlier ladder (its _schema_version 1–14), carried over unchanged in meaning.

export const PROJECT_MIGRATIONS: Migration[] = [
  { id: 1, name: 'initial tables', up: `
    CREATE TABLE IF NOT EXISTS fly_machine (machine_id TEXT, status TEXT NOT NULL DEFAULT 'creating');
    CREATE TABLE IF NOT EXISTS api_key ( key TEXT NOT NULL );
    CREATE TABLE IF NOT EXISTS members (user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', PRIMARY KEY (user_id));
    CREATE TABLE IF NOT EXISTS datasources (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, tables TEXT, uploaded_by TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, question TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
  ` },
  // Idle detection: heartbeat and suspend.
  { id: 2, name: 'idle detection columns', up: (db) => {
    addColumnIfMissing(db, 'fly_machine', 'last_heartbeat', 'INTEGER NOT NULL DEFAULT 0')
    addColumnIfMissing(db, 'fly_machine', 'idle_phase', "TEXT NOT NULL DEFAULT 'active'")
  } },
  // Wake-on-message delivery.
  { id: 3, name: 'message queue', up: `
    CREATE TABLE IF NOT EXISTS message_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, msg_json TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()))
  ` },
  // Idle suspend/stop on REAL activity, not connection events; seeded from the heartbeat.
  { id: 4, name: 'last active', up: (db) => {
    addColumnIfMissing(db, 'fly_machine', 'last_active', 'INTEGER NOT NULL DEFAULT 0')
    db.exec('UPDATE fly_machine SET last_active = last_heartbeat WHERE last_active = 0')
  } },
  // 'fly' (managed lifecycle) or 'external' (a user-managed box that connects out).
  { id: 5, name: 'machine provider', up: (db) => {
    addColumnIfMissing(db, 'fly_machine', 'provider', "TEXT NOT NULL DEFAULT 'fly'")
  } },
  // Durable per-user answer buffer and recent-session snapshot (answer-buffer.ts).
  { id: 6, name: 'answer buffer', up: `
    CREATE TABLE IF NOT EXISTS answer_buffer (
      qid TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT '', session_id TEXT, question TEXT,
      payload_json TEXT, followups_json TEXT,
      at INTEGER NOT NULL, answered_at INTEGER, acked INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS idx_ab_user ON answer_buffer(user_id, at);
    CREATE TABLE IF NOT EXISTS session_snapshot (
      session_id TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT '', title TEXT, last_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, user_id));
  ` },
  // Access lives with the project, keyed by email; roles are per project, with three seeded defaults.
  { id: 7, name: 'access and roles', up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, permissions TEXT NOT NULL DEFAULT '[]',
        builtin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE IF NOT EXISTS access (
        email TEXT PRIMARY KEY, role_id TEXT, source TEXT NOT NULL DEFAULT 'direct', added_by TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()));
    `)
    const seed: Array<[string, string, string[]]> = [
      ['admin', 'Admin', ['project.manage', 'access.manage', 'data.manage', 'ask']],
      ['member', 'Member', ['ask']],
      ['viewer', 'Viewer', ['read']],
    ]
    for (const [id, name, perms] of seed)
      db.all('INSERT OR IGNORE INTO roles (id, name, permissions, builtin) VALUES (?, ?, ?, 1) RETURNING id', id, name, JSON.stringify(perms))
  } },
  // Dashboards: bytes in R2, this table finds them and knows the current build.
  { id: 8, name: 'dashboards', up: `
    CREATE TABLE IF NOT EXISTS dashboards (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, build_id TEXT, files INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0, uploaded_by TEXT, uploaded_at INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch()))
  ` },
  // The engine profile (harness/provider/model per agent); never credentials.
  { id: 9, name: 'engine profile', up: `
    CREATE TABLE IF NOT EXISTS profile (
      json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_by TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))
  ` },
  // Only rows the engine's seeder wrote are dropped; a person's choice is never touched.
  { id: 10, name: 'remove seeded profiles', up: "DELETE FROM profile WHERE updated_by = 'engine (baked default)'" },
  // What the engine reported, on disk (an in-memory field was lost on hibernation).
  { id: 11, name: 'engine running', up: `
    CREATE TABLE IF NOT EXISTS engine_running (json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL DEFAULT 0)
  ` },
  // Every build a dashboard has had, numbered; today's build becomes version 1.
  { id: 12, name: 'dashboard builds ledger', up: `
    CREATE TABLE IF NOT EXISTS dashboard_builds (
      dash_id TEXT NOT NULL, build_id TEXT NOT NULL, n INTEGER NOT NULL, files INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0, uploaded_by TEXT, uploaded_at INTEGER NOT NULL, PRIMARY KEY (dash_id, n));
    INSERT OR IGNORE INTO dashboard_builds (dash_id, build_id, n, files, bytes, uploaded_by, uploaded_at)
      SELECT id, build_id, 1, files, bytes, uploaded_by, COALESCE(uploaded_at, created_at * 1000) FROM dashboards WHERE build_id IS NOT NULL;
  ` },
  // A hash over a build's files: the same build uploaded twice is one version.
  { id: 13, name: 'build content hash', up: (db) => {
    addColumnIfMissing(db, 'dashboard_builds', 'content_hash', 'TEXT')
  } },
  // The ledger is append-only; the key moves to (dash_id, n).
  { id: 14, name: 'append-only build ledger', up: `
    CREATE TABLE IF NOT EXISTS dashboard_builds_v14 (
      dash_id TEXT NOT NULL, build_id TEXT NOT NULL, n INTEGER NOT NULL, files INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
      uploaded_by TEXT, uploaded_at INTEGER NOT NULL, content_hash TEXT, kind TEXT NOT NULL DEFAULT 'publish', from_n INTEGER, pruned_at INTEGER,
      PRIMARY KEY (dash_id, n));
    INSERT OR IGNORE INTO dashboard_builds_v14 (dash_id, build_id, n, files, bytes, uploaded_by, uploaded_at, content_hash)
      SELECT dash_id, build_id, n, files, bytes, uploaded_by, uploaded_at, content_hash FROM dashboard_builds;
    DROP TABLE dashboard_builds;
    ALTER TABLE dashboard_builds_v14 RENAME TO dashboard_builds;
  ` },
  { id: 15, name: 'agent keys and the audit history', up: `
    -- Agent API keys (agent-keys.ts): only the hash of a key is kept.
    CREATE TABLE IF NOT EXISTS agent_keys (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, revoked_by TEXT, last_used_at TEXT);
    -- The audit history (audit.ts): append-only, never updated or deleted.
    CREATE TABLE IF NOT EXISTS audit_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL,
      actor_email TEXT, via TEXT NOT NULL, action TEXT NOT NULL, target TEXT, outcome TEXT NOT NULL, detail TEXT);
    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
    CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, at);
    CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'the audit history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'the audit history is append-only'); END;
  ` },
  { id: 16, name: 'program catalogue', up: `
    -- Built programs kept by the platform (their bundles in R2 at programs/<project>/<hash>.json): one row per hash,
    -- never changed except that publishing stamps it once.
    CREATE TABLE IF NOT EXISTS programs (
      hash TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL, scope TEXT NOT NULL, owner TEXT NOT NULL,
      attaches_to TEXT, manifest TEXT NOT NULL, bytes INTEGER NOT NULL, built_by TEXT NOT NULL, uploaded_at TEXT NOT NULL,
      published_at TEXT, published_by TEXT);
    CREATE INDEX IF NOT EXISTS idx_programs_name ON programs(name, uploaded_at);
  ` },
  { id: 17, name: 'data access policies and attributes', up: `
    -- What each person or agent may read (access-policies.ts). A policy is never deleted: removing it stamps it.
    CREATE TABLE IF NOT EXISTS access_policies (
      id TEXT PRIMARY KEY, applies_to TEXT NOT NULL, source TEXT NOT NULL, table_name TEXT NOT NULL, kind TEXT NOT NULL,
      predicate TEXT, column_name TEXT, note TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, removed_at TEXT, removed_by TEXT);
    -- A reader's attributes, named in row predicates as {attr.<key>}: subject is email:<address> or agent:<key id>.
    CREATE TABLE IF NOT EXISTS access_attributes (
      subject TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (subject, key));
    -- Bumped on every change, so an engine holding resolved policies knows they are stale.
    CREATE TABLE IF NOT EXISTS access_version (version INTEGER NOT NULL);
    INSERT INTO access_version (version) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM access_version);
  ` },
  { id: 18, name: 'access by verified email domain', up: `
    -- Enterprise sign-in: anyone whose verified address is at one of these domains (their company's identity provider,
    -- federated through Clerk) gets this role on first arrival — recorded as an access row with source 'domain'.
    CREATE TABLE IF NOT EXISTS access_domains (domain TEXT PRIMARY KEY, role_id TEXT NOT NULL, added_by TEXT NOT NULL, added_at TEXT NOT NULL);
  ` },
  { id: 19, name: 'usage events', up: `
    -- Every metered use (metering.ts), append-only: a model call's tokens, priced when recorded (micro-credits).
    CREATE TABLE IF NOT EXISTS usage_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, provider TEXT, model TEXT, key_id TEXT,
      tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, ms INTEGER, credits_micro INTEGER NOT NULL, priced INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_usage_at ON usage_events(at);
    CREATE TRIGGER IF NOT EXISTS usage_no_update BEFORE UPDATE ON usage_events BEGIN SELECT RAISE(ABORT, 'usage is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS usage_no_delete BEFORE DELETE ON usage_events BEGIN SELECT RAISE(ABORT, 'usage is append-only'); END;
  ` },
  { id: 20, name: 'activities', up: `
    -- Long work in the engine, visible (engine activity.ts): each activity's latest state, for its owner and admins.
    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL,
      progress TEXT, detail TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_activities_owner ON activities(owner, updated_at);
  ` },
  { id: 21, name: 'sessions known', up: `
    -- Every session the engine has synced through this hub, so the warehouse can be backfilled from their SessionDOs.
    CREATE TABLE IF NOT EXISTS sessions_known (session TEXT PRIMARY KEY, first_seen TEXT NOT NULL);
  ` },
  { id: 22, name: 'groups', up: `
    -- Groups within the project (scopes group:<name>): members are people by email or agent keys. An admin manages them.
    CREATE TABLE IF NOT EXISTS groups (name TEXT PRIMARY KEY, description TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS group_members (grp TEXT NOT NULL, member TEXT NOT NULL, added_by TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (grp, member));
    CREATE INDEX IF NOT EXISTS idx_group_members_member ON group_members(member);
  ` },
  { id: 23, name: 'connections', up: `
    -- Connections to other systems (shared/connectors.ts): shared by the project, or one person's own. Settings in the
    -- clear; secret fields sealed with the platform's master key, never shown again. Removing stamps; nothing is deleted.
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY, connector TEXT NOT NULL, name TEXT NOT NULL, level TEXT NOT NULL CHECK (level IN ('project', 'user')), owner TEXT NOT NULL,
      settings TEXT NOT NULL, secrets_sealed TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, removed_at TEXT, removed_by TEXT);
  ` },
  { id: 24, name: 'engine sources', up: `
    -- The code connectors the engine runs (its datasource manager's sources), as it reports them on each connect —
    -- listed beside the connections people add. Their secrets stay with the engine.
    CREATE TABLE IF NOT EXISTS engine_sources (id TEXT PRIMARY KEY, kind TEXT, dialect TEXT, description TEXT, ready INTEGER NOT NULL DEFAULT 0, reported_at TEXT NOT NULL);
  ` },
  { id: 25, name: 'usage attributed', up: `
    -- Who a metered use was for, when it is known (a session's owner); and which session asked.
    ALTER TABLE usage_events ADD COLUMN principal TEXT;
    ALTER TABLE usage_events ADD COLUMN session TEXT;
    -- Each session's owner, as the hub relays their messages — so usage tagged with a session is someone's.
    CREATE TABLE IF NOT EXISTS session_owners (session TEXT PRIMARY KEY, principal TEXT NOT NULL, email TEXT, first_seen TEXT NOT NULL);
  ` },
  { id: 26, name: 'usage by agent turn', up: `
    -- Which agent made a metered call (its tag) and who counted it: the proxy, or the engine for routes that bypass it.
    ALTER TABLE usage_events ADD COLUMN tag TEXT;
    ALTER TABLE usage_events ADD COLUMN source TEXT;
    -- Prompt-cache tokens, kept apart: they are priced differently from fresh input.
    ALTER TABLE usage_events ADD COLUMN tokens_cache_read INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE usage_events ADD COLUMN tokens_cache_write INTEGER NOT NULL DEFAULT 0;
    -- When each agent (by tag) worked for which session, as the engine reports its turns — how a call is attributed.
    CREATE TABLE IF NOT EXISTS usage_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT NOT NULL, session TEXT NOT NULL, principal TEXT, started_at TEXT NOT NULL, ended_at TEXT);
    CREATE INDEX IF NOT EXISTS idx_usage_turns_tag ON usage_turns(tag, started_at);
    CREATE INDEX IF NOT EXISTS idx_usage_principal ON usage_events(principal, at);
  ` },
  { id: 27, name: 'decision register', up: `
    -- The project's decisions, as each session records and decides them: every version, append-only.
    CREATE TABLE IF NOT EXISTS decision_register (seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, artifact TEXT NOT NULL, version INTEGER NOT NULL,
      title TEXT NOT NULL, status TEXT NOT NULL, agent TEXT, by TEXT NOT NULL, at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_register_at ON decision_register(at);
    CREATE TRIGGER IF NOT EXISTS register_no_update BEFORE UPDATE ON decision_register BEGIN SELECT RAISE(ABORT, 'the decision register is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS register_no_delete BEFORE DELETE ON decision_register BEGIN SELECT RAISE(ABORT, 'the decision register is append-only'); END;
  ` },
  { id: 28, name: 'warehouse grants', up: `
    -- What this project may read of its organisation's warehouse (warehouse/access.ts): a table, and its columns or all
    -- of them (columns NULL). Every change is a new row; the grant in force is each table's latest, unless revoked.
    CREATE TABLE IF NOT EXISTS warehouse_grants (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, columns TEXT, revoked INTEGER NOT NULL DEFAULT 0, by TEXT NOT NULL, at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_wh_grants ON warehouse_grants(tbl, seq);
    CREATE TRIGGER IF NOT EXISTS wh_grants_no_update BEFORE UPDATE ON warehouse_grants BEGIN SELECT RAISE(ABORT, 'warehouse grants are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS wh_grants_no_delete BEFORE DELETE ON warehouse_grants BEGIN SELECT RAISE(ABORT, 'warehouse grants are append-only'); END;
  ` },
  { id: 29, name: 'connector calls and schemas', up: `
    -- Every operation run on a connection (connectors/): test, introspect, read, act, code — who, what, how it went —
    -- and every request its code made through the gateway (op 'http': method, host, path, status; never a header or a
    -- body). Append-only: the complete record of what reached other systems.
    CREATE TABLE IF NOT EXISTS connector_calls (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, connection TEXT, op TEXT NOT NULL, target TEXT,
      by TEXT, ok INTEGER NOT NULL, rows INTEGER, status INTEGER, ms INTEGER, error TEXT);
    CREATE INDEX IF NOT EXISTS idx_connector_calls ON connector_calls(connection, seq);
    CREATE TRIGGER IF NOT EXISTS connector_calls_no_update BEFORE UPDATE ON connector_calls BEGIN SELECT RAISE(ABORT, 'connector calls are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS connector_calls_no_delete BEFORE DELETE ON connector_calls BEGIN SELECT RAISE(ABORT, 'connector calls are append-only'); END;
    -- What a connection offers, as its connector last said (entities with their fields, actions with what they change):
    -- each introspection a new row; the data source index reads the latest.
    CREATE TABLE IF NOT EXISTS connector_schemas (seq INTEGER PRIMARY KEY AUTOINCREMENT, connection TEXT NOT NULL, entities TEXT NOT NULL, actions TEXT NOT NULL, at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_connector_schemas ON connector_schemas(connection, seq);
  ` },
  { id: 30, name: 'view events', up: `
    -- What people do in an agent's views without a session ("Views and sessions — one thread, two homes"): one small
    -- row per action — who, which agent, opened or changed, which control — never the STATE or an answer. For defaults
    -- learned from usage and the decision memory's sense of common paths. Append-only.
    CREATE TABLE IF NOT EXISTS view_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, who TEXT, agent TEXT, kind TEXT NOT NULL, detail TEXT);
    CREATE INDEX IF NOT EXISTS idx_view_events_at ON view_events(at);
    CREATE TRIGGER IF NOT EXISTS view_events_no_update BEFORE UPDATE ON view_events BEGIN SELECT RAISE(ABORT, 'view events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS view_events_no_delete BEFORE DELETE ON view_events BEGIN SELECT RAISE(ABORT, 'view events are append-only'); END;
  ` },
  { id: 31, name: 'permissions: capabilities and warehouse writes', up: (db) => {
    // Roles hold capabilities (shared/permissions.ts). The built-in roles' capabilities are the code's; the stored copy is
    // brought up to date for anyone reading the table. A custom role's old permissions are carried to their nearest.
    const NEW: Record<string, string[]> = {
      admin: ['project.view', 'project.ask', 'project.approve', 'project.connect', 'project.publish', 'project.data', 'project.people', 'project.keys', 'project.audit', 'project.manage', 'warehouse.use', 'warehouse.append'],
      member: ['project.view', 'project.ask', 'project.approve', 'project.connect', 'warehouse.use'],
      viewer: ['project.view'],
    }
    const OLD: Record<string, string[]> = { 'project.manage': ['project.manage', 'project.keys', 'project.audit', 'project.publish'], 'access.manage': ['project.people'], 'data.manage': ['project.data'], ask: ['project.view', 'project.ask'], read: ['project.view'] }
    for (const r of db.all('SELECT id, permissions, builtin FROM roles') as { id: string; permissions: string; builtin: number }[]) {
      const caps = r.builtin && NEW[r.id] ? NEW[r.id] : [...new Set((JSON.parse(r.permissions || '[]') as string[]).flatMap((p) => OLD[p] ?? (p.includes('.') ? [p] : [])))]
      db.all('UPDATE roles SET permissions = ? WHERE id = ? RETURNING id', JSON.stringify(caps), r.id)
    }
    // A project may be granted writing a warehouse table (appending to it), as well as reading it.
    addColumnIfMissing(db, 'warehouse_grants', 'write', 'INTEGER NOT NULL DEFAULT 0')
  } },
  { id: 32, name: 'the composition graph and session owners', up: `
    -- The project's composition graph as the platform keeps it (once a GraphDO of its own): its append-only records —
    -- changes, suggestions, decisions, versions, each by its number — and the content they point at, by hash.
    CREATE TABLE IF NOT EXISTS graph_records (kind TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (kind, key));
    CREATE INDEX IF NOT EXISTS graph_records_at ON graph_records (kind, at);
    CREATE TABLE IF NOT EXISTS graph_content (hash TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS graph_records_no_update BEFORE UPDATE ON graph_records BEGIN SELECT RAISE(ABORT, 'the graph''s records are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS graph_records_no_delete BEFORE DELETE ON graph_records BEGIN SELECT RAISE(ABORT, 'the graph''s records are append-only'); END;
    -- Whose each session is: its log lives in that person's UserDO.
    ALTER TABLE sessions_known ADD COLUMN user TEXT;
  ` },
  { id: 33, name: 'people linked through their UserDO', up: `
    -- Each person on this project, linked through their own UserDO (one per surface): the connection as the hub knows it.
    CREATE TABLE IF NOT EXISTS person_links (ws_id TEXT PRIMARY KEY, conn TEXT NOT NULL, at INTEGER NOT NULL);
  ` },
  { id: 34, name: 'the graph is held here', up: `
    -- The composition graph lives in this Durable Object (its tables are the graph's own, by its own migrations:
    -- _graph_migrations). Here: who changed it, by their id, with the email the hub knew them by.
    CREATE TABLE IF NOT EXISTS graph_people (id TEXT PRIMARY KEY, email TEXT NOT NULL);
  ` },
]

/** A ProjectDO made before these migrations: its _schema_version says how many of 1–14 it has. */
export function adoptProjectSchemaVersion(db: MigrationDb): number {
  try { return Number(db.all('SELECT MAX(version) AS v FROM _schema_version')[0]?.v ?? 0) } catch { return 0 }
}

// ── OrgDO ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const ORG_MIGRATIONS: Migration[] = [
  { id: 1, name: 'baseline', up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, clerk_id TEXT UNIQUE, name TEXT,
        role TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_by TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE IF NOT EXISTS datasources (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()), FOREIGN KEY (project_id) REFERENCES projects(id));
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()), FOREIGN KEY (project_id) REFERENCES projects(id));
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()), FOREIGN KEY (conversation_id) REFERENCES conversations(id));
    `)
    addColumnIfMissing(db, 'projects', 'deleted', 'INTEGER NOT NULL DEFAULT 0')
  } },
  { id: 2, name: 'credit ledger', up: `
    -- The organisation's credits (metering.ts), append-only: grants (+) and its projects' usage (−), in micro-credits.
    CREATE TABLE IF NOT EXISTS credit_ledger (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('grant', 'usage')),
      amount_micro INTEGER NOT NULL, project TEXT, note TEXT, by TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS credit_no_update BEFORE UPDATE ON credit_ledger BEGIN SELECT RAISE(ABORT, 'the credit ledger is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS credit_no_delete BEFORE DELETE ON credit_ledger BEGIN SELECT RAISE(ABORT, 'the credit ledger is append-only'); END;
  ` },
  { id: 3, name: 'budgets', up: `
    -- Credit assignment within the organisation (metering.ts): how many credits a person or a group may spend in a
    -- period. A budget is replaced by setting it again; every change is kept.
    CREATE TABLE IF NOT EXISTS budgets (seq INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, credits_micro INTEGER NOT NULL, period TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_budgets_subject ON budgets(subject, seq);
    -- Usage attributed to a person, when it is known (the usage ledger's debits carry who).
    ALTER TABLE credit_ledger ADD COLUMN principal TEXT;
  ` },
  { id: 4, name: 'warehouse operations', up: `
    -- What was done to the organisation's warehouse (warehouse/): tables made, rows appended, queries run — who, what,
    -- how it went. The data itself is in object storage; this is the record. Append-only.
    CREATE TABLE IF NOT EXISTS warehouse_ops (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, op TEXT NOT NULL, tbl TEXT, project TEXT,
      rows INTEGER, snapshot TEXT, ok INTEGER NOT NULL, detail TEXT, by TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_wh_ops_at ON warehouse_ops(at);
    CREATE TRIGGER IF NOT EXISTS wh_ops_no_update BEFORE UPDATE ON warehouse_ops BEGIN SELECT RAISE(ABORT, 'warehouse operations are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS wh_ops_no_delete BEFORE DELETE ON warehouse_ops BEGIN SELECT RAISE(ABORT, 'warehouse operations are append-only'); END;
  ` },
  { id: 5, name: 'roles and organisation keys', up: (db) => {
    // People hold an organisation role (shared/permissions.ts): owner, admin, member, or one the owners define.
    db.exec(`
      CREATE TABLE IF NOT EXISTS org_roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, capabilities TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS org_keys (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL,
        created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, revoked_by TEXT, last_used_at TEXT);
      UPDATE users SET role = 'member' WHERE role NOT IN ('owner', 'admin');
      -- Who changed who may do what (people, roles, keys): append-only.
      CREATE TABLE IF NOT EXISTS org_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, op TEXT NOT NULL, target TEXT, by TEXT NOT NULL, detail TEXT);
      CREATE TRIGGER IF NOT EXISTS org_audit_no_update BEFORE UPDATE ON org_audit BEGIN SELECT RAISE(ABORT, 'the organisation record is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS org_audit_no_delete BEFORE DELETE ON org_audit BEGIN SELECT RAISE(ABORT, 'the organisation record is append-only'); END;
    `)
    // An organisation always has an owner: its first administrator, where it has none.
    if (!db.all("SELECT 1 FROM users WHERE role = 'owner'").length) {
      const [first] = db.all("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at, email LIMIT 1")
      if (first) db.all("UPDATE users SET role = 'owner' WHERE id = ? RETURNING id", first.id)
    }
  } },
  { id: 6, name: 'billing details', up: `
    -- Who the organisation is billed as: name, billing email, address, tax number. Every change kept (the latest is in
    -- force); card details never come here — the payment provider keeps them.
    CREATE TABLE IF NOT EXISTS billing_details (seq INTEGER PRIMARY KEY AUTOINCREMENT, details TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS billing_no_update BEFORE UPDATE ON billing_details BEGIN SELECT RAISE(ABORT, 'billing details are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS billing_no_delete BEFORE DELETE ON billing_details BEGIN SELECT RAISE(ABORT, 'billing details are append-only'); END;
  ` },
  { id: 7, name: 'warehouse table owners', up: `
    -- Who owns each warehouse table (a person, or a project) and what it is: kept by the organisation beside the catalog,
    -- which knows only names and columns. Every change kept; the latest per table is in force.
    CREATE TABLE IF NOT EXISTS warehouse_tables (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, owner TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', by TEXT NOT NULL, at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS warehouse_tables_tbl ON warehouse_tables (tbl, seq);
    CREATE TRIGGER IF NOT EXISTS warehouse_tables_no_update BEFORE UPDATE ON warehouse_tables BEGIN SELECT RAISE(ABORT, 'warehouse table owners are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS warehouse_tables_no_delete BEFORE DELETE ON warehouse_tables BEGIN SELECT RAISE(ABORT, 'warehouse table owners are append-only'); END;
  ` },
]

// ── GlobalDO ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const GLOBAL_MIGRATIONS: Migration[] = [
  { id: 1, name: 'baseline', up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS superatom_users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, clerk_id TEXT UNIQUE,
        role TEXT NOT NULL DEFAULT 'superadmin', created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, do_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
        deleted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      -- *.superatom.site: subdomain → projectId (KV is a hot-read cache in front of this).
      CREATE TABLE IF NOT EXISTS domains (
        subdomain TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE INDEX IF NOT EXISTS idx_domains_project ON domains(project_id);
      -- Which models each provider may be asked for: platform-wide, held once.
      CREATE TABLE IF NOT EXISTS model_catalogue (
        json TEXT NOT NULL, updated_by TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
      -- Mobile login codes (auth/login-code-store.ts).
      CREATE TABLE IF NOT EXISTS mobile_login_code (
        code TEXT PRIMARY KEY, token TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
        code_challenge TEXT NOT NULL, expires_at INTEGER NOT NULL);
    `)
    addColumnIfMissing(db, 'organizations', 'deleted', 'INTEGER NOT NULL DEFAULT 0')
  } },
  { id: 2, name: 'price list versions', up: `
    -- The platform's price list (metering.ts): every version kept, with who set it; the newest is in force.
    CREATE TABLE IF NOT EXISTS price_list (seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL);
  ` },
]

// ── DecisionDO ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const DECISION_MIGRATIONS: Migration[] = [
  { id: 1, name: 'baseline', up: `
    CREATE TABLE IF NOT EXISTS meta (project TEXT NOT NULL);
    -- Each passage through a step: its cues, the world it showed, the path taken next, the state it was recognised as.
    CREATE TABLE IF NOT EXISTS experiences (id TEXT PRIMARY KEY, at TEXT NOT NULL, session TEXT NOT NULL, block TEXT NOT NULL, agent TEXT NOT NULL,
      scope TEXT NOT NULL, cues TEXT NOT NULL, world TEXT NOT NULL, state_hash TEXT NOT NULL, taken TEXT, recognised TEXT);
    CREATE INDEX IF NOT EXISTS idx_exp_recognised ON experiences(recognised, at);
    CREATE INDEX IF NOT EXISTS idx_exp_session ON experiences(session, block);
    CREATE TRIGGER IF NOT EXISTS exp_no_update BEFORE UPDATE ON experiences BEGIN SELECT RAISE(ABORT, 'experiences are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS exp_no_delete BEFORE DELETE ON experiences BEGIN SELECT RAISE(ABORT, 'experiences are append-only'); END;
    -- How each experience turned out, as it becomes known (a decision recorded, approved, abandoned, reversed).
    CREATE TABLE IF NOT EXISTS outcomes (seq INTEGER PRIMARY KEY AUTOINCREMENT, experience TEXT NOT NULL, at TEXT NOT NULL, outcome TEXT NOT NULL, by TEXT NOT NULL, note TEXT, artifact TEXT);
    CREATE INDEX IF NOT EXISTS idx_outcome_exp ON outcomes(experience);
    CREATE TRIGGER IF NOT EXISTS out_no_update BEFORE UPDATE ON outcomes BEGIN SELECT RAISE(ABORT, 'outcomes are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS out_no_delete BEFORE DELETE ON outcomes BEGIN SELECT RAISE(ABORT, 'outcomes are append-only'); END;
    -- Every version of every decision state, written only by a named operation: nothing is erased.
    CREATE TABLE IF NOT EXISTS versions (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, version INTEGER NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL,
      why TEXT NOT NULL, op TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL, supports TEXT NOT NULL, contradicts TEXT NOT NULL, UNIQUE (id, version));
    CREATE TRIGGER IF NOT EXISTS ver_no_update BEFORE UPDATE ON versions BEGIN SELECT RAISE(ABORT, 'decision states are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS ver_no_delete BEFORE DELETE ON versions BEGIN SELECT RAISE(ABORT, 'decision states are append-only'); END;
    -- Derived: the cues of each state's current active version — the associative index. Rebuilt on every write.
    CREATE TABLE IF NOT EXISTS cue_index (cue TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (cue, id));
    -- Parameters of recognition (thresholds): settings, not constants.
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL);
  ` },
]

// ── UserDO ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const USER_MIGRATIONS: Migration[] = [
  { id: 1, name: 'baseline', up: `
    CREATE TABLE IF NOT EXISTS sessions (project TEXT NOT NULL, session TEXT NOT NULL, agent TEXT NOT NULL, title TEXT NOT NULL,
      blocks INTEGER NOT NULL DEFAULT 0, answers INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY (project, session));
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated);
    CREATE TABLE IF NOT EXISTS state (project TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY (project, key));
  ` },
  { id: 2, name: 'warehouse queries', up: `
    -- The person's queries over a warehouse (an organisation's), from the organisation or from one of its projects
    -- (project '' = the organisation's page): every one they ran — the recent ones — and those they named (saved). Each
    -- keeps its result's columns, how often and when it last ran, how many rows it gave, and a few of them.
    CREATE TABLE IF NOT EXISTS warehouse_queries (id INTEGER PRIMARY KEY AUTOINCREMENT, org TEXT NOT NULL, project TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '', sql TEXT NOT NULL, columns TEXT, runs INTEGER NOT NULL DEFAULT 0, last_run TEXT, last_rows INTEGER,
      last_sample TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS warehouse_queries_sql ON warehouse_queries (org, project, sql);
  ` },
  { id: 3, name: 'sessions', up: `
    -- The person's sessions (once a SessionDO each): every session's log, in order and append-only, by project and session;
    -- and what each session's work produced and decided (artifacts), every version kept. The index is in sessions.
    CREATE TABLE IF NOT EXISTS session_entries (project TEXT NOT NULL, session TEXT NOT NULL, seq INTEGER NOT NULL, entry TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (project, session, seq));
    CREATE TRIGGER IF NOT EXISTS session_entries_no_update BEFORE UPDATE ON session_entries BEGIN SELECT RAISE(ABORT, 'a session log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS session_entries_no_delete BEFORE DELETE ON session_entries BEGIN SELECT RAISE(ABORT, 'a session log is append-only'); END;
    CREATE TABLE IF NOT EXISTS session_artifacts (seq INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, session TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
      kind TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, block TEXT, body TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL, note TEXT, UNIQUE (project, session, id, version));
    CREATE TRIGGER IF NOT EXISTS session_artifacts_no_update BEFORE UPDATE ON session_artifacts BEGIN SELECT RAISE(ABORT, 'artifacts are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS session_artifacts_no_delete BEFORE DELETE ON session_artifacts BEGIN SELECT RAISE(ABORT, 'artifacts are append-only'); END;
  ` },
  { id: 4, name: 'who asked what', up: `
    -- Which of the person's tabs sent a request (r:<reqId>) or asked a question (q:<qid>): its reply goes back there.
    CREATE TABLE IF NOT EXISTS asked (key TEXT PRIMARY KEY, tab TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS asked_at ON asked (at);
  ` },
  { id: 5, name: 'the inbox', up: `
    -- The person's inbox, by project (answer-buffer.ts keys it by "user_id"; here that is the project): each question as it
    -- left, its answer and follow-ups as they arrived — for a device that was away; and their recent sessions.
    CREATE TABLE IF NOT EXISTS answer_buffer (
      qid TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT '', session_id TEXT, question TEXT,
      payload_json TEXT, followups_json TEXT,
      at INTEGER NOT NULL, answered_at INTEGER, acked INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS idx_ab_user ON answer_buffer(user_id, at);
    CREATE TABLE IF NOT EXISTS session_snapshot (
      session_id TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT '', title TEXT, last_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, user_id));
  ` },
  { id: 6, name: 'sessions as the person keeps them', up: `
    -- What the person does with their own sessions: the name they gave one (over the title its first question gave it),
    -- pinned to the top, archived out of the list, and the collection it is kept in ('' = none).
    ALTER TABLE sessions ADD COLUMN name TEXT NOT NULL DEFAULT '';
    ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN collection TEXT NOT NULL DEFAULT '';
  ` },
]
