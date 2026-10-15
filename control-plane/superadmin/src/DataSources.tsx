// A project's data sources and their index: Superatom at the centre, each source branching out with its tables and
// fields, the index build's progress and what it could not read.
import { useUrlState } from './urlState'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { iconOfConnection } from '../../shared/connectors'
import { keptGet, keptSet } from '../../../clients/kept'
import { useProjectHub } from './hub'
import { useNavigate } from 'react-router-dom'
import { SourceHub, sourceColumns, searchTables, type HubSource, type TreeTable, Notice, Code, Receipt, Status, dateTime, SuperatomMark, type StatusState } from '@superatom/ui'
import '@superatom/ui/design.css'

// ── Data sources and their index (per project) ──────────────────────────────
// Where the project's data comes from, and what the index holds of each (held by the platform, dsi.ts; built where each
// source's connector runs). The overview: the project at the centre and every source branching out, each with its state.
// A source opened is a workspace: its actions (build, resume, start over, read again what could not be read), its tables
// as a tree revealed a step at a time (a table or a field described, enabled or disabled, a table read again), and what
// its builds could not read, with why. The whole index arrives once (dsi:snapshot, a parcel when big) and changes are
// applied here as the platform confirms them.
export type DsiPhase = { phase: number; planned: number; done: number; failed: number; complete: boolean; plannedAt: string; finishedAt: string | null }
export type DsiSource = { source: string; tables: number; fields: number; tablesDisabled: number; fieldsDisabled: number; tablesGone: number; phases: DsiPhase[] }
export type DsiJob = { id: string; state: string; stage: string | null; doing: string | null; counts: any; detail: string | null; startedAt: string; beatAt: string }
export type SnapItem = { description?: string; descSource?: string | null; descHuman?: string | null; descAi?: string | null; enabled: boolean; gone: boolean }
export type SnapTable = SnapItem & { table: string; rows?: number | null; fields: (SnapItem & { field: string; type?: string | null; key?: boolean | null; optional?: boolean | null; references?: string | null })[] }
export type Snapshot = { cursor: number; sources: { source: string; tables: SnapTable[] }[] }
export type Failure = { table: string; phase: number; error: string | null; at: string }
/** A failure's reason as a sentence: a JSON problem document (RFC 9457) inside it says its detail (or title); else the text,
 *  cut short. The whole text stays on hover. */
export function reasonOf(error: string | null): string {
  if (!error) return '—'
  const at = error.indexOf('{')
  if (at >= 0) {
    try {
      const doc = JSON.parse(error.slice(at))
      const detail = doc?.['o:errorDetails']?.[0]?.detail ?? doc?.detail ?? doc?.errors?.[0]?.detail ?? doc?.title
      if (typeof detail === 'string') { const last = detail.split(/(?<=[.:])\s+/).filter(Boolean).pop() ?? detail; return last.length < 12 ? detail : last }
    } catch { /* not JSON after all */ }
  }
  return error.length > 160 ? `${error.slice(0, 160)}…` : error
}
/** One source of the snapshot, as the tree components take it. */
export function treeTablesOf(snap: Snapshot | null, name: string): TreeTable[] {
  return (snap?.sources.find((s) => s.source === name)?.tables ?? []).map((t) => ({ name: t.table, rows: t.rows ?? null, description: t.description, descSource: t.descSource, descHuman: t.descHuman, descAi: t.descAi, enabled: t.enabled, gone: t.gone,
    fields: t.fields.map((f) => ({ name: f.field, type: f.type, key: f.key, optional: f.optional, references: f.references, description: f.description, descSource: f.descSource, descHuman: f.descHuman, descAi: f.descAi, enabled: f.enabled, gone: f.gone })) }))
}

export function DataSourcesPanel({ hub, api, projectId, projectName }: { hub: ReturnType<typeof useProjectHub>; api: (p: string, i?: RequestInit) => Promise<Response>; projectId: string; projectName: string }) {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [stats, setStats] = useState<DsiSource[]>([])
  const [conns, setConns] = useState<{ id: string; name: string; connector: string; kind?: string; dialect?: string; runs?: string; level?: string; state?: string; bridge?: string | null; runnable?: boolean }[]>([])
  const [connsKnown, setConnsKnown] = useState(false)
  const [job, setJob] = useState<DsiJob | null>(null)
  const [err, setErr] = useState('')
  const [chosen, setChosen] = useUrlState('source')   // the source open (the URL keeps it)
  // What is picked in the chosen source's columns: a table, or a field of it.
  const [focus, setFocus] = useState<{ table: string; field: string | null } | null>(null)
  // One search over every source: each narrowed to what matches, and how much did.
  const [q, setQ] = useState('')
  const searched = useMemo(() => new Map((snap?.sources ?? []).map((x) => [x.source, searchTables(treeTablesOf(snap, x.source), q)])), [snap, q])
  const explored = useMemo(() => (chosen ? (q.trim() ? searched.get(chosen)?.tables ?? [] : treeTablesOf(snap, chosen)) : []), [snap, chosen, q, searched])
  const [failures, setFailures] = useState<Failure[] | null>(null)
  const [busy, setBusy] = useState(false)
  // Who owns each table or field of the chosen source, and how sensitive it is; and the table whose rows are open.
  const [tags, setTags] = useState<{ table: string; field: string; owner: string | null; sensitivity: string | null }[]>([])
  // A table's rows: the project's data explorer (the Warehouse place, where every source is a group), opened on it.
  const nav = useNavigate()
  const openRows = (table: string) => nav(`../warehouse?open=${encodeURIComponent(table)}`, { relative: 'path' })
  const live = hub.status === 'live'
  // What this browser kept from last time shows at once (even before the socket is up); the fresh answers replace it
  // when they differ (hub.kept). Not connected yet, only the kept copy shows.
  const quiet = (e: any) => { if (live) setErr(e.message) }
  const loadStats = useCallback(() => {
    hub.kept({ t: 'dsi:stats' }, (r: any) => { if (r.reason) setErr(r.reason); else { setStats(r.sources ?? []); setJob(r.running ?? null) } }).catch(quiet)
  }, [hub, live])   // eslint-disable-line react-hooks/exhaustive-deps -- quiet reads live
  const loadSnap = useCallback(() => {
    hub.kept({ t: 'dsi:snapshot' }, (r: any) => { if (r.reason || r.parcelError) setErr(r.reason ?? r.parcelError); else setSnap({ cursor: r.cursor, sources: r.sources ?? [] }) }).catch(quiet)
  }, [hub, live])   // eslint-disable-line react-hooks/exhaustive-deps -- quiet reads live
  useEffect(() => { loadStats(); loadSnap() }, [loadStats, loadSnap])
  useEffect(() => {
    const key = `answer:${projectId}:connections`, show = (list: any[]) => { setConns(list.filter((c: any) => c.level === 'project')); setConnsKnown(true) }
    void keptGet<any[]>(key).then((list) => { if (list) show(list) })
    api(`/projects/${projectId}/connections`).then((r) => (r.ok ? r.json() : null)).then((d: any) => { if (!d) { setConnsKnown(true); return } const list = d.connections ?? []; show(list); void keptSet(key, list) }).catch(() => setConnsKnown(true))
  }, [api, projectId])
  useEffect(() => hub.subscribe((m: any) => {
    if (m?.t !== 'job:update' || !String(m.job?.kind ?? '').startsWith('dsi')) return
    setJob(m.job)
    if (m.job.state !== 'running') { loadStats(); loadSnap() }
  }), [hub, loadStats, loadSnap])

  // Every source the project has (its connections) and every one the index holds, once.
  const names = [...new Set([...conns.map((c) => String(c.name)), ...stats.map((s) => s.source), ...(snap?.sources ?? []).map((s) => s.source)])].sort()
  const running = job?.state === 'running'
  const stateOf = (name: string): { state: StatusState; label: string } => {
    const st = stats.find((s) => s.source === name), p1 = st?.phases.find((p) => p.phase === 1), c = conns.find((x) => x.name === name)
    if (running && String(job?.stage ?? '').includes(name)) return { state: 'running', label: 'indexing' }
    if (c && !c.runnable) return { state: 'critical', label: 'not reachable' }
    if (!p1) return { state: 'neutral', label: 'not indexed yet' }
    if (!p1.finishedAt) return { state: 'attention', label: 'build unfinished' }
    if (p1.failed) return { state: 'attention', label: `${p1.failed} not read` }
    return { state: 'ok', label: 'indexed' }
  }
  const sources: HubSource[] = names.map((name) => {
    const st = stats.find((s) => s.source === name), c = conns.find((x) => x.name === name), s = stateOf(name)
    return { key: name, title: name, icon: c?.connector === 'sa-warehouse' ? <SuperatomMark size={18} /> : iconOfConnection(c ?? {}), found: q.trim() ? searched.get(name)?.found ?? 0 : undefined, meta: [c?.dialect ?? c?.kind, st ? `${st.fields.toLocaleString()} fields` : ''].filter(Boolean).join(' · '), count: st ? `${st.tables.toLocaleString()} tables` : undefined, state: s.state, stateLabel: s.label }
  })
  const totals = stats.reduce((a, s) => ({ t: a.t + s.tables, f: a.f + s.fields }), { t: 0, f: 0 })

  const build = (p: Record<string, unknown>) => hub.call({ t: 'dsi:build', ...p }).then((r: any) => { if (r.reason) setErr(r.reason); else if (r.running) setJob(r.running); else setErr('') }).catch((e: any) => setErr(e.message))
  const chosenStats = stats.find((s) => s.source === chosen)
  const finishedAt = chosenStats?.phases.find((p) => p.phase === 1)?.finishedAt
  useEffect(() => { setFailures(null); if (chosen && live) hub.call({ t: 'dsi:failures', source: chosen }).then((r: any) => setFailures(r.failures ?? [])).catch(() => setFailures([])) }, [hub, live, chosen, finishedAt])
  // What the platform confirmed, put into the index as shown — no reload.
  const apply = (item: any) => setSnap((s) => s && ({ ...s, sources: s.sources.map((x) => x.source !== item.source ? x : { ...x, tables: x.tables.map((t) => {
    if (t.table !== item.table) return t
    const pick = { descSource: item.descSource, descHuman: item.descHuman, descAi: item.descAi, enabled: item.enabled, gone: item.gone }
    return item.field ? { ...t, fields: t.fields.map((f) => (f.field === item.field ? { ...f, ...pick } : f)) } : { ...t, ...pick }
  }) }) }))
  const act = (payload: Record<string, unknown>) => { setBusy(true); setErr(''); hub.call(payload).then((r: any) => { if (r.reason) setErr(r.reason); else if (r.item) apply(r.item) }).catch((e: any) => setErr(e.message)).finally(() => setBusy(false)) }
  const readAgain = (list: string[]) => chosen && build({ tables: { [chosen]: list } })
  useEffect(() => { setTags([]); if (chosen) hub.kept({ t: 'dsi:tags', source: chosen }, (r: any) => setTags(r.tags ?? [])).catch(() => {}) }, [hub, chosen])
  const tagged = useMemo(() => {
    if (!tags.length) return explored
    const of = (t: string, f: string) => tags.find((x) => x.table === t && x.field === f)
    return explored.map((t) => { const tt = of(t.name, ''); return { ...t, owner: tt?.owner ?? null, sensitivity: tt?.sensitivity ?? null,
      fields: t.fields.map((f) => { const ft = of(t.name, f.name); return ft ? { ...f, owner: ft.owner, sensitivity: ft.sensitivity } : f }) } })
  }, [explored, tags])
  const tag = (table: string, field: string | null, t: { owner: string | null; sensitivity: string | null }) => {
    setBusy(true); setErr('')
    hub.call({ t: 'dsi:tag', source: chosen, table, ...(field ? { field } : {}), ...t }).then((r: any) => {
      if (r.reason) setErr(r.reason); else setTags((xs) => [...xs.filter((x) => !(x.table === table && x.field === (field ?? ''))), { table, field: field ?? '', owner: r.tag.owner, sensitivity: r.tag.sensitivity }])
    }).catch((e: any) => setErr(e.message)).finally(() => setBusy(false))
  }
  return (
    <div className="sa-stack sa-stack--4">
      {err && <Notice state="critical">{err}</Notice>}
      {job && <Notice state={job.state === 'failed' || job.state === 'stale' ? 'critical' : running ? 'attention' : 'ok'}
        action={running ? undefined : <button className="sa-btn" disabled={!live} onClick={() => build({})}>Build / resume</button>}>
        <JobLine job={job} />
      </Notice>}
      {/* Straight on the page: the project at the centre and its sources around it; a source chosen, its tree as columns. */}
      <SourceHub centre={{ title: projectName, subtitle: totals.t ? `${totals.t.toLocaleString()} tables · ${totals.f.toLocaleString()} fields` : undefined }} sources={sources} selected={chosen}
        onSelect={(k) => { setChosen((c) => (c === k ? null : k)); setFocus(null) }} empty={connsKnown && snap ? 'No data source yet — connect one, and its index is built here.' : undefined}
        search={{ value: q, onChange: (v) => { setQ(v); setFocus(null) }, placeholder: 'Search every source — tables, fields, types, descriptions' }}
        opened={chosen ? sourceColumns({ tables: tagged, searching: q, onRows: openRows, onTag: tag, loading: !snap, picked: focus, onPick: setFocus, busy,
          source: <SourceSummary name={chosen} conn={conns.find((c) => c.name === chosen)} stats={chosenStats} state={stateOf(chosen)} failures={failures} running={running} build={build} readAgain={readAgain} />,
          onEnable: (table, field, enabled) => act({ t: 'dsi:enable', source: chosen, table, ...(field ? { field } : {}), enabled }),
          onDescribe: (table, field, text) => act({ t: 'dsi:describe', source: chosen, table, ...(field ? { field } : {}), text, by: 'human' }),
          onReread: running ? undefined : (table) => readAgain([table]) }) : undefined} />
    </div>
  )
}

export function JobLine({ job }: { job: DsiJob }) {
  const c = job.counts ?? {}, running = job.state === 'running'
  return <span><strong>{running ? job.stage ?? 'Building' : `Last build ${job.state}`}</strong>{running && job.doing ? ` — ${job.doing}` : ''}
    {c.tables ? ` · ${c.tables.done ?? 0} of ${c.tables.total ?? 0} tables${c.tables.failed ? ` (${c.tables.failed} not read)` : ''} · ${(c.fields ?? 0).toLocaleString()} fields` : ''}
    {c.sources ? ` · source ${Math.min((c.sources.done ?? 0) + (running ? 1 : 0), c.sources.total ?? 0)} of ${c.sources.total ?? 0}` : ''}
    {!running && job.detail ? ` — ${job.detail}` : ''}{!running ? <span className="sa-muted"> · {dateTime(job.beatAt)}</span> : null}</span>
}

/** The details of a chosen source (nothing in it chosen yet): what its index holds, its builds, and what they could not read. */
export function SourceSummary({ name, conn, stats, state, failures, running, build, readAgain }: {
  name: string; conn?: any; stats?: DsiSource; state: { state: StatusState; label: string }; failures: Failure[] | null; running: boolean
  build: (p: Record<string, unknown>) => void; readAgain: (tables: string[]) => void
}) {
  const p1 = stats?.phases.find((p) => p.phase === 1)
  return (
    <div className="sa-stack">
      <div className="sa-row sa-row--tight"><strong>{name}</strong><Status state={state.state}>{state.label}</Status></div>
      {conn?.description && <p className="sa-muted" title={conn.description}>{String(conn.description).slice(0, 240)}</p>}
      <Receipt items={[
        ['Index', stats ? `${stats.tables.toLocaleString()} tables · ${stats.fields.toLocaleString()} fields` : 'not built yet'],
        ['Disabled', stats ? `${stats.tablesDisabled} tables · ${stats.fieldsDisabled} fields` : '—'],
        ['Gone from the source', stats ? `${stats.tablesGone} tables` : '—'],
        ['Last build', p1 ? `${p1.finishedAt ? `finished ${dateTime(p1.finishedAt)}` : `unfinished (${p1.done} of ${p1.planned})`}${p1.failed ? ` · ${p1.failed} not read` : ''}` : 'never'],
        ['Reached', conn ? (conn.runnable ? 'ready' : 'not reachable now') : 'not a connection of this project'],
      ]} />
      <div className="sa-row sa-row--tight">
        <button className="sa-btn" disabled={running} onClick={() => build({ sources: [name] })} title="Read what is not read yet; nothing read twice">Build / resume</button>
        <button className="sa-btn" disabled={running} onClick={() => build({ sources: [name], fresh: true })} title="Read every table again from the start">Start over</button>
      </div>
      {!!failures?.length && <>
        <div className="sa-row sa-row--tight"><strong>Not read · {failures.length}</strong>
          <button className="sa-btn sa-btn--link" disabled={running} onClick={() => readAgain(failures.map((f) => f.table))}>Read these again</button></div>
        <p className="sa-faint">Tables the builds could not read — never counted as empty; the next build tries them again.</p>
        <ul className="sa-notread">
          {failures.map((f) => (
            <li key={f.table}>
              <span className="sa-notread__name"><Code>{f.table}</Code><button className="sa-btn sa-btn--link" disabled={running} onClick={() => readAgain([f.table])}>Read again</button></span>
              <span className="sa-muted" title={f.error ?? ''}>{reasonOf(f.error)}</span>
            </li>
          ))}
        </ul>
      </>}
    </div>
  )
}

/** The project pages that show the engine itself (what it holds, its files, tables, logs, grounding): only these say
 *  whether the engine is up. Every other page reads the platform. */
