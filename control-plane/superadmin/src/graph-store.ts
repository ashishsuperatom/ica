// ── The composition graph, as the platform keeps it — in the project's own Durable Object ───────────────────────────
//
// The graph's append-only records — its changes, suggestions, decisions and named versions — and the content they point
// at, as the engine replicates them (vm/packages/composition-graph/src/replica.ts). The platform's copy is the record
// that outlives any engine: an engine whose graph is empty is rebuilt from it. A record already here is harmless to send
// again; one that differs is a conflict, refused. Where the copy ends (its cursor) is read from what is kept, so an
// engine pushes from there and keeps no notes of its own. Tables: graph_records, graph_content (ProjectDO migration 32).

import { createRecorder } from './records.js'

type Row = Record<string, unknown>
const KEY: Record<string, (r: Row) => string> = { change: (r) => String(r.id), suggestion: (r) => String(r.id), decision: (r) => String(r.suggestion), version: (r) => String(r.id) }
const same = (a: Row, b: Row) => { const k = new Set([...Object.keys(a), ...Object.keys(b)]); return [...k].every((x) => (a[x] ?? null) === (b[x] ?? null)) }

export interface GraphBatch { changes?: Row[]; suggestions?: Row[]; decisions?: Row[]; versions?: Row[]; contents?: Record<string, string> }
export interface GraphCursor { change: number; suggestion: number; decisionAt: number; version: number }
export class GraphConflict extends Error {}
export class GraphRefused extends Error {}

export function graphStore(storage: DurableObjectStorage, env: unknown, project: () => string) {
  const sql = storage.sql
  const cursor = (): GraphCursor => {
    const one = (q: string) => Number([...sql.exec(q)][0]?.v ?? 0)
    return {
      change: one("SELECT MAX(CAST(key AS INTEGER)) AS v FROM graph_records WHERE kind = 'change'"),
      suggestion: one("SELECT MAX(CAST(key AS INTEGER)) AS v FROM graph_records WHERE kind = 'suggestion'"),
      decisionAt: one("SELECT MAX(at) AS v FROM graph_records WHERE kind = 'decision'"),
      version: one("SELECT MAX(CAST(key AS INTEGER)) AS v FROM graph_records WHERE kind = 'version'"),
    }
  }
  return {
    cursor,
    /** Keep a batch: each record once (the same again is harmless, a different one a conflict), all or nothing. */
    append(b: GraphBatch): { added: number; cursor: GraphCursor } {
      const record = createRecorder((env as any).RECORDS, project)
      let added = 0
      storage.transactionSync(() => {
        for (const [hash, body] of Object.entries(b.contents ?? {})) {
          if (!/^[0-9a-f]{64}$/.test(hash) || typeof body !== 'string') throw new GraphRefused('a content is named by its hash')
          sql.exec('INSERT OR IGNORE INTO graph_content (hash, body) VALUES (?, ?)', hash, body)
        }
        for (const [kind, rows] of [['change', b.changes ?? []], ['suggestion', b.suggestions ?? []], ['decision', b.decisions ?? []], ['version', b.versions ?? []]] as const) {
          for (const r of rows) {
            const key = KEY[kind](r)
            if (!/^\d+$/.test(key)) throw new GraphRefused(`a ${kind} has a number`)
            const [have] = [...sql.exec('SELECT body FROM graph_records WHERE kind = ? AND key = ?', kind, key)]
            if (have) { if (!same(JSON.parse(String(have.body)), r)) throw new GraphConflict(`${kind} ${key} differs from the one kept`); continue }
            sql.exec('INSERT INTO graph_records (kind, key, at, body) VALUES (?, ?, ?, ?)', kind, key, Number(r.at ?? 0), JSON.stringify(r))
            record(`graph.${kind}`, key, { ...r, ...(kind !== 'decision' && (r as any).to_hash && b.contents?.[(r as any).to_hash as string] ? { content: JSON.parse(b.contents[(r as any).to_hash as string]) } : {}) }, new Date(Number(r.at ?? 0) || Date.now()).toISOString())
            added++
          }
        }
      })
      return { added, cursor: cursor() }
    },
    /** What awaits a decision: suggestions no decision has answered yet (to change a node, or to publish one). */
    open() {
      const decided = new Set([...sql.exec("SELECT key FROM graph_records WHERE kind = 'decision'")].map((r) => String(r.key)))
      return [...sql.exec("SELECT key, body FROM graph_records WHERE kind = 'suggestion' ORDER BY CAST(key AS INTEGER) DESC LIMIT 200")]
        .filter((r) => !decided.has(String(r.key))).map((r) => { const b = JSON.parse(String(r.body)); return { id: b.id, at: b.at, name: b.name, kind: b.kind, by: b.by, reason: b.reason, scope: b.scope ?? null } })
    },
    /** A batch in the replica's own shape, after a cursor — for rebuilding an engine's graph. */
    pull(after: Partial<GraphCursor>, limit = 200) {
      limit = Math.min(limit, 1000)
      const rows = (kind: string, from: number, by: 'key' | 'at') => [...sql.exec(`SELECT body FROM graph_records WHERE kind = ? AND ${by === 'key' ? 'CAST(key AS INTEGER) > ?' : 'at >= ?'} ORDER BY ${by === 'key' ? 'CAST(key AS INTEGER)' : 'at, CAST(key AS INTEGER)'} LIMIT ?`, kind, from, limit)].map((r) => JSON.parse(String(r.body)) as Row)
      const c = { change: Number(after.change) || 0, suggestion: Number(after.suggestion) || 0, decisionAt: Number(after.decisionAt) || 0, version: Number(after.version) || 0 }
      const changes = rows('change', c.change, 'key'), suggestions = rows('suggestion', c.suggestion, 'key'), decisions = rows('decision', c.decisionAt, 'at'), versions = rows('version', c.version, 'key')
      const hashes = new Set<string>()
      for (const x of changes) { if (x.to_hash) hashes.add(String(x.to_hash)); if (x.from_hash) hashes.add(String(x.from_hash)) }
      for (const x of suggestions) { hashes.add(String(x.body_hash)); if (x.base_hash) hashes.add(String(x.base_hash)) }
      const contents: Record<string, string> = {}
      for (const h of hashes) { const [r] = [...sql.exec('SELECT body FROM graph_content WHERE hash = ?', h)]; if (r) contents[h] = String(r.body) }
      return { changes, suggestions, decisions, versions, contents, next: {
        version: versions.length ? Number(versions[versions.length - 1].id) : c.version,
        change: changes.length ? Number(changes[changes.length - 1].id) : c.change,
        suggestion: suggestions.length ? Number(suggestions[suggestions.length - 1].id) : c.suggestion,
        decisionAt: decisions.length ? Number(decisions[decisions.length - 1].at) : c.decisionAt,
      } }
    },
  }
}
