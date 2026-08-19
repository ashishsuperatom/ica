// ── INSPECTOR — the engine's read-only window into everything it knows ────────
// The admin runs on Cloudflare and the engine runs on a Fly VM, so the ONLY way to see the
// project's state is to ask the engine for it. This module answers `inspect:req` frames over
// the hub relay and returns plain JSON — it never writes, never runs an agent, and never
// touches the data sources except to list them.
//
// Everything it exposes comes from two places:
//   • project.sqlite — the node-store graph: concepts, units, programs, intents, basis axes
//   • answers.sqlite — the engine-owned question/answer history + consolidation watermark
// …plus the FILES those nodes point at (a unit node's file_path, a program's directory), so a
// node is inspectable all the way down to its source without SSH.
//
// Views are deliberately generic (nodes / node / file / db) rather than one endpoint per screen:
// the graph gains kinds over time and a typed endpoint per kind would rot. The UI composes the
// screens; the engine just serves the graph honestly.

import { readFile, readdir } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join, resolve, sep, relative, dirname } from 'node:path'
import type { NodeStore, Node } from '@superatom/node-store'
import { findAtoms, atomHistory } from '@superatom/node-store'   // semantic-atom reads (System A)
import { GroundingStore } from '@superatom/grounding'   // the ONE loader/reader for the grounding store
import type { AnswerStore } from './answers.js'
import { log } from './log.js'   // the central log/error channel — surfaced read-only here

const CONCEPT_ROOT = 'concept:root'
const INTENT_ROOT = 'intent:root'

/** Biggest file we'll ship to the browser. A unit is a few KB; anything past this is a data dump. */
const MAX_FILE_BYTES = 512 * 1024
/** Hard cap on any list, so a runaway `limit` can't try to serialise the whole graph. */
const MAX_ROWS = 500
/** Directories never worth shipping to the browser — dependency trees, VCS internals. Excluded from every
 *  filesystem listing (and never descended into): they're huge, irrelevant, and not the agent's own work. */
const IGNORE_DIRS = new Set(['node_modules', '.git'])

export interface InspectorDeps {
  graph: NodeStore
  answers: AnswerStore
  workspace: string        // <root>/<projectId> — programs/, units/, out/, project.sqlite
  dataRoot: string         // <STATE_ROOT>/<projectId> — answers.sqlite
  projectId: string
  datasourceUrl: string
  /** Engine-level facts the inspector can't derive (harness/model per agent, watermark key, …). */
  runtime?: () => Record<string, unknown>
}

// ── file sandbox ─────────────────────────────────────────────────────────────
// Any path we serve must resolve INSIDE one of the engine's own roots. This is what makes
// "click a node, read its source" safe: the node's file_path is agent-authored, so it is
// untrusted input, and `../../etc/passwd` must not resolve.
function sandbox(roots: string[], p: string): string | null {
  if (!p) return null
  for (const root of roots) {
    const abs = resolve(root, p)                       // relative paths resolve against each root
    const base = resolve(root)
    if (abs === base || abs.startsWith(base + sep)) return abs
  }
  return null
}

const safeJson = (s: unknown) => { try { return typeof s === 'string' ? JSON.parse(s) : s } catch { return null } }

export function createInspector(deps: InspectorDeps) {
  const { graph, answers, workspace, dataRoot, projectId, datasourceUrl } = deps
  const roots = [workspace, dataRoot]

  // ── graph reads ────────────────────────────────────────────────────────────
  const countsByKind = () =>
    graph.db.prepare(`SELECT kind, COUNT(*) AS n FROM nodes WHERE valid_to IS NULL GROUP BY kind ORDER BY n DESC`).all() as any[]
  const countsByEdge = () =>
    graph.db.prepare(`SELECT type, COUNT(*) AS n FROM edges GROUP BY type ORDER BY n DESC`).all() as any[]

  /** One row in a node list — enough to render a row, never the full props blob. */
  function slim(n: any) {
    const props = safeJson(n.props) ?? {}
    return {
      id: n.id, kind: n.kind, label: n.label, summary: n.summary ?? null,
      file: n.file_path ?? null,
      validFrom: n.valid_from ?? null, retired: n.valid_to != null,
      // A compact preview of props so a list row can show status/program/etc without a second round-trip.
      propKeys: Object.keys(props),
      status: props.status ?? null, program: props.program ?? null,
      category: props.category ?? null, unit: props.unit ?? null,
      basisType: props.type ?? null, basisToken: props.token ?? null, seed: props.seed ?? null,
    }
  }

  /**
   * Node list: filter by kind, optional FTS-free LIKE search (FTS5 can't do prefix-on-id and we want
   * id/label/summary/props all searchable), newest-first, paged. Retired nodes are hidden unless asked.
   */
  function nodes(a: any) {
    const limit = Math.min(Number(a.limit) || 100, MAX_ROWS)
    const offset = Math.max(Number(a.offset) || 0, 0)
    const where: string[] = []
    const bind: any[] = []
    if (!a.includeRetired) where.push('valid_to IS NULL')
    if (a.kind) { where.push('kind = ?'); bind.push(String(a.kind)) }
    if (a.q) {
      where.push('(id LIKE ? OR label LIKE ? OR summary LIKE ? OR props LIKE ?)')
      const like = `%${String(a.q)}%`
      bind.push(like, like, like, like)
    }
    const sql = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const total = (graph.db.prepare(`SELECT COUNT(*) AS n FROM nodes ${sql}`).get(...bind) as any).n
    const rows = graph.db.prepare(
      `SELECT * FROM nodes ${sql} ORDER BY valid_from DESC, label ASC LIMIT ? OFFSET ?`
    ).all(...bind, limit, offset) as any[]
    return { total, limit, offset, nodes: rows.map(slim) }
  }

  /** Full detail for one node: raw props, both edge directions (with the neighbour's identity), and
   *  — when it points at a file — that file's source, so the graph is inspectable to the code. */
  async function node(a: any) {
    const row = graph.db.prepare(`SELECT * FROM nodes WHERE id = ?`).get(String(a.id)) as any
    if (!row) return { error: `no node ${a.id}` }
    const edgeRows = (dir: 'out' | 'in') => {
      const [self, other] = dir === 'out' ? ['from_id', 'to_id'] : ['to_id', 'from_id']
      return (graph.db.prepare(
        `SELECT e.type, e.props AS edge_props, n.id, n.kind, n.label, n.summary
         FROM edges e LEFT JOIN nodes n ON n.id = e.${other} WHERE e.${self} = ? ORDER BY e.type`
      ).all(String(a.id)) as any[]).map(r => ({
        type: r.type, props: safeJson(r.edge_props) ?? {},
        id: r.id, kind: r.kind ?? null, label: r.label ?? r.id, summary: r.summary ?? null,
      }))
    }
    const detail: any = {
      ...slim(row),
      props: safeJson(row.props) ?? {},
      out: edgeRows('out'), in: edgeRows('in'),
    }
    if (row.file_path) detail.source = await file({ path: row.file_path })
    return { node: detail }
  }

  /** Read one file from inside the engine's roots. Returns the text plus enough metadata to render it. */
  async function file(a: any) {
    const rel = String(a.path ?? '')
    const abs = sandbox(roots, rel)
    if (!abs) return { path: rel, error: 'path is outside the engine workspace' }
    if (!existsSync(abs)) return { path: rel, error: 'file not found on the engine' }
    const st = statSync(abs)
    if (st.isDirectory()) return { path: rel, error: 'that path is a directory' }
    if (st.size > MAX_FILE_BYTES) return { path: rel, bytes: st.size, error: `file is ${(st.size / 1024).toFixed(0)}KB — too large to display` }
    return {
      path: rel, abs, bytes: st.size, modified: st.mtimeMs,
      text: await readFile(abs, 'utf8'),
    }
  }

  /** Directory listing (sandboxed) so the workspace itself is browsable, not just what the graph indexes. */
  async function dir(a: any) {
    const rel = String(a.path ?? '')
    const abs = sandbox(roots, rel || '.')
    if (!abs || !existsSync(abs)) return { path: rel, error: 'no such directory on the engine' }
    const entries = await readdir(abs, { withFileTypes: true })
    return {
      path: rel,
      entries: entries
        .filter(e => !e.name.startsWith('.') && !IGNORE_DIRS.has(e.name))
        .map(e => {
          const child = join(abs, e.name)
          let bytes: number | null = null, modified: number | null = null
          try { const st = statSync(child); bytes = st.isFile() ? st.size : null; modified = st.mtimeMs } catch { /* raced deletion */ }
          return { name: e.name, dir: e.isDirectory(), path: relative(workspace, child), bytes, modified }
        })
        .sort((x, y) => Number(y.dir) - Number(x.dir) || x.name.localeCompare(y.name)),
    }
  }

  // ── composed views ─────────────────────────────────────────────────────────

  /** The concept tree, read-only (never plants the root — that's the engine's job at boot). */
  function conceptTree() {
    if (!graph.getNode(CONCEPT_ROOT)) return { root: null, tree: [] }
    const tree = graph.walk(CONCEPT_ROOT, { type: 'belongs_to', direction: 'in' }).map((n: any) => {
      const p = (n.props ?? {}) as any
      return {
        id: n.id, label: n.label, summary: n.summary ?? null, depth: n.depth,
        status: p.status ?? null, form: p.form ?? null, unit: p.unit ?? null,
        grain: p.grain ?? null, asOf: p.asOf ?? null, population: p.population ?? null,
        measures: (p.measures ?? []).length, dimensions: (p.dimensions ?? []).length,
        parameters: p.parameters ?? [], rules: p.rules ?? [],
      }
    })
    return { root: CONCEPT_ROOT, tree }
  }

  /**
   * PROGRAMS — the union of what's on DISK and what the graph knows, because they diverge:
   * the analyst writes a program directory per answered question, while `program` NODES only
   * appear once the offline modeler has consolidated it. Showing only one of the two hides
   * exactly the gap the admin wants to see.
   */
  async function programs() {
    const base = join(workspace, 'programs')
    const onDisk: any[] = []
    if (existsSync(base)) {
      for (const e of await readdir(base, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        const relDir = `programs/${e.name}`
        const files: any[] = []
        const walk = async (d: string) => {
          for (const f of await readdir(join(workspace, d), { withFileTypes: true })) {
            if (f.name.startsWith('.') || IGNORE_DIRS.has(f.name)) continue
            const rel = `${d}/${f.name}`
            if (f.isDirectory()) { await walk(rel); continue }
            let bytes = 0, modified = 0
            try { const st = statSync(join(workspace, rel)); bytes = st.size; modified = st.mtimeMs } catch { /* raced */ }
            files.push({ path: rel, bytes, modified })
          }
        }
        try { await walk(relDir) } catch { /* unreadable dir — still list the program */ }
        onDisk.push({
          slug: e.name, dir: relDir, files,
          runnable: existsSync(join(workspace, relDir, 'program.ts')),
          modified: files.reduce((m, f) => Math.max(m, f.modified), 0),
        })
      }
    }
    // Which intents run each program, and whether the modeler has minted a program node for it.
    const byDir = new Map<string, any>(onDisk.map(p => [p.dir, { ...p, intents: [], node: null }]))
    for (const n of graph.nodesByKind('intent', 2000)) {
      const p = (n.props ?? {}) as any
      if (!p.program) continue
      const entry = byDir.get(p.program) ?? { slug: String(p.program).replace(/^programs\//, ''), dir: p.program, files: [], runnable: false, modified: 0, intents: [], node: null, missingOnDisk: true }
      entry.intents.push({ id: n.id, question: p.question ?? n.summary ?? n.label, category: p.category ?? null, params: p.params ?? {} })
      byDir.set(entry.dir, entry)
    }
    for (const n of graph.nodesByKind('program', 2000)) {
      const key = n.file_path ? dirname(n.file_path) : null
      const entry = key ? byDir.get(key) : undefined
      if (entry) entry.node = { id: n.id, label: n.label, summary: n.summary ?? null, file: n.file_path }
    }
    // Attach the deterministic RUN AUDIT counts (runs / empty-runs / last run) so a program that keeps
    // failing on new inputs is visible right here, not just in the per-program run log.
    const stats = new Map(answers.programRunStats().map((s: any) => [s.programDir, s]))
    for (const p of byDir.values()) { const s = stats.get(p.dir); p.runs = s?.runs ?? 0; p.empties = s?.empties ?? 0; p.lastRunAt = s?.lastAt ?? null }
    return { programs: [...byDir.values()].sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0)) }
  }

  /** RUNS — the deterministic per-program run audit (input → output shape, degenerate flag, when). One row per
   *  execution, newest first. Pass `programDir` for one program, omit for all. */
  function runs(a: any) {
    return { total: answers.programRuns(a.programDir || undefined, Math.min(Number(a.limit) || 200, MAX_ROWS)).length,
      stats: answers.programRunStats(), runs: answers.programRuns(a.programDir || undefined, Math.min(Number(a.limit) || 200, MAX_ROWS)) }
  }

  /** The intent graph as a tree from ROOT — position IS context, so the shape matters more than a flat list. */
  function intentTree() {
    const rows = graph.db.prepare(`SELECT * FROM nodes WHERE kind='intent' AND valid_to IS NULL`).all() as any[]
    const byId = new Map(rows.map(r => [r.id, r]))
    const parent = new Map<string, string>()
    for (const e of graph.db.prepare(`SELECT from_id, to_id FROM edges WHERE type='follow_up'`).all() as any[]) {
      if (byId.has(e.to_id)) parent.set(e.to_id, e.from_id)
    }
    const kids = new Map<string, string[]>()
    for (const [child, par] of parent) { const l = kids.get(par) ?? []; l.push(child); kids.set(par, l) }
    const out: any[] = []
    const visit = (id: string, depth: number, seen: Set<string>) => {
      if (seen.has(id)) return
      seen.add(id)
      for (const child of (kids.get(id) ?? []).sort()) {
        const r = byId.get(child)
        if (!r) continue
        const p = safeJson(r.props) ?? {}
        out.push({
          id: r.id, depth, label: r.label, question: p.question ?? r.summary ?? r.label,
          category: p.category ?? null, program: p.program ?? null, params: p.params ?? {},
          terms: p.terms ?? [], hasAnalysis: !!p.rawAnalysis,
        })
        visit(child, depth + 1, seen)
      }
    }
    visit(INTENT_ROOT, 0, new Set())
    // Anything not reachable from ROOT (an orphaned node from an older run) is still shown, flagged.
    const shown = new Set(out.map(o => o.id))
    for (const r of rows) {
      if (r.id === INTENT_ROOT || shown.has(r.id)) continue
      const p = safeJson(r.props) ?? {}
      out.push({ id: r.id, depth: 0, label: r.label, question: p.question ?? r.summary ?? r.label,
        category: p.category ?? null, program: p.program ?? null, params: p.params ?? {}, terms: p.terms ?? [], hasAnalysis: !!p.rawAnalysis, orphan: true })
    }
    return { intents: out }
  }

  /** The basis space grouped by facet, with how many intents sit on each axis (usage = what's real). */
  function basis() {
    const usage = new Map<string, number>()
    for (const e of graph.db.prepare(`SELECT to_id, COUNT(*) AS n FROM edges WHERE type='has_basis' GROUP BY to_id`).all() as any[])
      usage.set(e.to_id, e.n)
    const facets = new Map<string, any[]>()
    for (const n of graph.nodesByKind('basis', 5000)) {
      const p = (n.props ?? {}) as any
      if (!p.type || !p.token) continue
      const list = facets.get(p.type) ?? []
      list.push({ id: n.id, token: p.token, plane: p.plane ?? null, seed: !!p.seed, used: usage.get(n.id) ?? 0 })
      facets.set(p.type, list)
    }
    return {
      facets: [...facets.entries()]
        .map(([type, axes]) => ({
          type, plane: axes.find(a => a.plane)?.plane ?? null,
          used: axes.reduce((s, a) => s + a.used, 0),
          axes: axes.sort((a, b) => b.used - a.used || a.token.localeCompare(b.token)),
        }))
        .sort((a, b) => b.used - a.used || a.type.localeCompare(b.type)),
    }
  }

  /** Question history straight from answers.sqlite — what was asked, what it cost, which program ran. */
  function answerList(a: any) {
    const limit = Math.min(Number(a.limit) || 50, MAX_ROWS)
    const offset = Math.max(Number(a.offset) || 0, 0)
    const like = a.q ? `%${String(a.q)}%` : null
    const where = like ? `WHERE question LIKE ?` : ''
    const bind: any[] = like ? [like] : []
    const total = (answers.db.prepare(`SELECT COUNT(*) AS n FROM answers ${where}`).get(...bind) as any).n
    const rows = answers.db.prepare(
      `SELECT qid, session_id, question, category, status, created_at, finished_at, program_dir, params_json
       FROM answers ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...bind, limit, offset) as any[]
    return {
      total, limit, offset,
      answers: rows.map(r => ({
        qid: r.qid, sessionId: r.session_id, question: r.question, category: r.category, status: r.status,
        createdAt: r.created_at, finishedAt: r.finished_at ?? null,
        programDir: r.program_dir ?? null, params: safeJson(r.params_json),
      })),
    }
  }

  function answerDetail(a: any) {
    const row = answers.get(String(a.qid))
    return row ? { answer: row } : { error: `no answer ${a.qid}` }
  }

  /** LOGS — the engine's central log/error channel (a bounded ring buffer), newest first. So a failure that a
   *  local catch handled is still VISIBLE here instead of vanishing. Optional level filter. */
  function logs(a: any) {
    return { counts: log.counts(), entries: log.recent({ level: a.level || undefined, limit: Math.min(Number(a.limit) || 200, MAX_ROWS) }) }
  }

  /** SEMANTIC ATOMS — small learned facts (where/how/quality) the modeler + analyst crystallized from real
   *  analyses. Live versions only; `history` (per id) shows the superseded ones. Read via the node-store API. */
  function atoms(a: any) {
    const slimAtom = (n: Node) => {
      const p = (n.props ?? {}) as any
      return { id: n.id, subject: p.subject ?? n.label, atomKind: p.atomKind ?? null, location: p.location ?? null,
        method: p.method ?? null, coverage: p.coverage ?? null, confidence: p.confidence ?? null,
        evidence: p.evidence ?? null, note: p.note ?? null, hash: p.hash ?? null, provenance: p.provenance ?? null,
        summary: n.summary ?? null, validFrom: n.valid_from ?? null }
    }
    if (a.history) return { history: atomHistory(graph, String(a.history)).map((n) => ({ ...slimAtom(n), retired: n.valid_to != null, validTo: n.valid_to ?? null })) }
    const list = findAtoms(graph, { q: a.q || undefined, atomKind: a.atomKind || undefined, subject: a.subject || undefined, limit: 400 })
    const byKind: Record<string, number> = {}
    for (const n of list) { const k = (n.props as any)?.atomKind ?? 'other'; byKind[k] = (byKind[k] ?? 0) + 1 }
    return { total: list.length, byKind, atoms: list.map(slimAtom) }
  }

  /** GROUNDING — what the grounding agent indexed for this project: entity types (+ value/entity counts),
   *  the hierarchies (live vs materialized, with their join spec) and value patterns. Read through the ONE
   *  GroundingStore reader (never re-queried here); read-only, and absent until the agent has run. */
  function grounding() {
    const path = join(workspace, 'db', 'grounding.sqlite')
    if (!existsSync(path)) return { exists: false, path }
    let store: GroundingStore | null = null
    try {
      store = new GroundingStore(path, { readonly: true })
      let bytes = 0; try { bytes = statSync(path).size } catch { /* wal-only moment */ }
      return { exists: true, path, bytes, ...store.stats() }
    } catch (e: any) {
      return { exists: true, path, error: e?.message ?? String(e) }
    } finally { try { store?.close() } catch { /* */ } }
  }

  /** A compact grounding line for the landing screen (counts only — the full view is `grounding`). */
  function groundingSummary() {
    const path = join(workspace, 'db', 'grounding.sqlite')
    if (!existsSync(path)) return { exists: false }
    let store: GroundingStore | null = null
    try {
      store = new GroundingStore(path, { readonly: true })
      const s = store.stats()
      return {
        exists: true,
        entityTypes: s.entityTypes.length,
        values: s.entityTypes.reduce((a, t) => a + Number(t.values), 0),
        hierarchies: s.hierarchies.length, patterns: s.patterns.length,
      }
    } catch { return { exists: false } } finally { try { store?.close() } catch { /* */ } }
  }

  /** Raw table inventory for both sqlites — the "what's actually stored" floor under every other view. */
  function dbInfo() {
    const inspect = (name: string, path: string, db: any) => {
      if (!existsSync(path)) return { name, path, exists: false, tables: [] }
      let tables: any[] = []
      try {
        tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as any[])
          .map((t: any) => {
            let rows: number | null = null
            try { rows = (db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as any).n } catch { /* fts shadow tables can refuse a count */ }
            return { name: t.name, rows }
          })
      } catch { /* a locked db still reports its size */ }
      let bytes = 0
      try { bytes = statSync(path).size } catch { /* wal-only moment */ }
      return { name, path, exists: true, bytes, tables }
    }
    return {
      databases: [
        inspect('project.sqlite', join(workspace, 'db', 'project.sqlite'), graph.db),
        inspect('answers.sqlite', join(dataRoot, 'db', 'answers.sqlite'), answers.db),
      ],
    }
  }

  /** Everything the landing screen needs in ONE round-trip: sizes, counts, health, roots. */
  async function overview() {
    let sources: any[] = []
    let sourcesError: string | null = null
    try {
      const r = await fetch(`${datasourceUrl}/sources`, { signal: AbortSignal.timeout(4000) })
      sources = ((await r.json()) as any)?.sources ?? []
    } catch (e: any) { sourcesError = e?.message ?? String(e) }

    const answered = (answers.db.prepare(`SELECT COUNT(*) AS n FROM answers WHERE status='answered'`).get() as any).n
    const totalQ = (answers.db.prepare(`SELECT COUNT(*) AS n FROM answers`).get() as any).n
    const last = answers.db.prepare(`SELECT created_at FROM answers ORDER BY created_at DESC LIMIT 1`).get() as any
    const watermark = Number(answers.getMeta('semantic_model:consolidation_watermark') ?? '0')
    const pending = (answers.db.prepare(`SELECT COUNT(*) AS n FROM answers WHERE finished_at > ?`).get(watermark) as any).n

    return {
      projectId,
      roots: { workspace, dataRoot, datasourceUrl },
      kinds: countsByKind(),
      edges: countsByEdge(),
      questions: { total: totalQ, answered, lastAt: last?.created_at ?? null },
      consolidation: { watermark, pending },
      grounding: groundingSummary(),
      logs: log.counts(),
      sources, sourcesError,
      runtime: deps.runtime?.() ?? {},
      ...dbInfo(),
    }
  }

  const VIEWS: Record<string, (a: any) => any> = {
    overview, nodes, node, file, dir, programs, basis, db: dbInfo, grounding, atoms, logs, runs,
    concepts: conceptTree, intents: intentTree,
    answers: answerList, answer: answerDetail,
  }

  return {
    /** Handle one `inspect:req`. Always resolves — an error comes back as `{ error }`, never a throw. */
    async handle(req: any): Promise<any> {
      const view = String(req?.view ?? 'overview')
      const fn = VIEWS[view]
      if (!fn) return { error: `unknown inspect view "${view}" — have: ${Object.keys(VIEWS).join(', ')}` }
      try { return await fn(req ?? {}) }
      catch (e: any) { return { error: e?.message ?? String(e) } }
    },
    views: Object.keys(VIEWS),
  }
}
