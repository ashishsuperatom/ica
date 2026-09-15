// ── INSPECTOR — the engine's read-only window into everything it knows ────────
// The admin runs on Cloudflare and the engine runs somewhere else, so the ONLY way to see the project's state is to
// ask the engine for it. This module answers `inspect:req` frames over the hub relay and returns plain JSON — it
// never writes, never runs an agent or a program, and never touches the data sources except to list them.
//
// What it shows comes from the project's stores:
//   • semantic-graph.sqlite — the semantic model's definitions and their history, every answer (memory), every data session and its steps
//   • datasource-index.sqlite — the fields each source has, as ./find-schema searches them
//   • grounding.sqlite — what the grounding agent indexed
//   • agent-sessions.sqlite — which harness session each agent resumes
// …plus the agents' directories, browsable file by file.

import { readFile, readdir } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join, resolve, sep, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallRecord, createGraph } from '@superatom/semantic-graph'
import { dataSourceStats, type DataSourceIndex } from '@superatom/datasource-index'
import { GroundingStore } from '@superatom/grounding'   // the ONE loader/reader for the grounding store
import type { AgentSessions } from './agent-sessions.js'
import { log } from './log.js'   // the central log/error channel — surfaced read-only here

/** Biggest file we'll ship to the browser. */
const MAX_FILE_BYTES = 512 * 1024
/** Hard cap on any list, so a runaway `limit` can't try to serialise everything. */
const MAX_ROWS = 500
/** Directories never worth shipping to the browser — dependency trees, VCS internals. */
const IGNORE_DIRS = new Set(['node_modules', '.git'])

export interface InspectorDeps {
  graph: () => Promise<ReturnType<typeof createGraph>>
  index: DataSourceIndex
  agentSessions: AgentSessions
  projectId: string
  datasourceUrl: string
  roots: { workspace: string; sessions: string; db: string }
  /** Engine-level facts the inspector can't derive (harness/model per agent, uptime, …). */
  runtime?: () => Record<string, unknown>
}

// ── file sandbox ─────────────────────────────────────────────────────────────
// Any path we serve must resolve INSIDE one of the agents' directories: a path in a request is untrusted input,
// and `../../etc/passwd` must not resolve.
function sandbox(roots: string[], p: string): string | null {
  if (!p) return null
  for (const root of roots) {
    const abs = resolve(root, p)
    const base = resolve(root)
    if (abs === base || abs.startsWith(base + sep)) return abs
  }
  return null
}

const limitOf = (a: any, fallback: number) => Math.min(Number(a.limit) || fallback, MAX_ROWS)

/** One answer in a list: what was asked, how it went — never its whole output. */
function slimCall(c: CallRecord) {
  const q: any = c.question
  return {
    id: c.id, parentId: c.parentId, sessionId: c.sessionId, program: q?.program ?? null, question: q, refusal: c.refusal, error: c.error, ms: c.ms, at: c.at,
    decisions: c.decisions?.length ?? 0, caveats: c.caveats.length, statements: c.statements.length,
  }
}

export function createInspector(deps: InspectorDeps) {
  const { projectId, datasourceUrl, roots } = deps
  const browsable = [roots.workspace, roots.sessions]

  // ── the semantic graph ─────────────────────────────────────────────────────

  /** Every definition a name points at — the schema, its sources, settings and producing programs — with its versions. */
  async function programs() {
    const g = await deps.graph()
    return {
      programs: g.store.names().map((n) => {
        const d = g.store.getDefinition(n.hash)
        return { kind: n.kind, name: n.name, hash: n.hash, definedBy: d?.createdBy ?? null, definedAt: d?.createdAt ?? null, versions: g.store.history(n.kind, n.name).length }
      }),
    }
  }

  /** One definition in full, by hash, or by kind and name, with every version its name has pointed at. */
  async function program(a: any) {
    const g = await deps.graph()
    const kind = (a.kind ?? 'program') as any
    const hash = a.hash ? String(a.hash) : g.store.resolve(kind, String(a.name ?? ''))
    const d = hash ? g.store.getDefinition(hash) : null
    if (!d) return { error: `no definition ${a.hash ?? a.name}` }
    const name = a.name ?? g.store.names(d.kind).find((n) => n.hash === d.hash)?.name ?? null
    return { program: { ...d, name, current: name ? g.store.resolve(d.kind, name) === d.hash : false, history: name ? g.store.history(d.kind, name) : [], calls: g.store.callsOn(d.hash).length } }
  }

  /** Answers newest first. */
  async function calls(a: any) {
    const g = await deps.graph()
    const r = g.store.recentCalls({ failed: !!a.failed, limit: limitOf(a, 100), offset: Math.max(Number(a.offset) || 0, 0) })
    return { total: r.total, calls: r.calls.map(slimCall) }
  }

  /** One answer in full — its question, plan, output, statements, caveats — and the answers it asked for. */
  async function call(a: any) {
    const g = await deps.graph()
    const c = g.store.getCall(String(a.id))
    if (!c) return { error: `no call ${a.id}` }
    return { call: c, children: g.store.children(c.id).map(slimCall) }
  }

  /** Every data session: whose, how many steps, when last active. */
  async function sessions(a: any) {
    const g = await deps.graph()
    return { sessions: g.store.listSessions(limitOf(a, 200)) }
  }

  /** One data session: each step's message, the state it led to, and how its answer went. */
  async function session(a: any) {
    const g = await deps.graph()
    const s = g.store.getSession(String(a.id))
    if (!s) return { error: `no session ${a.id}` }
    const steps = g.store.steps(s.id).map((t) => {
      const c = t.callId ? g.store.getCall(t.callId) : null
      const out: any = c?.output
      return { ...t, program: (c?.question as any)?.program ?? null, ms: c?.ms ?? null, callError: c?.error ?? c?.refusal?.reason ?? null,
               narration: Array.isArray(out?.narration) ? out.narration.map((n: any) => n.text) : [], caveats: c?.caveats ?? [] }
    })
    return { session: { ...s, steps } }
  }

  // ── the agents' directories ──────────────────────────────────────────────────

  /** Read one file from inside the agents' directories. */
  async function file(a: any) {
    const rel = String(a.path ?? '')
    const abs = sandbox(browsable, rel)
    if (!abs) return { path: rel, error: 'path is outside the agents\' directories' }
    if (!existsSync(abs)) return { path: rel, error: 'file not found on the engine' }
    const st = statSync(abs)
    if (st.isDirectory()) return { path: rel, error: 'that path is a directory' }
    if (st.size > MAX_FILE_BYTES) return { path: rel, bytes: st.size, error: `file is ${(st.size / 1024).toFixed(0)}KB — too large to display` }
    return { path: rel, abs, bytes: st.size, modified: st.mtimeMs, text: await readFile(abs, 'utf8') }
  }

  /** A directory listing, relative to the shared workspace. */
  async function dir(a: any) {
    const rel = String(a.path ?? '')
    const abs = sandbox(browsable, rel || '.')
    if (!abs || !existsSync(abs)) return { path: rel, error: 'no such directory on the engine' }
    const entries = await readdir(abs, { withFileTypes: true })
    return {
      path: rel,
      entries: entries
        .filter((e) => !e.name.startsWith('.') && !IGNORE_DIRS.has(e.name))
        .map((e) => {
          const child = join(abs, e.name)
          let bytes: number | null = null, modified: number | null = null
          try { const st = statSync(child); bytes = st.isFile() ? st.size : null; modified = st.mtimeMs } catch { /* raced deletion */ }
          return { name: e.name, dir: e.isDirectory(), path: relative(roots.workspace, child), bytes, modified }
        })
        .sort((x, y) => Number(y.dir) - Number(x.dir) || x.name.localeCompare(y.name)),
    }
  }

  // ── the other stores ─────────────────────────────────────────────────────────

  /** LOGS — the engine's central log/error channel (a bounded ring buffer), newest first. */
  function logs(a: any) {
    return { counts: log.counts(), entries: log.recent({ level: a.level || undefined, limit: limitOf(a, 200) }) }
  }

  /** The datasource index: per source, how many tables and fields ./find-schema can find. */
  function index() {
    return { sources: dataSourceStats(deps.index) }
  }

  /** GROUNDING — what the grounding agent indexed: entity types, hierarchies, value patterns. */
  function grounding() {
    const path = join(roots.db, 'grounding.sqlite')
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

  function groundingSummary() {
    const g = grounding() as any
    if (!g.exists || g.error) return { exists: false }
    return { exists: true, entityTypes: g.entityTypes.length, values: g.entityTypes.reduce((n: number, t: any) => n + Number(t.values), 0),
             hierarchies: g.hierarchies.length, patterns: g.patterns.length }
  }

  /** Raw table inventory of every store — the floor under every other view. */
  function db() {
    const inspect = (name: string) => {
      const path = join(roots.db, name)
      if (!existsSync(path)) return { name, path, exists: false, tables: [] }
      let tables: any[] = []
      let conn: DatabaseSync | null = null
      try {
        conn = new DatabaseSync(path, { readOnly: true })
        tables = (conn.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as any[])
          .map((t: any) => {
            let rows: number | null = null
            try { rows = Number((conn!.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as any).n) } catch { /* fts shadow tables can refuse a count */ }
            return { name: t.name, rows }
          })
      } catch { /* a locked db still reports its size */ } finally { try { conn?.close() } catch { /* */ } }
      let bytes = 0
      try { bytes = statSync(path).size } catch { /* wal-only moment */ }
      return { name, path, exists: true, bytes, tables }
    }
    return { databases: ['semantic-graph.sqlite', 'datasource-index.sqlite', 'grounding.sqlite', 'agent-sessions.sqlite'].map(inspect) }
  }

  /** Everything the landing screen needs in ONE round-trip. */
  async function overview() {
    let sources: any[] = []
    let sourcesError: string | null = null
    try {
      const r = await fetch(`${datasourceUrl}/sources`, { signal: AbortSignal.timeout(4000) })
      sources = ((await r.json()) as any)?.sources ?? []
    } catch (e: any) { sourcesError = e?.message ?? String(e) }
    let graph: any = null
    let graphError: string | null = null
    try { graph = (await deps.graph()).store.counts() } catch (e: any) { graphError = e?.message ?? String(e) }
    return {
      projectId, roots: { ...roots, datasourceUrl },
      graph, graphError,
      index: index().sources,
      grounding: groundingSummary(),
      logs: log.counts(),
      sources, sourcesError,
      runtime: deps.runtime?.() ?? {},
      ...db(),
    }
  }

  const VIEWS: Record<string, (a: any) => any> = {
    overview, programs, program, calls, call, sessions, session, file, dir, logs, index, grounding, db,
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
