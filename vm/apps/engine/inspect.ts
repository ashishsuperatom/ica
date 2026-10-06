// ── INSPECTOR — the engine's read-only window into everything it knows ────────
// The admin runs on Cloudflare and the engine runs somewhere else, so the ONLY way to see the project's state is to
// ask the engine for it. This module answers `inspect:req` frames over the hub relay and returns plain JSON — it
// never writes, never runs an agent or a program, and never touches the data sources except to list them.
//
// What it shows comes from the project's stores:
//   • datasource-index.sqlite — the fields each source has, as ./find-schema searches them
//   • grounding.sqlite — what the grounding agent indexed
//   • agent-sessions.sqlite — which harness session each agent resumes
//   • composition.sqlite — the composition graph: domains, their parts and files by hash, every change, and which
//     hashes each session was made from
// …plus the agents' directories, browsable file by file.

import { readFile, readdir } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join, resolve, sep, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dataSourceStats, type DataSourceIndex } from '@superatom/datasource-index'
import { GroundingStore } from '@superatom/grounding'   // the ONE loader/reader for the grounding store
import { openStore, drift as compositionDrift, type Store as CompositionStore } from '@superatom/composition-graph/node'
import type { AgentSessions } from './agent-sessions.js'
import { log } from './log.js'   // the central log/error channel — surfaced read-only here

/** Biggest file we'll ship to the browser. */
const MAX_FILE_BYTES = 512 * 1024
/** Hard cap on any list, so a runaway `limit` can't try to serialise everything. */
const MAX_ROWS = 500
/** Directories never worth shipping to the browser — dependency trees, VCS internals. */
const IGNORE_DIRS = new Set(['node_modules', '.git'])

export interface InspectorDeps {
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

export function createInspector(deps: InspectorDeps) {
  const { projectId, datasourceUrl, roots } = deps
  const browsable = [roots.workspace, roots.sessions]


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
    return { databases: ['composition.sqlite', 'datasource-index.sqlite', 'grounding.sqlite', 'agent-sessions.sqlite'].map(inspect) }
  }

  /** Everything the landing screen needs in ONE round-trip. */
  async function overview() {
    let sources: any[] = []
    let sourcesError: string | null = null
    try {
      const r = await fetch(`${datasourceUrl}/sources`, { signal: AbortSignal.timeout(4000) })
      sources = ((await r.json()) as any)?.sources ?? []
    } catch (e: any) { sourcesError = e?.message ?? String(e) }
    return {
      projectId, roots: { ...roots, datasourceUrl },
      index: index().sources,
      grounding: groundingSummary(),
      logs: log.counts(),
      sources, sourcesError,
      runtime: deps.runtime?.() ?? {},
      ...db(),
    }
  }

  // ── The composition graph: what each domain's agent knows, how it was composed, who changed it and why ─────────
  const compositionFile = () => join(roots.db, 'composition.sqlite')
  const withComposition = <T,>(fn: (store: CompositionStore) => T): T | { exists: false } => {
    if (!existsSync(compositionFile())) return { exists: false }
    const store = openStore(compositionFile())
    try { return fn(store) } finally { store.close() }
  }
  /** Every session that is a domain, with what has moved in the graph (this engine's replica of it) since it was made.
   *  The graph itself — its domains, concepts, changes and questions — is read from the platform, which holds it. */
  async function graphSessions() {
    const sessions: { id: string; domain: string; at: string | null; used: number; moved: string[] }[] = []
    const notes: { id: string; note: any }[] = []
    for (const id of await readdir(roots.sessions).catch(() => [] as string[])) {
      try { notes.push({ id, note: JSON.parse(await readFile(join(roots.sessions, id, 'work', '.domain.json'), 'utf8')) }) } catch { /* not a domain session */ }
    }
    return withComposition((store) => {
      for (const { id, note } of notes) sessions.push({ id, domain: String(note.domain ?? ''), at: note.at ?? null, used: Object.keys(note.used ?? {}).length,
        moved: note.used && Object.keys(note.used).length ? compositionDrift(store, note.used).map((x) => x.name) : [] })
      sessions.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
      return { exists: true, sessions: sessions.slice(0, MAX_ROWS) }
    })
  }

  const VIEWS: Record<string, (a: any) => any> = {
    overview, file, dir, logs, index, grounding, db,
    graphSessions,
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
