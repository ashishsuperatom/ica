// ── UserDO — one person, across projects ────────────────────────────────────────────────────────────────────────────
//
// What the platform keeps for a person so it can give them a view of their own: the index of their sessions (in every
// project, with what each is about and when it last changed) and their personal state (preferences, what they pinned —
// keys and JSON values, per project or across all). Their unpublished programs and more come here later; what exactly it
// keeps is still being decided, so it starts with what is certainly theirs.

import { DurableObject } from 'cloudflare:workers'
import { migrate as runMigrations, durableObjectDb } from '../../../vm/packages/migrate/src/index.js'
import { USER_MIGRATIONS } from './migrations.js'

export class UserDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(async () => { runMigrations(durableObjectDb(this.ctx.storage), USER_MIGRATIONS, { name: 'user' }) })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
    const sql = this.ctx.storage.sql
    if (request.method === 'POST' && url.pathname === '/sessions') {
      const b = await request.json() as { project: string; session: string; agent: string; title: string; blocks: number; answers: number; created: string; updated: string }
      if (!b?.project || !b.session) return json({ error: 'a session names its project and id' }, 400)
      sql.exec(`INSERT INTO sessions (project, session, agent, title, blocks, answers, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (project, session) DO UPDATE SET agent = excluded.agent, title = excluded.title, blocks = excluded.blocks, answers = excluded.answers, updated = excluded.updated`,
        b.project, b.session, b.agent ?? '', b.title ?? '', b.blocks ?? 0, b.answers ?? 0, b.created ?? b.updated, b.updated)
      return json({ ok: true })
    }
    if (request.method === 'GET' && url.pathname === '/sessions') {
      const project = url.searchParams.get('project')
      const rows = [...(project ? sql.exec('SELECT * FROM sessions WHERE project = ? ORDER BY updated DESC LIMIT 200', project) : sql.exec('SELECT * FROM sessions ORDER BY updated DESC LIMIT 200'))]
      return json({ sessions: rows })
    }
    // Personal state: GET /state?project=…  ·  PUT /state { project, key, value }  (project '' = across projects)
    if (url.pathname === '/state') {
      if (request.method === 'GET') {
        const rows = [...sql.exec('SELECT key, value FROM state WHERE project = ?', url.searchParams.get('project') ?? '')]
        return json({ state: Object.fromEntries(rows.map((r) => [String(r.key), JSON.parse(String(r.value))])) })
      }
      if (request.method === 'PUT') {
        const b = await request.json() as { project?: string; key: string; value: unknown }
        if (!b?.key || !/^[\w.-]{1,80}$/.test(b.key)) return json({ error: 'a key is 1–80 letters, digits, dots, dashes or underscores' }, 400)
        const text = JSON.stringify(b.value ?? null)
        if (text.length > 64_000) return json({ error: 'a value is at most 64 KB' }, 400)
        sql.exec('INSERT INTO state (project, key, value, updated) VALUES (?, ?, ?, ?) ON CONFLICT (project, key) DO UPDATE SET value = excluded.value, updated = excluded.updated', b.project ?? '', b.key, text, new Date().toISOString())
        return json({ ok: true })
      }
    }
    return json({ error: 'not found' }, 404)
  }
}
