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
import { stepOf, takenOf, scopeOfUser } from '../../../vm/packages/decision/src/index.js'

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
      const all = this.entries()
      // Each intent that arrived is a passage through a step: what the step was (cues, world) and the path taken from it,
      // for the project's decision memory. Recorded there; a failure never refuses the append.
      if (added && (this.env as any).DECISION) {
        const fresh = all.slice(all.length - added)
        for (let k = 0; k < fresh.length; k++) {
          const e = fresh[k]
          if (e.t !== 'intent') continue
          const before = replay(all.slice(0, all.length - added + k))
          if (!before) continue
          const from = e.intent.block ?? before.leaf
          const step = stepOf(before as any, from)
          if (!step) continue
          const stub = (this.env as any).DECISION.get((this.env as any).DECISION.idFromName(`dec:${b.project}`))
          await stub.fetch('http://do/experience', { method: 'POST', headers: { 'x-sa-project': b.project }, body: JSON.stringify({
            session: b.session, block: from, agent: before.agent, scope: scopeOfUser(before.user), ...step, taken: takenOf(e.intent as any) }) })
            .catch((err: any) => console.warn(`[session] experience for ${b.session}/${from} not recorded: ${err?.message ?? err}`))
        }
      }
      const v = replay(all)
      return json({ upto: this.count(), added, summary: v ? { user: v.user, agent: v.agent, blocks: v.blocks.length, answers: v.answers.length, created: v.created, updated: v.updated, title: titleOf(v) } : null })
    }
    if (request.method === 'GET' && url.pathname === '/view') {
      const v = replay(this.entries(), url.searchParams.get('asOf') ?? undefined)
      return v ? json({ view: v, upto: this.count() }) : json({ error: 'there is no such session' }, 404)
    }
    if (request.method === 'GET' && url.pathname === '/upto') return json({ upto: this.count() })
    // ── Artifacts: what the session's work produced and decided — every version kept ──
    if (request.method === 'POST' && url.pathname === '/artifact') {
      const b = await request.json() as any
      if (!b?.by || !b?.kind || !b?.title || !b?.status || !b?.body || typeof b.body !== 'object') return json({ error: 'an artifact names its kind, title, status, body and who' }, 400)
      const prev = b.id ? [...this.ctx.storage.sql.exec('SELECT * FROM artifacts WHERE id = ? ORDER BY version DESC LIMIT 1', String(b.id))][0] as any : null
      if (b.id && !prev) return json({ error: `there is no artifact ${b.id}` }, 404)
      const id = prev ? String(prev.id) : `art_${crypto.randomUUID()}`
      const version = prev ? Number(prev.version) + 1 : 1
      const at = new Date().toISOString()
      const row = { id, version, kind: prev ? String(prev.kind) : String(b.kind), title: String(b.title), status: String(b.status), block: b.block ?? prev?.block ?? null, body: b.body, by: String(b.by), at, note: b.note ?? null }
      this.ctx.storage.sql.exec('INSERT INTO artifacts (id, version, kind, title, status, block, body, by, at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', row.id, row.version, row.kind, row.title, row.status, row.block, JSON.stringify(row.body), row.by, row.at, row.note)
      const meta = [...this.ctx.storage.sql.exec('SELECT session, project FROM meta')][0] as any
      if (meta) createRecorder((this.env as any).RECORDS, () => String(meta.project))('session.artifact', `${meta.session}:${id}:${version}`, { session: meta.session, ...row }, at)
      return json({ artifact: row })
    }
    if (request.method === 'GET' && url.pathname === '/artifacts') {
      const rows = [...this.ctx.storage.sql.exec(`SELECT a.* FROM artifacts a JOIN (SELECT id, MAX(version) AS m FROM artifacts GROUP BY id) x ON x.id = a.id AND x.m = a.version ORDER BY a.at`)] as any[]
      return json({ artifacts: rows.map((r) => ({ ...r, body: JSON.parse(r.body) })) })
    }
    if (request.method === 'GET' && url.pathname.startsWith('/artifact/')) {
      const rows = [...this.ctx.storage.sql.exec('SELECT * FROM artifacts WHERE id = ? ORDER BY version', decodeURIComponent(url.pathname.slice('/artifact/'.length)))] as any[]
      return rows.length ? json({ versions: rows.map((r) => ({ ...r, body: JSON.parse(r.body) })) }) : json({ error: 'there is no such artifact' }, 404)
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
