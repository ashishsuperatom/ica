// ── GraphDO — RETIRED (2026-10-06): the composition graph now lives in the ProjectDO (graph-store.ts) ───────────────
// Kept only until its records are copied into each project's own Durable Object, then deleted with its class.

import { DurableObject } from 'cloudflare:workers'
import { migrate as runMigrations, durableObjectDb, type Migration } from '../../../vm/packages/migrate/src/index.js'

const GRAPH_MIGRATIONS: Migration[] = [
  { id: 1, name: 'baseline', up: `
    -- The graph's records as the engine keeps them (change, suggestion, decision), each by its number: append-only.
    CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (kind, key));
    CREATE INDEX IF NOT EXISTS idx_records_at ON records(kind, at);
    CREATE TABLE IF NOT EXISTS content (hash TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS records_no_update BEFORE UPDATE ON records BEGIN SELECT RAISE(ABORT, 'the graph''s records are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS records_no_delete BEFORE DELETE ON records BEGIN SELECT RAISE(ABORT, 'the graph''s records are append-only'); END;
  ` },
]

export class GraphDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(async () => { runMigrations(durableObjectDb(this.ctx.storage), GRAPH_MIGRATIONS, { name: 'graph' }) })
  }
  /** Everything it holds, for the copy: its records and contents. */
  async fetch(): Promise<Response> {
    const sql = this.ctx.storage.sql
    const records = [...sql.exec('SELECT kind, key, at, body FROM records')]
    const contents = [...sql.exec('SELECT hash, body FROM content')]
    return Response.json({ records, contents })
  }
}
