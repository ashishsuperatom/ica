// A PROJECT'S DATA, EXPLORED: one explorer over the organisation's warehouse — only what it granted the project (its
// tables, and within a table perhaps only some columns) — and every data source the project connects, each a group of its
// own. The same reads for both (rows searched, filtered, sorted, paged; columns profiled), made by one module
// (clients/explore.ts); where they run differs: a warehouse read goes over the project's hub to its ProjectDO, which adds
// the grant, and the organisation makes the SQL and checks it again; a source's read goes to the engine, through the
// datasource manager, as the one asking (their data access applied). A source that is a tree (a spreadsheet holds sheets)
// is listed through its connector, as the one asking sees it — not from the index.

import { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Explorer, Notice, Icon, SuperatomMark, type ExplorerTable, type ExplorerRequest, type ExplorerQuery, type ExplorerBranch } from '@superatom/ui'
import { useProjectHub } from './hub'
import { exploreType } from '../../../clients/explore'
import { iconOfConnection } from '../../shared/connectors'
import { AdminContext } from './AdminBlocks'
import { WAREHOUSE } from './Warehouse'

/** Where a table shown in the explorer is read from. */
type Origin = { from: 'warehouse' } | { from: 'source'; source: string; table: string }

export function ProjectWarehouse({ projectId, token }: { projectId: string; token: string | null }) {
  const hub = useProjectHub(projectId, token)
  const [tables, setTables] = useState<ExplorerTable[] | null>(null)
  const [state, setState] = useState<{ configured: boolean; error: string }>({ configured: true, error: '' })
  useEffect(() => {
    if (hub.status !== 'live') return
    void hub.call({ t: 'warehouse:tables' }).then((m: any) => {
      if (m?.t !== 'warehouse:tables') { setState({ configured: true, error: m?.reason ?? 'The warehouse could not be read' }); setTables([]); return }
      setState({ configured: !!m.configured, error: '' })
      // Every table here is one the project reads; those it also writes are set apart.
      setTables((m.tables ?? []).map((t: any) => ({ ...t, group: WAREHOUSE })))
    }).catch((e: any) => { setState({ configured: true, error: String(e?.message ?? e) }); setTables([]) })
  }, [hub.status, hub.call])
  // One's own queries from this project, kept in one's UserDO through the project's hub.
  const [queries, setQueries] = useState<ExplorerQuery[] | null>(null)
  const loadQueries = useCallback(async () => {
    const m: any = await hub.call({ t: 'warehouse:queries' }).catch(() => null)
    setQueries(m?.t === 'warehouse:queries' ? m.queries ?? [] : [])
  }, [hub.call])
  useEffect(() => { if (hub.status === 'live') void loadQueries() }, [hub.status, loadQueries])
  const saveQuery = useCallback(async (q: { id?: number; name: string; sql: string; columns?: unknown }) => {
    const m: any = await hub.call({ t: 'warehouse:queries:save', ...q })
    if (m?.t !== 'warehouse:queries') throw new Error(m?.reason ?? 'Not saved')
    const { t: _t, reqId: _r, ...x } = m
    return x as ExplorerQuery
  }, [hub.call])
  const deleteQuery = useCallback(async (id: number) => { await hub.call({ t: 'warehouse:queries:delete', id }) }, [hub.call])
  // Every data source's tables, from the project's index (the browser's kept copy at once, then the platform's).
  const [sources, setSources] = useState<{ source: string; tables: { table: string; rows?: number | null; gone: boolean; descHuman?: string | null; descSource?: string | null; descAi?: string | null
    fields: { field: string; type?: string | null; gone: boolean }[] }[] }[]>([])
  useEffect(() => { hub.kept({ t: 'dsi:snapshot' }, (r: any) => { if (!r.reason && !r.parcelError) setSources(r.sources ?? []) }).catch(() => {}) }, [hub, hub.status])
  // Each source's logo, from its connection (its connector's, else its dialect's).
  const env = useContext(AdminContext)
  const [conns, setConns] = useState<{ name: string; connector?: string; dialect?: string; source?: { kind?: string } }[]>([])
  useEffect(() => { env?.api(`/projects/${projectId}/connections`).then((r) => (r.ok ? r.json() : null)).then((d: any) => setConns(d?.connections ?? [])).catch(() => {}) }, [env, projectId])
  const groupIcon = useCallback((g: string) => (g === WAREHOUSE ? <SuperatomMark size={16} />
    : <Icon icon={iconOfConnection(conns.find((c) => c.name === g) ?? {}) ?? 'lucide:database'} width={16} height={16} />), [conns])
  // The sources that are a tree (their connector names its levels): each a branch, its nodes asked as one goes.
  const [trees, setTrees] = useState<string[]>([])
  useEffect(() => {
    if (hub.status !== 'live') return
    let live = true
    const maybe = conns.filter((c) => c.source?.kind && c.source.kind !== 'sql')
    void Promise.all(maybe.map((c) => hub.call({ t: 'connector:introspect', source: c.name }).then((m: any) => (m?.result?.tree ? c.name : null)).catch(() => null)))
      .then((names) => { if (live) setTrees(names.filter((n): n is string => !!n)) })
    return () => { live = false }
  }, [hub.status, hub.call, conns])
  const branches = useMemo(() => Object.fromEntries(trees.map((g): [string, ExplorerBranch] => [g, async (path, o) => {
    const m: any = await hub.call({ t: 'connector:children', source: g, path, ...o })
    if (m?.t !== 'connector:result') throw new Error(m?.reason ?? 'It did not answer')
    return m.result
  }])), [trees, hub.call])
  // Each source's tables first, then the warehouse's as a group named for it. A name is the table's; a source's table whose
  // name another shown table has is named with its source too, so each name is one table.
  const { shown, origins } = useMemo(() => {
    const origins = new Map<string, Origin>()
    const out: ExplorerTable[] = []
    const names = new Set<string>([...(tables ?? []).map((t) => t.name)])
    for (const s of sources) for (const t of s.tables) {
      if (s.source === WAREHOUSE) continue   // SA-WAREHOUSE is a source of the project too; its tables are the warehouse's own group
      if (trees.includes(s.source)) continue   // a tree is listed through its connector
      if (t.gone) continue
      const name = origins.has(t.table) || names.has(t.table) ? `${s.source}.${t.table}` : t.table
      origins.set(name, { from: 'source', source: s.source, table: t.table })
      out.push({ name, group: s.source, rows: t.rows ?? undefined, description: t.descHuman || t.descSource || t.descAi || undefined,
        columns: t.fields.filter((f) => !f.gone).map((f) => ({ name: f.field, type: exploreType(f.type ?? null) })) })
    }
    for (const t of tables ?? []) { origins.set(t.name, { from: 'warehouse' }); out.push(t) }
    return { shown: tables === null && !sources.length ? null : out, origins }
  }, [tables, sources, trees])
  const read = useCallback(async (req: ExplorerRequest) => {
    // a table of a tree: by its source (its group) and its path
    if ('path' in req && req.path?.length && req.group) {
      const r: any = await hub.call({ t: 'source:explore', source: req.group, request: req })
      if (r.error || r.reason) throw new Error(r.error ?? r.reason)
      return r.result
    }
    const o = 'table' in req ? origins.get(req.table) : undefined
    if (o?.from === 'source') {
      const r: any = await hub.call({ t: 'source:explore', source: o.source, request: { ...req, table: o.table } })
      if (r.error || r.reason) throw new Error(r.error ?? r.reason)
      return r.result
    }
    const m: any = await hub.call({ t: 'warehouse:explore', ...req })
    if (m?.t !== 'warehouse:explored') throw new Error(m?.reason ?? 'The warehouse did not answer')
    const { t: _t, reqId: _r, ...out } = m
    return out
  }, [hub.call, origins])
  const [params, setParams] = useSearchParams()
  // the table or query open, kept in the URL (?open=<table> or ?query=<id>): a link opens the same place
  const placeInUrl = useCallback((o: { table?: string; query?: string } | null) => setParams((p) => { const n = new URLSearchParams(p); n.delete('open'); n.delete('query'); if (o?.table) n.set('open', o.table); if (o?.query) n.set('query', o.query); return n.toString() === p.toString() ? p : n }, { replace: true }), [setParams])
  return (
    <div className="sa-graphpage">
      {state.error && <Notice state="critical">{state.error}</Notice>}
      {!state.configured && <Notice state="attention">The organisation's warehouse is not set up yet.</Notice>}
      <Explorer keep={`project-warehouse:${projectId}`} open={params.get('open')} openQuery={params.get('query')} onPick={placeInUrl} sections groupIcon={groupIcon} branches={branches} tables={shown} read={read} queries={queries} onSaveQuery={saveQuery} onDeleteQuery={deleteQuery} onQueriesChanged={loadQueries}
        empty="No tables yet: the organisation grants warehouse tables, and each connected source's tables show once its index is built." />
    </div>
  )
}
