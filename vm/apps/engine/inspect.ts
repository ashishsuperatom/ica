// ── INSPECTOR — the engine's read-only window into everything it knows ────────
// The admin runs on Cloudflare and the engine runs on a Fly VM, so the ONLY way to see the
// project's state is to ask the engine for it. This module answers `inspect:req` frames over
// the hub relay and returns plain JSON — it never writes, never runs an agent, and never
// touches the data sources except to list them.
//
// Everything it exposes comes from two places:
//   • project.sqlite — the node-store graph: concepts, units, programs, intents
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
import { GroundingStore } from '@superatom/grounding'   // the ONE loader/reader for the grounding store
import type { AnswerStore } from './answers.js'
import { log } from './log.js'   // the central log/error channel — surfaced read-only here
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
  /** Node counts per kind. `n` is what EXISTS to a reader; `total` is how many rows carry that kind.
   *
   *  They differ for content-addressed kinds. A concept body is immutable, so editing one mints a new body
   *  and repoints the name — the old body keeps its row and its label for ever. Counting rows therefore
   *  reported 113 concepts where 44 are reachable, on the same screen as a list showing 44, and the store
   *  looked broken while working exactly as designed. Superseded bodies are still counted, and reported
   *  separately, because they are real: a program built last month still refers to one. */
  const countsByKind = () => {
    const rows = graph.db.prepare(
      `SELECT kind, COUNT(*) AS n FROM nodes WHERE valid_to IS NULL GROUP BY kind ORDER BY n DESC`).all() as any[]
    const reachable = graph.db.prepare(
      `SELECT COUNT(DISTINCT json_extract(props,'$.target')) AS n FROM nodes
        WHERE kind='index' AND valid_to IS NULL AND id NOT LIKE '%@%'`).get() as any
    return rows.map((r) => r.kind === 'concept'
      ? { kind: r.kind, n: reachable?.n ?? r.n, total: r.n, superseded: Math.max(0, r.n - (reachable?.n ?? r.n)) }
      : { kind: r.kind, n: r.n, total: r.n })
  }
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
      category: props.category ?? null, version: props._v?.version ?? null,
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

    // A CONCEPT IS ALSO WHAT IT LAST DID. The props say what it computes; the sample says what that came to,
    // on which parameters, and whether its own assertions held — which is the difference between a concept
    // that reads well and one that still works. The names come along because a concept has several and the
    // node's own label is only whichever one it was saved under.
    if (row.kind === 'concept') {
      try {
        const s = graph.db.prepare('SELECT * FROM concept_sample WHERE concept_id = ?').get(String(a.id)) as any
        if (s) detail.lastRun = {
          value: s.value == null ? null : JSON.parse(s.value), rows: s.rows ?? null,
          params: JSON.parse(s.params || '{}'), at: s.at, ms: s.ms,
          verifications: JSON.parse(s.verifications || '[]'), caveats: JSON.parse(s.caveats || '[]'),
        }
      } catch { /* an older store has no samples; the node still renders */ }
      detail.names = (graph.db.prepare(
        `SELECT label FROM nodes WHERE kind='index' AND valid_to IS NULL AND id NOT LIKE '%@%'
           AND json_extract(props,'$.target') = ?`).all(String(a.id)) as any[]).map((r) => r.label)
    }
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

  /** Live concepts — the ones a NAME currently reaches, which is not the same as every concept row.
   *
   *  A concept is content-addressed, so editing one mints a NEW body and repoints the name; the old body
   *  stays, keeping the label it had. Listing concept rows therefore showed 113 entries for 44 concepts,
   *  several of them sharing a name with nothing to say which was current — the store looking corrupt when
   *  it was working exactly as designed. Reachability by a live name is what "exists" means here.
   *
   *  Every name that reaches a body travels with it, because a concept has no single name: the primary
   *  phrase and its aliases are the same kind of thing, and which one the admin searched for is arbitrary. */
  function conceptList() {
    // TWO SCANS, JOINED IN MEMORY — not a correlated subquery per concept.
    //
    // A name is an `index` row whose target sits inside its JSON, so "which concepts are reachable" is the one
    // question this store asks OF props rather than fetching props whole. Asked per concept it is a scan
    // inside a scan, growing with concepts AND names together: 9.2ms to list 44 of them, against 0.004ms to
    // open one. Read each side once and match them here instead — 0.5ms, and it grows with the sum rather
    // than the product. (An expression index on the target was tried first; the planner would not take it for
    // a correlated equality, and not correlating is the better fix anyway.)
    const names = new Map<string, string[]>()
    for (const r of graph.db.prepare(
      `SELECT label, json_extract(props,'$.target') AS target FROM nodes
        WHERE kind='index' AND valid_to IS NULL AND id NOT LIKE '%@%'`).all() as any[]) {
      if (!r.target) continue
      const list = names.get(r.target); list ? list.push(r.label) : names.set(r.target, [r.label])
    }
    const rows = (graph.db.prepare(
      `SELECT id, label, summary, props FROM nodes WHERE kind='concept' LIMIT 5000`).all() as any[])
      .filter((r) => names.has(r.id))

    // WHAT IT LAST PRODUCED. A runnable concept that has never been run is a different thing from one that
    // ran this morning, and the table is where that difference should be visible without opening anything.
    const sample = new Map<string, any>()
    try {
      for (const r of graph.db.prepare('SELECT * FROM concept_sample').all() as any[]) sample.set(r.concept_id, r)
    } catch { /* the sample table predates nothing; an older store simply has no samples */ }

    const list = rows.map((n: any) => {
      const p = (typeof n.props === 'string' ? JSON.parse(n.props) : n.props ?? {}) as any
      const nameList: string[] = names.get(n.id) ?? []
      const s = sample.get(n.id)
      const compute = String(p.compute ?? '')
      // WHAT THE CONCEPT CALLS ITSELF LEADS. Index rows come back in insertion order, so taking the first
      // one showed a migrated concept under the name of the prose it replaced — the one thing about it that
      // is now out of date. Its own name is the honest label; every other name is an alias that reaches it.
      // The node's LABEL is the name it was saved under — its own, current name. props.name is not set on a
      // concept body, so reaching for that fell through to whichever index row happened to come back first,
      // which for a migrated concept is the prose name it replaced.
      const self = nameList.includes(n.label) ? n.label : (n.label ?? nameList[0] ?? n.id)
      return {
        id: n.id, name: self, aliases: nameList.filter((x) => x !== self), summary: n.summary ?? null,
        status: p.status ?? null, version: p._v?.version ?? 1, changedBy: p._v?.changedBy ?? null,
        source: (p.sources ?? [])[0] ?? p.source ?? null, sources: p.sources ?? (p.source ? [p.source] : []),
        grain: p.grain ?? null, verifiedAt: p.verifiedAt ?? null,
        measures: (p.measures ?? []).length, dimensions: (p.dimensions ?? []).length,
        requires: p.requires ?? [], rules: p.rules ?? [],
        // ONE TEST, everywhere: a body that default-exports a function. It says nothing about a `meta` block,
        // which a body no longer carries — the metadata is the concept's own fields.
        runnable: /export\s+default/.test(compute),
        lastRun: s ? {
          value: s.value == null ? null : JSON.parse(s.value),
          rows: s.rows ?? null, at: s.at,
          invariants: JSON.parse(s.verifications || '[]').length,
          caveats: JSON.parse(s.caveats || '[]').length,
        } : null,
      }
    })
    return { total: list.length, concepts: list }
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
    const watermark = Number(answers.getMeta('concept_model:consolidation_watermark') ?? '0')
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
    overview, nodes, node, file, dir, programs, db: dbInfo, grounding, logs, runs,
    concepts: conceptList, intents: intentTree,
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
