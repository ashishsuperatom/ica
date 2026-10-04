// ── DecisionDO — a project's decision memory ────────────────────────────────────────────────────────────────────────
//
// Every decision state of the project, collected in one place, because recognising a situation means searching all of
// them (vm/packages/decision has the rules; docs/platform-architecture.md "The decision system"). It keeps:
//
//   experiences  each passage through a step (from the session logs, as their intents arrive): cues, world, path taken
//   outcomes     how each turned out, when known (a decision recorded, approved, abandoned, reversed)
//   versions     every version of every decision state, written only by a named operation; read as of any moment
//   cue_index    the associative index over the current active versions (derived)
//
//   POST /experience  { session, block, agent, scope, cues, world, stateHash, taken }  → { id, recognised }
//   POST /recognise   { cues, world, scopes }                                            → Recognition (with path records)
//   POST /outcome     { experience | session+block, outcome, by, note?, artifact? }
//   POST /change      { op, by, why }                                                    → { written: [{ id, version }] }
//   GET  /states?asOf=&all=1      GET /state/<id>      GET /experiences?session=&limit=
//   GET|PUT /settings  (the thresholds of "learned")

import { DurableObject } from 'cloudflare:workers'
import { migrate as runMigrations, durableObjectDb } from '../../../vm/packages/migrate/src/index.js'
import { DECISION_MIGRATIONS } from './migrations.js'
import { createRecorder } from './records.js'
import { recognise, plan, samePath, isScope, DecisionRefusal, DEFAULT_RECOGNITION, type Candidate, type DecisionOp, type DecisionVersion, type Experience, type PathRecord, type RecognitionSettings, type Taken, type World } from '../../../vm/packages/decision/src/index.js'

const OUTCOMES = ['succeeded', 'failed', 'abandoned', 'reversed']

export class DecisionDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(async () => { runMigrations(durableObjectDb(this.ctx.storage), DECISION_MIGRATIONS, { name: 'decision' }) })
  }
  private sql = (q: string, ...p: unknown[]) => [...this.ctx.storage.sql.exec(q, ...p)] as any[]
  private project = '' 
  private record = createRecorder((this.env as any).RECORDS, () => this.project)

  private settings(): RecognitionSettings {
    const out: any = { ...DEFAULT_RECOGNITION }
    for (const r of this.sql('SELECT key, value FROM settings')) if (r.key in out && Number.isFinite(Number(r.value))) out[r.key] = Number(r.value)
    return out
  }

  /** Each state's latest version as of a moment (now when left out). */
  private current(asOf?: string): Map<string, DecisionVersion> {
    const rows = this.sql(`SELECT v.* FROM versions v JOIN (SELECT id, MAX(version) AS m FROM versions ${asOf ? 'WHERE at <= ?' : ''} GROUP BY id) x ON x.id = v.id AND x.m = v.version`, ...(asOf ? [asOf] : []))
    return new Map(rows.map((r) => [r.id, this.version(r)]))
  }
  private version = (r: any): DecisionVersion => ({ id: r.id, version: r.version, at: r.at, by: r.by, why: r.why, op: r.op, scope: r.scope, status: r.status, body: JSON.parse(r.body), supports: JSON.parse(r.supports), contradicts: JSON.parse(r.contradicts) })

  /** What a state's record says: its evidence, and for each path how often it was taken from it and how that went. */
  private recordOf(id: string, v: DecisionVersion): Candidate {
    const all = this.sql('SELECT supports, contradicts FROM versions WHERE id = ?', id)
    const supports = new Set<string>(), contradicts = new Set<string>()
    for (const r of all) { JSON.parse(r.supports).forEach((x: string) => supports.add(x)); JSON.parse(r.contradicts).forEach((x: string) => contradicts.add(x)) }
    const paths: Record<string, PathRecord> = {}
    const taken = this.sql(`SELECT e.taken, (SELECT outcome FROM outcomes o WHERE o.experience = e.id ORDER BY seq DESC LIMIT 1) AS outcome FROM experiences e WHERE e.recognised = ? AND e.taken IS NOT NULL ORDER BY e.at DESC LIMIT 1000`, id)
    for (const r of taken) {
      const t = JSON.parse(r.taken) as Taken
      const p = v.body.paths.find((x) => samePath(t, x))
      if (!p) continue
      const rec = (paths[p.id] ??= { taken: 0, succeeded: 0, failed: 0 })
      rec.taken++
      if (r.outcome === 'succeeded') rec.succeeded++
      else if (r.outcome === 'failed' || r.outcome === 'reversed') rec.failed++
    }
    return { id, scope: v.scope, body: v.body, supports: supports.size, contradicts: contradicts.size, paths }
  }

  private recogniseNow(cues: string[], world: World, scopes: string[]) {
    const visible = (s: string) => s === 'global' || scopes.includes(s)
    const ids = cues.length ? [...new Set(this.sql(`SELECT id FROM cue_index WHERE cue IN (${cues.map(() => '?').join(',')})`, ...cues).map((r) => String(r.id)))] : []
    const cur = this.current()
    const candidates = ids.map((id) => cur.get(id)).filter((v): v is DecisionVersion => !!v && v.status === 'active' && visible(v.scope)).map((v) => this.recordOf(v.id, v))
    const df: Record<string, number> = {}
    for (const r of cues.length ? this.sql(`SELECT cue, COUNT(*) AS n FROM cue_index WHERE cue IN (${cues.map(() => '?').join(',')}) GROUP BY cue`, ...cues) : []) df[r.cue] = Number(r.n)
    const n = Number(this.sql('SELECT COUNT(DISTINCT id) AS n FROM cue_index')[0]?.n ?? 0)
    return recognise(cues, world, candidates, df, n, this.settings())
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const j = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
    this.project = request.headers.get('x-sa-project') ?? this.project
    if (this.project && !this.sql('SELECT 1 FROM meta').length) this.ctx.storage.sql.exec('INSERT INTO meta (project) VALUES (?)', this.project)
    const body: any = request.method === 'GET' ? {} : await request.json().catch(() => ({}))
    const strs = (v: unknown) => Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x: string) => x.trim().toLowerCase()).slice(0, 80) : []
    const nums = (v: unknown): World => Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).filter(([, x]) => typeof x === 'number' && Number.isFinite(x)).slice(0, 80)) as World
    try {
      if (request.method === 'POST' && url.pathname === '/experience') {
        if (!body.session || !body.block || !body.agent || !isScope(body.scope)) return j({ error: 'an experience names its session, block, agent and scope' }, 400)
        const cues = strs(body.cues), world = nums(body.world)
        const r = this.recogniseNow(cues, world, [body.scope, ...strs(body.scopes)])
        const recognised = r.mode === 'not-learned' ? null : r.matches[0]?.id ?? null
        const e: Experience = { id: `exp_${crypto.randomUUID()}`, at: new Date().toISOString(), session: String(body.session), block: String(body.block), agent: String(body.agent), scope: body.scope, cues, world, stateHash: String(body.stateHash ?? ''), taken: body.taken ?? null, recognised }
        this.ctx.storage.sql.exec('INSERT INTO experiences (id, at, session, block, agent, scope, cues, world, state_hash, taken, recognised) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          e.id, e.at, e.session, e.block, e.agent, e.scope, JSON.stringify(e.cues), JSON.stringify(e.world), e.stateHash, e.taken ? JSON.stringify(e.taken) : null, recognised)
        this.record('decision.experience', e.id, e, e.at)
        return j({ id: e.id, recognised, mode: r.mode })
      }
      if (request.method === 'POST' && url.pathname === '/recognise') return j(this.recogniseNow(strs(body.cues), nums(body.world), strs(body.scopes)))
      if (request.method === 'POST' && url.pathname === '/outcome') {
        if (!OUTCOMES.includes(body.outcome) || !body.by) return j({ error: `an outcome is one of ${OUTCOMES.join(', ')}, and says who` }, 400)
        const ids: string[] = body.experience ? [String(body.experience)] : this.sql('SELECT id FROM experiences WHERE session = ? AND block = ?', String(body.session ?? ''), String(body.block ?? '')).map((r) => String(r.id))
        if (!ids.length || !this.sql(`SELECT 1 FROM experiences WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).length) return j({ error: 'there is no such experience' }, 404)
        const at = new Date().toISOString()
        for (const id of ids) {
          this.ctx.storage.sql.exec('INSERT INTO outcomes (experience, at, outcome, by, note, artifact) VALUES (?, ?, ?, ?, ?, ?)', id, at, body.outcome, String(body.by), body.note ?? null, body.artifact ?? null)
          this.record('decision.outcome', `${id}:${at}`, { experience: id, outcome: body.outcome, by: body.by, note: body.note ?? null, artifact: body.artifact ?? null }, at)
        }
        return j({ ok: true, experiences: ids })
      }
      if (request.method === 'POST' && url.pathname === '/change') {
        if (!body.by || !body.why) return j({ error: 'a change to the decision memory says who and why' }, 400)
        const op = body.op as DecisionOp
        const cur = this.current()
        const worldOf = (id: string) => { const r = this.sql('SELECT world FROM experiences WHERE id = ?', id)[0]; return r ? JSON.parse(r.world) : null }
        const writes = plan(op, (id) => cur.get(id) ?? null, worldOf)
        const at = new Date().toISOString()
        const written: { id: string; version: number }[] = []
        this.ctx.storage.transactionSync(() => {
          for (const w of writes) {
            const version = (cur.get(w.id)?.version ?? 0) + 1
            this.ctx.storage.sql.exec('INSERT INTO versions (id, version, at, by, why, op, scope, status, body, supports, contradicts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              w.id, version, at, String(body.by), String(body.why), op.op, w.scope, w.status, JSON.stringify(w.body), JSON.stringify(w.supports), JSON.stringify(w.contradicts))
            this.ctx.storage.sql.exec('DELETE FROM cue_index WHERE id = ?', w.id)
            if (w.status === 'active') for (const c of new Set(w.body.cues.map((x) => x.trim().toLowerCase()))) this.ctx.storage.sql.exec('INSERT OR IGNORE INTO cue_index (cue, id) VALUES (?, ?)', c, w.id)
            written.push({ id: w.id, version })
            this.record('decision.version', `${w.id}:${version}`, { ...w, version, at, by: body.by, why: body.why, op: op.op }, at)
          }
        })
        return j({ written })
      }
      if (request.method === 'GET' && url.pathname === '/states') {
        const asOf = url.searchParams.get('asOf') ?? undefined
        const states = [...this.current(asOf).values()].filter((v) => url.searchParams.get('all') === '1' || v.status === 'active').map((v) => ({ ...v, record: this.recordOf(v.id, v) }))
        return j({ asOf: asOf ?? null, states })
      }
      if (request.method === 'GET' && url.pathname.startsWith('/state/')) {
        const id = decodeURIComponent(url.pathname.slice('/state/'.length))
        const versions = this.sql('SELECT * FROM versions WHERE id = ? ORDER BY version', id).map(this.version)
        if (!versions.length) return j({ error: `there is no decision state ${id}` }, 404)
        const last = versions[versions.length - 1]
        return j({ state: { ...last, record: this.recordOf(id, last) }, versions })
      }
      if (request.method === 'GET' && url.pathname === '/experiences') {
        const s = url.searchParams.get('session'), limit = Math.min(500, Number(url.searchParams.get('limit')) || 100)
        const rows = s ? this.sql('SELECT * FROM experiences WHERE session = ? ORDER BY at DESC LIMIT ?', s, limit) : this.sql('SELECT * FROM experiences ORDER BY at DESC LIMIT ?', limit)
        return j({ experiences: rows.map((r) => ({ ...r, cues: JSON.parse(r.cues), world: JSON.parse(r.world), taken: r.taken ? JSON.parse(r.taken) : null,
          outcomes: this.sql('SELECT outcome, at, by, note, artifact FROM outcomes WHERE experience = ? ORDER BY seq', r.id) })) })
      }
      if (url.pathname === '/settings') {
        if (request.method === 'PUT') {
          const at = new Date().toISOString()
          for (const [k, v] of Object.entries(body.settings ?? {})) if (k in DEFAULT_RECOGNITION && Number.isFinite(Number(v))) this.ctx.storage.sql.exec('INSERT INTO settings (key, value, by, at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, by = excluded.by, at = excluded.at', k, String(v), String(body.by ?? 'admin'), at)
        }
        return j({ settings: this.settings(), defaults: DEFAULT_RECOGNITION })
      }
      return j({ error: 'not found' }, 404)
    } catch (e: any) {
      if (e instanceof DecisionRefusal) return j({ error: e.message, problems: e.problems }, 400)
      throw e
    }
  }
}
