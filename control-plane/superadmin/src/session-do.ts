// ── SessionDO — one session, everything that happened in it ─────────────────────────────────────────────────────────
//
// The platform's copy of a session is the truth; the engine's file is a replica that is pushed here. The log is the
// session's entries in order (vm/packages/session core: open, block, state, answer, intent, current), each kept with its
// sequence number. An append says where it starts: entries already here are checked (the same entry twice is harmless;
// a different one is a conflict, refused), entries past a gap are refused with where the log ends, so the engine resends
// from there. Reading replays the entries — the same code the engine writes them with — as of any moment.

import { DurableObject } from 'cloudflare:workers'
import { migrate as runMigrations, durableObjectDb } from '../../../vm/packages/migrate/src/index.js'
import { replay, type Entry } from '../../../vm/packages/session/src/core.js'
import { SESSION_MIGRATIONS } from './migrations.js'
import { createRecorder } from './records.js'

export class SessionDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(async () => { runMigrations(durableObjectDb(this.ctx.storage), SESSION_MIGRATIONS, { name: 'session' }) })
  }

  private count(): number { return Number([...this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM entries')][0]?.n ?? 0) }
  private entries(): Entry[] { return [...this.ctx.storage.sql.exec('SELECT entry FROM entries ORDER BY seq')].map((r) => JSON.parse(String(r.entry))) }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
    if (request.method === 'POST' && url.pathname === '/append') {
      const b = await request.json() as { project: string; session: string; from: number; entries: Entry[] }
      if (!b?.session || !Number.isInteger(b.from) || b.from < 0 || !Array.isArray(b.entries)) return json({ error: 'an append names its session, where it starts, and its entries' }, 400)
      const meta = [...this.ctx.storage.sql.exec('SELECT session, project FROM meta')][0]
      if (meta && (meta.session !== b.session || meta.project !== b.project)) return json({ error: `this is session ${meta.session} of ${meta.project}` }, 409)
      const n = this.count()
      if (b.from > n) return json({ upto: n, gap: true })   // resend from where the log ends
      let added = 0
      try { this.ctx.storage.transactionSync(() => {
        b.entries.forEach((e, i) => {
          const seq = b.from + i
          const text = JSON.stringify(e)
          if (seq < n) {
            const [have] = [...this.ctx.storage.sql.exec('SELECT entry FROM entries WHERE seq = ?', seq)]
            if (have && String(have.entry) !== text) throw new Conflict(seq)
            return
          }
          this.ctx.storage.sql.exec('INSERT INTO entries (seq, entry, at) VALUES (?, ?, ?)', seq, text, (e as any).at ?? new Date().toISOString())
          createRecorder((this.env as any).RECORDS, () => b.project)('session.entry', `${b.session}:${seq}`, { session: b.session, seq, entry: e }, (e as any).at)
          added++
        })
        if (!meta) {
          const open = b.from === 0 ? b.entries.find((e) => e.t === 'open') as Extract<Entry, { t: 'open' }> | undefined : undefined
          if (open) this.ctx.storage.sql.exec('INSERT INTO meta (session, project, user, agent, created) VALUES (?, ?, ?, ?, ?)', b.session, b.project, open.user, open.agent, open.at)
        }
      }) } catch (e) { if (e instanceof Conflict) return json({ error: e.message, conflict: e.seq, upto: n }, 409); throw e }
      const v = replay(this.entries())
      return json({ upto: this.count(), added, summary: v ? { user: v.user, agent: v.agent, blocks: v.blocks.length, answers: v.answers.length, created: v.created, updated: v.updated, title: titleOf(v) } : null })
    }
    if (request.method === 'GET' && url.pathname === '/view') {
      const v = replay(this.entries(), url.searchParams.get('asOf') ?? undefined)
      return v ? json({ view: v, upto: this.count() }) : json({ error: 'there is no such session' }, 404)
    }
    if (request.method === 'GET' && url.pathname === '/upto') return json({ upto: this.count() })
    if (request.method === 'POST' && url.pathname === '/backfill') {
      const b = await request.json() as { project: string; session: string }
      const record = createRecorder((this.env as any).RECORDS, () => b.project)
      let n = 0
      for (const r of [...this.ctx.storage.sql.exec('SELECT seq, entry, at FROM entries ORDER BY seq')] as any[]) { record('session.entry', `${b.session}:${r.seq}`, { session: b.session, seq: r.seq, entry: JSON.parse(r.entry) }, r.at); n++ }
      return json({ entries: n })
    }
    return json({ error: 'not found' }, 404)
  }
}

class Conflict extends Error { constructor(public seq: number) { super(`entry ${seq} differs from the one already kept`) } }

/** A session's title, for lists: its first answer's first line, or its agent. */
function titleOf(v: NonNullable<ReturnType<typeof replay>>): string {
  const first = v.answers[0]?.markdown.split('\n').find((l) => l.trim() && !l.trim().startsWith(':::'))
  return (first ?? v.agent).slice(0, 120)
}
