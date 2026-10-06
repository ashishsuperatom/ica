// A PROJECT'S VIEW OF THE ORGANISATION'S WAREHOUSE: the same explorer, over only what the organisation granted the
// project (its tables, and within a table perhaps only some columns). Every read goes over the project's hub to its
// ProjectDO, which adds the grant; the organisation makes the SQL and checks it against that grant again.

import { useCallback, useEffect, useState } from 'react'
import { Explorer, Notice, type ExplorerTable, type ExplorerRequest, type ExplorerQuery } from '@superatom/ui'
import { useProjectHub } from './hub'

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
      setTables((m.tables ?? []).map((t: any) => ({ ...t, group: t.writable ? 'Written by this project' : '' })))
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
  const read = useCallback(async (req: ExplorerRequest) => {
    const m: any = await hub.call({ t: 'warehouse:explore', ...req })
    if (m?.t !== 'warehouse:explored') throw new Error(m?.reason ?? 'The warehouse did not answer')
    const { t: _t, reqId: _r, ...out } = m
    return out
  }, [hub.call])
  return (
    <div className="sa-graphpage">
      {state.error && <Notice state="critical">{state.error}</Notice>}
      {!state.configured && <Notice state="attention">The organisation's warehouse is not set up yet.</Notice>}
      <Explorer keep={`project-warehouse:${projectId}`} tables={tables} read={read} queries={queries} onSaveQuery={saveQuery} onDeleteQuery={deleteQuery} onQueriesChanged={loadQueries}
        empty="The organisation has granted this project no warehouse tables. Its administrators grant them in the organisation's Warehouse." />
    </div>
  )
}
