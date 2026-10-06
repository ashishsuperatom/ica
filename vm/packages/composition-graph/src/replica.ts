// ── The graph as a replica — what is sent to the platform, and what rebuilds a graph from it ──────────────────────────
//
// Everything that ever happened to a graph is in three append-only records: its changes, its suggestions and their
// decisions — plus the content they point at, by hash. A batch carries some of each, from a cursor; applying batches
// in order to an empty graph rebuilds it exactly — the same names, owners and scopes now, the same history, the same
// answers as of any moment. Applying a record already there is harmless; one that differs is refused (a conflict),
// never overwritten.

import type { Store } from './store.js'

export interface Cursor { change: number; suggestion: number; decisionAt: number; /** Named versions (absent in a cursor from before them: 0). */ version?: number }
export interface ReplicaBatch {
  changes: Record<string, unknown>[]
  suggestions: Record<string, unknown>[]
  decisions: Record<string, unknown>[]
  /** Named versions (versions.ts). */
  versions?: Record<string, unknown>[]
  /** The content every record in the batch points at, by hash. */
  contents: Record<string, string>
  /** Where the next batch starts. */
  next: Cursor
}
export const START: Cursor = { change: 0, suggestion: 0, decisionAt: 0, version: 0 }

export class ReplicaConflict extends Error {}

/** The records after a cursor, at most `limit` of each kind, with the content they name. */
export function replicaSince(store: Store, from: Cursor, limit = 500): ReplicaBatch {
  const db = store.db
  const changes = db.prepare('SELECT id, at, name, kind, from_hash, to_hash, by, reason, evidence, scope, owner FROM change WHERE id > ? ORDER BY id LIMIT ?').all(from.change, limit) as Record<string, unknown>[]
  const suggestions = db.prepare('SELECT id, at, name, kind, body_hash, base_hash, scope, by, reason FROM suggestion WHERE id > ? ORDER BY id LIMIT ?').all(from.suggestion, limit) as Record<string, unknown>[]
  // Decisions are keyed by their suggestion, not made in that order: they go by time, from just before the cursor
  // (a resend is harmless), so none made in the same millisecond is skipped.
  const decisions = db.prepare('SELECT suggestion, at, by, verdict, reason FROM decision WHERE at >= ? ORDER BY at, suggestion LIMIT ?').all(from.decisionAt, limit) as Record<string, unknown>[]
  // A version is sent once the change it stands at is (or already was) on the other side.
  const sentUpTo = changes.length ? Number(changes[changes.length - 1].id) : from.change
  const versions = db.prepare('SELECT id, name, message, upto, at, by FROM version WHERE id > ? AND upto <= ? ORDER BY id LIMIT ?').all(from.version ?? 0, sentUpTo, limit) as Record<string, unknown>[]
  const hashes = new Set<string>()
  for (const c of changes) { if (c.to_hash) hashes.add(String(c.to_hash)); if (c.from_hash) hashes.add(String(c.from_hash)) }
  for (const s of suggestions) { hashes.add(String(s.body_hash)); if (s.base_hash) hashes.add(String(s.base_hash)) }
  const contents: Record<string, string> = {}
  for (const h of hashes) { const r = db.prepare('SELECT body FROM content WHERE hash = ?').get(h) as { body: string } | undefined; if (r) contents[h] = r.body }
  return {
    changes, suggestions, decisions, versions, contents,
    next: {
      version: versions.length ? Number(versions[versions.length - 1].id) : (from.version ?? 0),
      change: changes.length ? Number(changes[changes.length - 1].id) : from.change,
      suggestion: suggestions.length ? Number(suggestions[suggestions.length - 1].id) : from.suggestion,
      decisionAt: decisions.length ? Number(decisions[decisions.length - 1].at) : from.decisionAt,
    },
  }
}

/** Is there anything after this cursor? */
export function hasAfter(store: Store, c: Cursor): boolean {
  const b = replicaSince(store, c, 1)
  return b.changes.length > 0 || b.suggestions.length > 0 || (b.versions?.length ?? 0) > 0 || b.decisions.some((d) => Number(d.at) > c.decisionAt)
}

const same = (a: Record<string, unknown>, b: Record<string, unknown>) => Object.keys(b).every((k) => (a[k] ?? null) === (b[k] ?? null))

/** Apply a batch: every record kept as it was (ids and times included), then each touched name set from its last
 *  change. One unit: all of it, or none. */
export function applyReplica(store: Store, batch: Omit<ReplicaBatch, 'next'>): { added: number } {
  const db = store.db
  let added = 0
  db.atomic(() => {
    for (const [hash, body] of Object.entries(batch.contents)) db.prepare('INSERT OR IGNORE INTO content (hash, body, at) VALUES (?, ?, ?)').run(hash, body, Date.now())
    const touched = new Set<string>()
    for (const c of batch.changes) {
      const have = db.prepare('SELECT id, at, name, kind, from_hash, to_hash, by, reason, evidence, scope, owner FROM change WHERE id = ?').get(c.id as number) as Record<string, unknown> | undefined
      if (have) { if (!same(have, c)) throw new ReplicaConflict(`change ${c.id} differs from the one kept`); continue }
      db.prepare('INSERT INTO change (id, at, name, kind, from_hash, to_hash, by, reason, evidence, scope, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(c.id as number, c.at as number, c.name as string, c.kind as string, (c.from_hash ?? null) as string | null, (c.to_hash ?? null) as string | null, c.by as string, (c.reason ?? null) as string | null, (c.evidence ?? null) as string | null, (c.scope ?? null) as string | null, (c.owner ?? null) as string | null)
      touched.add(String(c.name)); added++
    }
    for (const s of batch.suggestions) {
      const have = db.prepare('SELECT id, at, name, kind, body_hash, base_hash, scope, by, reason FROM suggestion WHERE id = ?').get(s.id as number) as Record<string, unknown> | undefined
      if (have) { if (!same(have, s)) throw new ReplicaConflict(`suggestion ${s.id} differs from the one kept`); continue }
      db.prepare('INSERT INTO suggestion (id, at, name, kind, body_hash, base_hash, scope, by, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(s.id as number, s.at as number, s.name as string, s.kind as string, s.body_hash as string, (s.base_hash ?? null) as string | null, (s.scope ?? null) as string | null, s.by as string, s.reason as string)
      added++
    }
    for (const d of batch.decisions) {
      const have = db.prepare('SELECT suggestion, at, by, verdict, reason FROM decision WHERE suggestion = ?').get(d.suggestion as number) as Record<string, unknown> | undefined
      if (have) { if (!same(have, d)) throw new ReplicaConflict(`the decision on suggestion ${d.suggestion} differs from the one kept`); continue }
      db.prepare('INSERT INTO decision (suggestion, at, by, verdict, reason) VALUES (?, ?, ?, ?, ?)').run(d.suggestion as number, d.at as number, d.by as string, d.verdict as string, (d.reason ?? null) as string | null)
      added++
    }
    for (const v of batch.versions ?? []) {
      const have = db.prepare('SELECT id, name, message, upto, at, by FROM version WHERE id = ?').get(v.id as number) as Record<string, unknown> | undefined
      if (have) { if (!same(have, v)) throw new ReplicaConflict(`version ${v.id} differs from the one kept`); continue }
      db.prepare('INSERT INTO version (id, name, message, upto, at, by) VALUES (?, ?, ?, ?, ?, ?)').run(v.id as number, v.name as string, v.message as string, v.upto as number, v.at as number, v.by as string)
      added++
    }
    // The names now: each touched name as its last change left it.
    for (const name of touched) {
      const last = db.prepare('SELECT kind, to_hash, scope, owner FROM change WHERE name = ? ORDER BY at DESC, id DESC LIMIT 1').get(name) as { kind: string; to_hash: string | null; scope: string | null; owner: string | null }
      if (!last.to_hash) db.prepare('DELETE FROM name WHERE name = ?').run(name)
      else db.prepare('INSERT INTO name (name, kind, hash, scope, owner) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, hash = excluded.hash, scope = excluded.scope, owner = excluded.owner')
        .run(name, last.kind, last.to_hash, last.scope ?? 'global', last.owner)
    }
  })
  return { added }
}
