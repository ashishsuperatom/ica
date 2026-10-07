// EACH SOURCE'S INDEX, ON THIS ENGINE (docs/platform-architecture.md, "Data sources and their index").
//
// The platform holds the index; this engine does two things with it:
//
//  • REPLICA. find-schema and get-schema read a local copy, beside the agents. It follows the platform by a cursor: on
//    welcome and whenever told something changed (dsi:changed), it pulls what changed after its cursor (dsi:pull →
//    dsi:batch, in pages). A replica that is empty, or ahead of the platform (a platform restored from elsewhere), is
//    emptied and pulled whole. Nothing else writes it — not even this engine's own builds: they go up, and come back.
//
//  • BUILDER. The engine is where the connectors run, so it reads each source and sends what it read up, table by table:
//    phase 1 (names, types, descriptions — as fast as possible), then phase 2 (row counts, only where the connector can
//    count cheaply). The platform keeps the checkpoints: a build told what is already done skips it, so a failure, a
//    restart or a source reconnected loses nothing. One build at a time: a lease on the platform (job:start), held by a
//    heartbeat that also says where it is (stage, the table it is on, counts); a second trigger is told the one running.
//    A table that cannot be read is reported as such (dsi:failed), never as empty. A targeted build reads only the
//    tables it names. After the engine's sources are loaded (and whenever they change) it asks the platform whether a
//    build was left unfinished (dsi:resume) — the platform answers with dsi:build.

import { applyItems, replicaCursor, wipeReplica, type DataSourceIndex, type ReplicaItem } from '@superatom/datasource-index'
import { getIndexer, resetIndexerCaches } from './datasource-index/indexer.js'

type Send = (msg: Record<string, unknown>) => boolean
const BEAT_MS = 10_000

export function createDsi(o: { store: DataSourceIndex; manager: string; send: Send; log?: (s: string) => void }) {
  const log = o.log ?? (() => {})
  let n = 0
  const waiting = new Map<string, { resolve: (p: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  /** A message to the platform that it answers (by reqId). */
  function ask(msg: Record<string, unknown>, ms = 60_000): Promise<any> {
    const reqId = `dsi-${Date.now().toString(36)}-${++n}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(reqId); reject(new Error(`the platform did not answer ${msg.type} in ${ms / 1000}s`)) }, ms)
      waiting.set(reqId, { resolve, reject, timer })
      if (!o.send({ ...msg, reqId })) { clearTimeout(timer); waiting.delete(reqId); reject(new Error('the platform is not connected')) }
    })
  }

  // ── The replica ──
  let pulling = false, again = false
  async function pull() {
    if (pulling) { again = true; return }
    pulling = true
    try {
      do {
        again = false
        let cursor = replicaCursor(o.store)
        if (cursor === 0) wipeReplica(o.store)   // nothing of the platform's yet: whatever is here is not its
        for (;;) {
          const b = await ask({ type: 'dsi:pull', cursor })
          if (b.t === 'dsi:refused') throw new Error(b.reason)
          if (cursor > 0 && (Number(b.latest ?? b.cursor) < cursor)) { log(`[dsi] the replica is ahead of the platform (${cursor} > ${b.latest}) — rebuilding it from the platform`); wipeReplica(o.store); cursor = 0; continue }
          if (b.items.length) applyItems(o.store, b.items as ReplicaItem[], Number(b.cursor))
          cursor = Number(b.cursor)
          if (!b.more) break
        }
      } while (again)
    } catch (e: any) { log(`[dsi] the replica could not pull: ${e?.message ?? e}`) }
    finally { pulling = false }
  }

  // ── The builder ──
  let building: Promise<void> | null = null
  async function build(p: { sources?: string[]; tables?: Record<string, string[]>; fresh?: boolean; by?: string }) {
    if (building) { log('[dsi] a build is already running here'); return }
    building = run(p).catch((e) => log(`[dsi] the build stopped: ${e?.message ?? e}`)).finally(() => { building = null })
    await building
  }

  async function run(p: { sources?: string[]; tables?: Record<string, string[]>; fresh?: boolean; by?: string }) {
    const started = await ask({ type: 'job:start', kind: 'dsi.build', lease: 'dsi', by: p.by ?? null })
    if (started.t === 'job:busy') { log(`[dsi] a build is already running (${started.job.id}) — not starting another`); return }
    if (started.t !== 'job:started') throw new Error(started.reason ?? 'the platform did not start the build')
    const job = started.job.id as string
    const state = { stage: 'starting', doing: '', counts: { sources: { done: 0, total: 0 }, tables: { done: 0, total: 0, failed: 0 }, fields: 0 } as any }
    const beat = () => { o.send({ type: 'job:beat', id: job, stage: state.stage, doing: state.doing, counts: state.counts }) }
    const heart = setInterval(beat, BEAT_MS)   // the lease stays held while one slow table is read
    let lastBeat = 0
    const progress = (patch: Partial<typeof state>) => { Object.assign(state, patch); if (Date.now() - lastBeat > 2000) { lastBeat = Date.now(); beat() } }
    resetIndexerCaches()
    try {
      const listed: { id: string; dialect: string }[] = ((await (await fetch(`${o.manager}/sources`)).json()) as any).sources ?? []
      const targeted = p.tables && Object.keys(p.tables).length ? p.tables : null
      const wanted = targeted ? Object.keys(targeted) : p.sources?.length ? p.sources : listed.map((s) => s.id)
      const sources = listed.filter((s) => wanted.includes(s.id))
      for (const missing of wanted.filter((w) => !listed.some((s) => s.id === w))) log(`[dsi] ${missing} is not loaded in the data source manager — skipped`)
      state.counts.sources.total = sources.length
      let failedSources = 0
      for (const s of sources) {
        const raw = async (id: string, sql: string) => {
          const r = await fetch(`${o.manager}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, sql, raw: true }) })
          const j: any = await r.json()
          if (j.error) throw new Error(j.error)
          return j.rows || []
        }
        let indexer
        try { indexer = getIndexer(s.dialect) } catch (e: any) { log(`[dsi] ${s.id}: ${e.message}`); failedSources++; state.counts.sources.done++; continue }

        // PHASE 1 — the tables, then each table's fields.
        progress({ stage: `phase 1 · ${s.id}`, doing: 'listing its tables' })
        let tables: string[], complete = false
        if (targeted) tables = targeted[s.id] ?? []
        else {
          let catalog: string[] | undefined
          try {
            const j: any = await (await fetch(`${o.manager}/introspect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: s.id }) })).json()
            const t = (j.tables || []).map((x: any) => String(x?.name ?? x ?? '')).filter(Boolean)
            if (t.length) catalog = t
          } catch { /* no catalog: the kind's own knowledge */ }
          try { tables = await indexer.listContainers(s.id, raw, { catalogTables: catalog }); complete = !!catalog || s.dialect === 'mssql' }
          catch (e: any) { log(`[dsi] ${s.id}: its tables could not be listed — ${e?.message ?? e}`); failedSources++; state.counts.sources.done++; continue }
        }
        // A targeted build reads the tables it names, whatever was done; a full one resumes from the platform's checkpoints.
        const done = targeted ? new Set<string>() : new Set<string>((await ask({ type: 'dsi:plan', source: s.id, phase: 1, tables, complete, fresh: !!p.fresh })).done ?? [])
        const todo = tables.filter((t) => !done.has(t))
        state.counts.tables.total += tables.length; state.counts.tables.done += done.size
        log(`[dsi] ${s.id}: ${tables.length} tables (${done.size} already done, ${todo.length} to read)`)
        let ok = 0, failed = 0, firstError = ''
        for (const t of todo) {
          progress({ doing: `${s.id} · ${t}` })
          try {
            const entries = await indexer.indexContainer(s.id, t, raw)
            if (!entries.length) throw new Error('no fields could be read')
            o.send({ type: 'dsi:put', source: s.id, phase: 1, table: t, fields: entries.map((e) => ({ name: e.field, type: e.type ?? null, description: e.descDefault ?? null, optional: e.isOptional ?? null, key: e.isKey ?? null, references: e.references ?? null })) })
            ok++; state.counts.fields += entries.length
          } catch (e: any) {
            failed++; state.counts.tables.failed++
            if (!firstError) firstError = String(e?.message ?? e)
            o.send({ type: 'dsi:failed', source: s.id, phase: 1, table: t, error: String(e?.message ?? e).slice(0, 500) })
          }
          state.counts.tables.done++
        }
        if (!targeted) o.send({ type: 'dsi:finish', source: s.id, phase: 1 })
        log(`[dsi] ${s.id}: phase 1 read ${ok}${failed ? `, ${failed} could not be read (first: ${firstError})` : ''}`)

        // PHASE 2 — row counts, only where the connector counts cheaply; what it could not count stays as it was.
        if (indexer.rowCounts && !targeted && ok + done.size > 0) {
          progress({ stage: `phase 2 · ${s.id}`, doing: 'counting rows' })
          try { o.send({ type: 'dsi:rows', source: s.id, counts: await indexer.rowCounts(s.id, raw) }); o.send({ type: 'dsi:finish', source: s.id, phase: 2 }) }
          catch (e: any) { log(`[dsi] ${s.id}: rows not counted — ${e?.message ?? e}`) }
        }
        state.counts.sources.done++
      }
      clearInterval(heart); beat()
      const summary = `${state.counts.sources.done} sources · ${state.counts.tables.done} of ${state.counts.tables.total} tables · ${state.counts.tables.failed} not read · ${state.counts.fields} fields read`
      o.send({ type: 'job:end', id: job, state: failedSources && failedSources === sources.length ? 'failed' : 'done', detail: summary })
      log(`[dsi] build done: ${summary}`)
    } catch (e: any) {
      clearInterval(heart)
      o.send({ type: 'job:end', id: job, state: 'failed', detail: String(e?.message ?? e) })
      throw e
    }
  }

  return {
    /** On welcome: bring the replica up to the platform. */
    welcome: () => { void pull() },
    /** The engine's sources are loaded (or changed): ask whether a build was left unfinished. */
    sourcesReady: () => { o.send({ type: 'dsi:resume' }) },
    building: () => !!building,
    /** A message from the platform about the index or a job. */
    onMessage(p: any): boolean {
      const t = String(p?.t ?? '')
      if (p?.reqId && waiting.has(p.reqId)) { const w = waiting.get(p.reqId)!; clearTimeout(w.timer); waiting.delete(p.reqId); w.resolve(p); return true }
      if (t === 'dsi:changed') { void pull(); return true }
      if (t === 'dsi:build') { void build({ sources: Array.isArray(p.sources) ? p.sources.map(String) : undefined, tables: p.tables ?? undefined, fresh: !!p.fresh, by: p.by ? String(p.by) : undefined }); return true }
      return false
    },
  }
}
