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

// ── SessionDO and UserDO ─────────────────────────────────────────────────────────────────────────────────────────────

export const SESSION_MIGRATIONS: Migration[] = [
  { id: 1, name: 'baseline', up: `
    CREATE TABLE IF NOT EXISTS meta (session TEXT NOT NULL, project TEXT NOT NULL, user TEXT NOT NULL, agent TEXT NOT NULL, created TEXT NOT NULL);
    -- The session's log, in order: append-only.
    CREATE TABLE IF NOT EXISTS entries (seq INTEGER PRIMARY KEY, entry TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS entries_no_update BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT, 'a session log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS entries_no_delete BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT, 'a session log is append-only'); END;
  ` },
]

export const USER_MIGRATIONS: Migration[] = [
  { id: 1, name: 'baseline', up: `
    CREATE TABLE IF NOT EXISTS sessions (project TEXT NOT NULL, session TEXT NOT NULL, agent TEXT NOT NULL, title TEXT NOT NULL,
      blocks INTEGER NOT NULL DEFAULT 0, answers INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY (project, session));
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated);
    CREATE TABLE IF NOT EXISTS state (project TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY (project, key));
  ` },
]

// ── GraphDO ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export const GRAPH_MIGRATIONS: Migration[] = [
  { id: 1, name: 'baseline', up: `
    -- The graph's records as the engine keeps them (change, suggestion, decision), each by its number: append-only.
    CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (kind, key));
    CREATE INDEX IF NOT EXISTS idx_records_at ON records(kind, at);
    CREATE TABLE IF NOT EXISTS content (hash TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS records_no_update BEFORE UPDATE ON records BEGIN SELECT RAISE(ABORT, 'the graph''s records are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS records_no_delete BEFORE DELETE ON records BEGIN SELECT RAISE(ABORT, 'the graph''s records are append-only'); END;
  ` },
]
