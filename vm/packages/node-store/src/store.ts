import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA } from './schema.js'

export type Node = {
  id: string
  kind: string
  label: string
  summary?: string
  props?: Record<string, unknown>
  file_path?: string
  valid_from?: number          // bitemporal window (ms) — set by the store; read-only to callers
  valid_to?: number | null     // null = currently live; a number = superseded/retired at that time
}

export type Edge = {
  from: string
  to: string
  type: string
  props?: Record<string, unknown>
}

export type SearchHit = Node & { score: number }

const now = () => Date.now()

function rowToNode(r: any): Node {
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    summary: r.summary ?? undefined,
    props: r.props ? JSON.parse(r.props) : {},
    file_path: r.file_path ?? undefined,
    valid_from: r.valid_from ?? undefined,
    valid_to: r.valid_to ?? null,
  }
}

// Escape an FTS5 query: wrap each token as a quoted phrase so user/agent text
// can't trip the FTS syntax (e.g. "dead-stock" or a stray quote).
function ftsQuery(q: string): string {
  const tokens = q.match(/[\p{L}\p{N}]+/gu) ?? []
  if (!tokens.length) return '""'
  return tokens.map(t => `"${t}"*`).join(' OR ')
}

export class NodeStore {
  readonly db: Database.Database

  constructor(path = ':memory:') {
    // A store owns its file: create the parent dir first (better-sqlite3 won't, and on a fresh machine
    // the per-project dir doesn't exist yet). ':memory:' has no dir.
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    // project.sqlite is shared by the engine (intent nodes) AND the modeller subprocess (concept nodes).
    // WAL lets them read concurrently; busy_timeout makes a write WAIT for the lock instead of throwing
    // SQLITE_BUSY when both write at once.
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(SCHEMA)
  }

  close() { this.db.close() }

  // --- writes -------------------------------------------------------------

  /** Insert or replace a node (id is the identity key). Bumps validity window. */
  putNode(n: Node): Node {
    this.db.prepare(`
      INSERT INTO nodes (id, kind, label, summary, props, file_path, valid_from, valid_to)
      VALUES (@id, @kind, @label, @summary, @props, @file_path, @valid_from, NULL)
      ON CONFLICT(id) DO UPDATE SET
        kind=excluded.kind, label=excluded.label, summary=excluded.summary,
        props=excluded.props, file_path=excluded.file_path, valid_to=NULL
    `).run({
      id: n.id, kind: n.kind, label: n.label,
      summary: n.summary ?? null,
      props: JSON.stringify(n.props ?? {}),
      file_path: n.file_path ?? null,
      valid_from: now(),
    })
    return n
  }

  putEdge(e: Edge): void {
    this.db.prepare(`
      INSERT INTO edges (from_id, to_id, type, props)
      VALUES (@from, @to, @type, @props)
      ON CONFLICT(from_id, to_id, type) DO UPDATE SET props=excluded.props
    `).run({ from: e.from, to: e.to, type: e.type, props: JSON.stringify(e.props ?? {}) })
  }

  /** Soft-supersede: mark a node no longer current (bitemporal). Kept for time-travel. */
  retire(id: string): void {
    this.db.prepare(`UPDATE nodes SET valid_to=? WHERE id=? AND valid_to IS NULL`).run(now(), id)
  }

  // --- reads --------------------------------------------------------------

  getNode(id: string): Node | undefined {
    const r = this.db.prepare(`SELECT * FROM nodes WHERE id=?`).get(id)
    return r ? rowToNode(r) : undefined
  }

  /** All live nodes of a kind. For enumerating small sets (the program catalog, concepts) — NOT a search. */
  nodesByKind(kind: string, limit = 1000): Node[] {
    const rows = this.db.prepare(`SELECT * FROM nodes WHERE kind=? AND valid_to IS NULL LIMIT ?`).all(kind, limit) as any[]
    return rows.map(rowToNode)
  }

  /** Lexical search ranked by FTS5 bm25. Optionally constrain by kind / liveness. */
  search(query: string, opts: { kind?: string; limit?: number; includeRetired?: boolean } = {}): SearchHit[] {
    const limit = opts.limit ?? 20
    const bind: Record<string, unknown> = { q: ftsQuery(query), limit }
    if (opts.kind) bind.kind = opts.kind
    const rows = this.db.prepare(`
      SELECT n.*, bm25(nodes_fts) AS rank
      FROM nodes_fts
      JOIN nodes n ON n.rowid = nodes_fts.rowid
      WHERE nodes_fts MATCH @q
        ${opts.kind ? 'AND n.kind = @kind' : ''}
        ${opts.includeRetired ? '' : 'AND n.valid_to IS NULL'}
      ORDER BY rank
      LIMIT @limit
    `).all(bind) as any[]
    // bm25 is lower=better; expose a positive score for callers.
    return rows.map(r => ({ ...rowToNode(r), score: -r.rank }))
  }

  /** Immediate neighbors along an edge type, in a direction. */
  neighbors(id: string, opts: { type?: string; direction?: 'out' | 'in' } = {}): Node[] {
    const dir = opts.direction ?? 'out'
    const [self, other] = dir === 'out' ? ['from_id', 'to_id'] : ['to_id', 'from_id']
    const bind: Record<string, unknown> = { id }
    if (opts.type) bind.type = opts.type
    const rows = this.db.prepare(`
      SELECT n.* FROM edges e
      JOIN nodes n ON n.id = e.${other}
      WHERE e.${self} = @id ${opts.type ? 'AND e.type=@type' : ''}
        AND n.valid_to IS NULL
    `).all(bind) as any[]
    return rows.map(rowToNode)
  }

  /**
   * Transitive dependency walk via recursive CTE. direction 'out' = "what this
   * node uses"; 'in' = "what uses this node" (the re-settle / invalidation index).
   * Returns nodes with their depth from the root (root excluded).
   */
  walk(id: string, opts: { type?: string; direction?: 'out' | 'in'; maxDepth?: number } = {}): Array<Node & { depth: number }> {
    const dir = opts.direction ?? 'out'
    const [self, other] = dir === 'out' ? ['from_id', 'to_id'] : ['to_id', 'from_id']
    const maxDepth = opts.maxDepth ?? 64
    const bind: Record<string, unknown> = { id, maxDepth }
    if (opts.type) bind.type = opts.type
    const rows = this.db.prepare(`
      WITH RECURSIVE reach(id, depth) AS (
        SELECT @id, 0
        UNION
        SELECT e.${other}, reach.depth + 1
        FROM edges e JOIN reach ON e.${self} = reach.id
        WHERE reach.depth < @maxDepth ${opts.type ? 'AND e.type=@type' : ''}
      )
      SELECT n.*, reach.depth FROM reach
      JOIN nodes n ON n.id = reach.id
      WHERE reach.depth > 0 AND n.valid_to IS NULL
      ORDER BY reach.depth
    `).all(bind) as any[]
    return rows.map(r => ({ ...rowToNode(r), depth: r.depth }))
  }

  /** Dependency-DAG view: what `id` (transitively) uses. */
  dependencies(id: string) { return this.walk(id, { type: 'uses', direction: 'out' }) }
  /** Inverse: what (transitively) uses `id` — the invalidation/re-derive set. */
  dependents(id: string)   { return this.walk(id, { type: 'uses', direction: 'in' }) }
  /** Tree view: children under a container via `belongs_to`. */
  children(id: string)     { return this.neighbors(id, { type: 'belongs_to', direction: 'in' }) }

  listKind(kind: string): Node[] {
    return (this.db.prepare(`SELECT * FROM nodes WHERE kind=? AND valid_to IS NULL ORDER BY label`)
      .all(kind) as any[]).map(rowToNode)
  }

  // --- catalog binding + change-propagation -------------------------------

  /**
   * Record that a unit reads a catalog entity. Lazily creates a lightweight
   * `catalog` node for that entity (only the USED slice enters the graph — not
   * all 450k columns) and a `binds_to` edge unit→catalog.
   */
  bind(unitId: string, catalogRef: string, label?: string): void {
    if (!this.getNode(catalogRef)) {
      this.putNode({ id: catalogRef, kind: 'catalog', label: label ?? catalogRef })
    }
    this.putEdge({ from: unitId, to: catalogRef, type: 'binds_to' })
  }

  /**
   * Change-propagation / re-settle index: given a changed catalog entity, return
   * the units that bind to it AND the programs that (transitively) use those units
   * — i.e. everything that must be re-derived. Walks `binds_to` (in) then `uses` (in).
   */
  affectedBy(catalogRef: string): { units: Node[]; programs: Node[] } {
    const units = this.neighbors(catalogRef, { type: 'binds_to', direction: 'in' })
    const programs = new Map<string, Node>()
    for (const u of units) {
      for (const p of this.dependents(u.id)) programs.set(p.id, p)
    }
    return { units, programs: [...programs.values()] }
  }
}
