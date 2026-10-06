// ── GraphDO — a project's composition graph, kept by the platform ───────────────────────────────────────────────────
//
// The graph's own append-only records — its changes, suggestions and decisions — and the content they point at, as the
// engine replicates them (vm/packages/composition-graph/src/replica.ts). The platform's copy is the record that
// outlives any engine: an engine whose graph is empty is rebuilt from it. A record already here is harmless to send
// again; one that differs is a conflict, refused. Where the copy ends (its cursor) is read from what is kept, so an
// engine pushes from there and keeps no notes of its own.

import { DurableObject } from 'cloudflare:workers'
import { migrate as runMigrations, durableObjectDb } from '../../../vm/packages/migrate/src/index.js'
import { GRAPH_MIGRATIONS } from './migrations.js'
import { createRecorder } from './records.js'

type Row = Record<string, unknown>
const KEY: Record<string, (r: Row) => string> = { change: (r) => String(r.id), suggestion: (r) => String(r.id), decision: (r) => String(r.suggestion), version: (r) => String(r.id) }
const same = (a: Row, b: Row) => { const k = new Set([...Object.keys(a), ...Object.keys(b)]); return [...k].every((x) => (a[x] ?? null) === (b[x] ?? null)) }

export class GraphDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(async () => { runMigrations(durableObjectDb(this.ctx.storage), GRAPH_MIGRATIONS, { name: 'graph' }) })
  }

  private cursor() {
    const one = (q: string) => Number([...this.ctx.storage.sql.exec(q)][0]?.v ?? 0)
    return {
      change: one("SELECT MAX(CAST(key AS INTEGER)) AS v FROM records WHERE kind = 'change'"),
      suggestion: one("SELECT MAX(CAST(key AS INTEGER)) AS v FROM records WHERE kind = 'suggestion'"),
      decisionAt: one("SELECT MAX(at) AS v FROM records WHERE kind = 'decision'"),
      version: one("SELECT MAX(CAST(key AS INTEGER)) AS v FROM records WHERE kind = 'version'"),
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
    const sql = this.ctx.storage.sql
    if (request.method === 'GET' && url.pathname === '/cursor') return json({ cursor: this.cursor() })
    if (request.method === 'POST' && url.pathname === '/append') {
      const b = await request.json() as { project?: string; changes?: Row[]; suggestions?: Row[]; decisions?: Row[]; versions?: Row[]; contents?: Record<string, string> }
      const record = createRecorder((this.env as any).RECORDS, () => String(b.project ?? ''))
      let added = 0
      try {
        this.ctx.storage.transactionSync(() => {
          for (const [hash, body] of Object.entries(b.contents ?? {})) {
            if (!/^[0-9a-f]{64}$/.test(hash) || typeof body !== 'string') throw new Refused('a content is named by its hash')
            sql.exec('INSERT OR IGNORE INTO content (hash, body) VALUES (?, ?)', hash, body)
          }
          for (const [kind, rows] of [['change', b.changes ?? []], ['suggestion', b.suggestions ?? []], ['decision', b.decisions ?? []], ['version', b.versions ?? []]] as const) {
            for (const r of rows) {
              const key = KEY[kind](r)
              if (!/^\d+$/.test(key)) throw new Refused(`a ${kind} has a number`)
              const [have] = [...sql.exec('SELECT body FROM records WHERE kind = ? AND key = ?', kind, key)]
              if (have) { if (!same(JSON.parse(String(have.body)), r)) throw new Conflict(`${kind} ${key} differs from the one kept`); continue }
              sql.exec('INSERT INTO records (kind, key, at, body) VALUES (?, ?, ?, ?)', kind, key, Number(r.at ?? 0), JSON.stringify(r))
              record(`graph.${kind}`, key, { ...r, ...(kind !== 'decision' && (r as any).to_hash && b.contents?.[(r as any).to_hash as string] ? { content: JSON.parse(b.contents[(r as any).to_hash as string]) } : {}) }, new Date(Number(r.at ?? 0) || Date.now()).toISOString())
              added++
            }
          }
        })
      } catch (e) {
        if (e instanceof Conflict) return json({ error: e.message, conflict: true, cursor: this.cursor() }, 409)
        if (e instanceof Refused) return json({ error: e.message }, 400)
        throw e
      }
      return json({ added, cursor: this.cursor() })
    }
    // What awaits a decision: suggestions no decision has answered yet (to change a node, or to publish one).
    if (request.method === 'GET' && url.pathname === '/open') {
      const decided = new Set([...sql.exec("SELECT key FROM records WHERE kind = 'decision'")].map((r) => String(r.key)))
      const open = [...sql.exec("SELECT key, body FROM records WHERE kind = 'suggestion' ORDER BY CAST(key AS INTEGER) DESC LIMIT 200")]
        .filter((r) => !decided.has(String(r.key))).map((r) => { const b = JSON.parse(String(r.body)); return { id: b.id, at: b.at, name: b.name, kind: b.kind, by: b.by, reason: b.reason, scope: b.scope ?? null } })
      return json({ open })
    }
    if (request.method === 'GET' && url.pathname === '/pull') {
      // A batch in the replica's own shape, after a cursor — for rebuilding an engine's graph.
      const q = url.searchParams, limit = Math.min(Number(q.get('limit')) || 200, 1000)
      const rows = (kind: string, after: number, by: 'key' | 'at') => [...sql.exec(`SELECT body FROM records WHERE kind = ? AND ${by === 'key' ? 'CAST(key AS INTEGER) > ?' : 'at >= ?'} ORDER BY ${by === 'key' ? 'CAST(key AS INTEGER)' : 'at, CAST(key AS INTEGER)'} LIMIT ?`, kind, after, limit)].map((r) => JSON.parse(String(r.body)) as Row)
      const changes = rows('change', Number(q.get('change') ?? 0), 'key')
      const suggestions = rows('suggestion', Number(q.get('suggestion') ?? 0), 'key')
      const decisions = rows('decision', Number(q.get('decisionAt') ?? 0), 'at')
      const versions = rows('version', Number(q.get('version') ?? 0), 'key')
      const hashes = new Set<string>()
      for (const c of changes) { if (c.to_hash) hashes.add(String(c.to_hash)); if (c.from_hash) hashes.add(String(c.from_hash)) }
      for (const s of suggestions) { hashes.add(String(s.body_hash)); if (s.base_hash) hashes.add(String(s.base_hash)) }
      const contents: Record<string, string> = {}
      for (const h of hashes) { const [r] = [...sql.exec('SELECT body FROM content WHERE hash = ?', h)]; if (r) contents[h] = String(r.body) }
      return json({ changes, suggestions, decisions, versions, contents, next: {
        version: versions.length ? Number(versions[versions.length - 1].id) : Number(q.get('version') ?? 0),
        change: changes.length ? Number(changes[changes.length - 1].id) : Number(q.get('change') ?? 0),
        suggestion: suggestions.length ? Number(suggestions[suggestions.length - 1].id) : Number(q.get('suggestion') ?? 0),
        decisionAt: decisions.length ? Number(decisions[decisions.length - 1].at) : Number(q.get('decisionAt') ?? 0),
      } })
    }
    return json({ error: 'not found' }, 404)
  }
}

class Conflict extends Error {}
class Refused extends Error {}
