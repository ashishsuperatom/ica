// SEMANTIC ATOMS (System A) — small typed knowledge units on the same node-store as the model.
//
// Shape: LEFT = a SUBJECT (an entity NAME — one simple word or short phrase, the index key). RIGHT = the
// definition (where it lives / how to compute / how to join / how to resolve / how RELIABLE a path is). We
// store a HASH of the definition beside the name, so (a) a re-emission that DIFFERS is detected as a
// contradiction and VERSIONED — the old atom is archived (retired, timestamped) and the new one becomes live,
// linked back — never silently overwritten; and (b) other things (a program, an analysis) can later reference
// the exact atom they used by (name, hash). Latest always points forward; the old version still exists.
//
// Atoms are usage-LEARNED, not invented cold: the modeler crystallizes them from the analyst's real traces,
// and the analyst writes a data-quality atom the moment it finds one (the feedback loop). One node kind
// ('atom'); the specific kind is props.atomKind. Lives in project.sqlite with the model.

import { createHash } from 'node:crypto'
import type { NodeStore, Node } from './store.js'

export type AtomKind =
  | 'where-to-find'      // the SUBJECT lives at this table/column/source/path
  | 'how-to-compute'     // the method (SQL/expression) to derive it
  | 'how-to-join'        // the join/relationship to reach it
  | 'resolution-method'  // how a human reference for it becomes a concrete id
  | 'data-quality'       // how reliable a path is (coverage/caveat) — prefer/avoid guidance

export interface AtomProps {
  atomKind: AtomKind
  subject: string           // the entity NAME this is about — one simple word/phrase (the index key)
  location?: string         // where it lives — table.column / source / path
  method?: string           // how — a SQL snippet, join predicate, or short description
  coverage?: number         // 0..1 populated/applicable fraction (the data-quality signal)
  confidence?: number       // 0..1 how sure we are
  evidence?: string         // what was VERIFIED against real data (counts, a sample, a join check)
  provenance?: string       // who/what produced it (a modeler batch id, an analyst qid) — NOT part of the hash
  note?: string             // free-form human aside
  source?: string           // which data source, for cross-source projects
  hash?: string             // content hash of the definition (set by putAtom) — identity for change + linking
}

export interface AtomInput extends AtomProps {
  id?: string               // override the derived id (rare)
  summary?: string          // the one-line human statement (falls back to note)
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

/** Deterministic id for a fact SLOT — simply (entity name, kind), e.g. `atom:broker:data-quality`. The index
 *  is the entity NAME (a simple word/phrase); one entity carries at most one atom PER kind. A changed
 *  location/method/coverage for that slot is a CONTRADICTION → it gets versioned (old archived, new live),
 *  not a new key. */
export function atomId(subject: string, atomKind: AtomKind): string {
  return `atom:${slug(subject)}:${atomKind}`
}

/** Hash of the DEFINITION (the right-hand side) — everything definitional, excluding provenance/timestamps.
 *  Stable across key order. This is the atom's content identity: a changed hash == a contradiction to version. */
export function atomContentHash(a: AtomProps): string {
  const def = { atomKind: a.atomKind, subject: a.subject, location: a.location ?? null, method: a.method ?? null,
    coverage: a.coverage ?? null, confidence: a.confidence ?? null, evidence: a.evidence ?? null,
    note: a.note ?? null, source: a.source ?? null }
  return createHash('sha1').update(JSON.stringify(def)).digest('hex').slice(0, 16)
}

/** Write an atom. If the slot already holds an atom with the SAME hash → no-op (identical knowledge). If the
 *  content DIFFERS (a contradiction from new exploration) → archive the current version (retired + timestamped,
 *  kept in history), then make the new one live, with a `supersedes` edge to the archived version. */
export function putAtom(store: NodeStore, a: AtomInput): Node {
  const id = a.id ?? atomId(a.subject, a.atomKind)
  const { id: _drop, summary, hash: _h, ...rest } = a
  const hash = atomContentHash(a)
  const existing = store.getNode(id)
  if (existing && existing.valid_to == null && (existing.props as AtomProps)?.hash === hash) {
    return existing   // identical definition already live — nothing to version
  }
  if (existing && existing.valid_to == null) {
    // CONTRADICTION / change → archive the current version under a version-stamped id, keeping its real window.
    const archId = `${id}#${existing.valid_from}-${(existing.props as AtomProps)?.hash ?? 'x'}`
    store.db.prepare(
      `INSERT OR REPLACE INTO nodes (id, kind, label, summary, props, file_path, valid_from, valid_to)
       VALUES (@id, 'atom', @label, @summary, @props, NULL, @vf, NULL)`
    ).run({ id: archId, label: existing.label, summary: existing.summary ?? null,
      props: JSON.stringify(existing.props ?? {}), vf: existing.valid_from })
    store.retire(archId)                                          // close its validity window at now()
    store.putNode({ id, kind: 'atom', label: `${a.subject} · ${a.atomKind}`, summary: summary ?? a.note, props: { ...rest, hash } })
    store.putEdge({ from: id, to: archId, type: 'supersedes' })   // latest → the version it replaced
    return store.getNode(id)!
  }
  return store.putNode({ id, kind: 'atom', label: `${a.subject} · ${a.atomKind}`, summary: summary ?? a.note, props: { ...rest, hash } })
}

/** Retire an atom (temporal invalidation — kept in history, hidden from reads). */
export function retireAtom(store: NodeStore, id: string): void { store.retire(id) }

export interface FindAtomsOpts { subject?: string; atomKind?: AtomKind; q?: string; limit?: number }

/** Find atoms: a free-text search (q) OR a filter by subject/kind. Live (non-retired) only. */
export function findAtoms(store: NodeStore, opts: FindAtomsOpts = {}): Node[] {
  const limit = opts.limit ?? 100
  let list: Node[] = opts.q ? (store.search(opts.q, { kind: 'atom', limit }) as Node[]) : store.listKind('atom')
  if (opts.subject) {
    const s = opts.subject.toLowerCase()
    list = list.filter((n) => String((n.props as AtomProps)?.subject ?? '').toLowerCase().includes(s) || n.label.toLowerCase().includes(s))
  }
  if (opts.atomKind) list = list.filter((n) => (n.props as AtomProps)?.atomKind === opts.atomKind)
  return list.slice(0, limit)
}

/** All LIVE atoms about a subject (entity name) — what the analyst reads before analysis. */
export function atomsFor(store: NodeStore, subject: string): Node[] {
  return findAtoms(store, { subject })
}

/** Every version of a fact slot — the live atom plus its archived (superseded) predecessors, newest first.
 *  This is the time-travel view: how the knowledge about this slot changed, and when. */
export function atomHistory(store: NodeStore, id: string): Node[] {
  const rows = store.db.prepare(
    `SELECT * FROM nodes WHERE kind='atom' AND (id = ? OR id LIKE ?) ORDER BY valid_from DESC`
  ).all(id, id + '#%') as any[]
  return rows.map((r) => store.getNode(r.id)!).filter(Boolean)
}
