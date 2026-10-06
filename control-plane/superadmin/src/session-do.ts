// ── SessionDO — RETIRED (2026-10-06): sessions now live in their owner's UserDO (session-store.ts) ──────────────────
// Kept only until its entries and artifacts are copied into each owner's own Durable Object, then deleted with its class.

import { DurableObject } from 'cloudflare:workers'
import { migrate as runMigrations, durableObjectDb, type Migration } from '../../../vm/packages/migrate/src/index.js'

const SESSION_MIGRATIONS: Migration[] = [
  { id: 1, name: 'baseline', up: `
    CREATE TABLE IF NOT EXISTS meta (session TEXT NOT NULL, project TEXT NOT NULL, user TEXT NOT NULL, agent TEXT NOT NULL, created TEXT NOT NULL);
    -- The session's log, in order: append-only.
    CREATE TABLE IF NOT EXISTS entries (seq INTEGER PRIMARY KEY, entry TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS entries_no_update BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT, 'a session log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS entries_no_delete BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT, 'a session log is append-only'); END;
  ` },
  { id: 2, name: 'artifacts', up: `
    -- What the session's work produced and decided (a decision record, a file, a report, a plan): every version kept.
    CREATE TABLE IF NOT EXISTS artifacts (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL,
      title TEXT NOT NULL, status TEXT NOT NULL, block TEXT, body TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL, note TEXT, UNIQUE (id, version));
    CREATE TRIGGER IF NOT EXISTS artifacts_no_update BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT, 'artifacts are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS artifacts_no_delete BEFORE DELETE ON artifacts BEGIN SELECT RAISE(ABORT, 'artifacts are append-only'); END;
  ` },
]

export class SessionDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(async () => { runMigrations(durableObjectDb(this.ctx.storage), SESSION_MIGRATIONS, { name: 'session' }) })
  }
  /** Everything it holds, for the copy: whose it is, its entries and its artifacts. */
  async fetch(): Promise<Response> {
    const sql = this.ctx.storage.sql
    return Response.json({ meta: [...sql.exec('SELECT * FROM meta')][0] ?? null, entries: [...sql.exec('SELECT seq, entry, at FROM entries ORDER BY seq')], artifacts: [...sql.exec('SELECT * FROM artifacts ORDER BY seq')] })
  }
}
