// ONE NODE OF A SOURCE'S TREE, as the person asking sees it (connectors/src/contract.ts "A SOURCE'S TREE"): a container
// shows what is inside it — searched at the source, a page at a time — and a table its rows. A source with no tree is one
// level: its tables. Opening a node is the surface's (a new block, titled with the path): this draws one node only.

import { useEffect, useState } from 'react'
import { Notice, Field, RecordList, Toolbar, ActionBar } from './index'
import type { ExplorerNode } from './Explorer'

export interface SourceTreeDoors {
  /** What is inside a node (path: the ids from the outermost; [] the outermost), a page at a time, searched by name. */
  list: (path: string[], o: { search?: string; cursor?: string | null }) => Promise<{ nodes: ExplorerNode[]; next?: string | null }>
  /** A table's first rows, narrowed by its filters. */
  read: (path: string[], filters: Record<string, string>) => Promise<Record<string, unknown>[]>
}

const cell = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : String(v).slice(0, 120))

export function SourceNode({ doors, path, table, levels, filters = [], onOpen, pageSize = 20 }: {
  doors: SourceTreeDoors
  path: string[]
  /** It holds rows (else: what is inside it is shown). */
  table: boolean
  /** The tree's levels, outermost first (what a node at each depth is called). */
  levels?: { name: string }[]
  /** A table's filters (narrowing it at the source). */
  filters?: string[]
  onOpen: (node: ExplorerNode) => void
  pageSize?: number
}) {
  const [nodes, setNodes] = useState<ExplorerNode[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null)
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [narrow, setNarrow] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { const h = setTimeout(() => setQ(search.trim()), 350); return () => clearTimeout(h) }, [search])
  const key = JSON.stringify(path)
  const list = async (cursor: string | null) => {
    setErr(''); setBusy(true)
    try { const r = await doors.list(path, { ...(q ? { search: q } : {}), cursor }); setNodes((was) => [...(cursor ? was ?? [] : []), ...r.nodes]); setNext(r.next ?? null) }
    catch (e: any) { setErr(String(e?.message ?? e)); if (!cursor) setNodes([]) }
    finally { setBusy(false) }
  }
  const read = async () => {
    setErr(''); setRows(null)
    try { setRows(await doors.read(path, Object.fromEntries(Object.entries(narrow).filter(([, v]) => v)))) } catch (e: any) { setErr(String(e?.message ?? e)); setRows([]) }
  }
  useEffect(() => { if (table) void read(); else { setNodes(null); void list(null) } }, [key, table, q])   // eslint-disable-line react-hooks/exhaustive-deps

  if (table) {
    const cols = rows?.length ? Object.keys(rows[0]).slice(0, 8) : []
    return (
      <div className="sa-stack">
        {filters.length > 0 && <Toolbar>{filters.map((f) => <Field key={f} label={`Narrow by ${f}`}><input id={`sn-${f}`} className="sa-input" value={narrow[f] ?? ''} placeholder="any" onChange={(e) => setNarrow({ ...narrow, [f]: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void read() }} /></Field>)}</Toolbar>}
        {err && <Notice state="critical">{err}</Notice>}
        <RecordList search pageSize={pageSize} rows={rows ? rows.map((r, i) => ({ ...r, __i: i })) : null} keyOf={(r: any) => String(r.__i)} empty="Nothing here." columns={cols.map((c) => ({ key: c, label: c, render: (r: any) => cell(r[c]) }))} />
        <ActionBar><button className="sa-btn" onClick={() => void read()}>Read again</button></ActionBar>
      </div>
    )
  }
  const level = levels?.[path.length]?.name ?? 'Name'
  const extra = [...new Set((nodes ?? []).flatMap((n) => Object.keys(n.detail ?? {})))].slice(0, 4)
  return (
    <div className="sa-stack">
      <Toolbar><Field label={`Find a ${level.toLowerCase()}`}><input id={`sn-find-${path.length}`} className="sa-input" value={search} placeholder="Its name" onChange={(e) => setSearch(e.target.value)} /></Field></Toolbar>
      {err && <Notice state="critical">{err}</Notice>}
      <RecordList pageSize={pageSize} rows={nodes} keyOf={(n) => n.id} onRow={onOpen} empty={q ? 'Nothing matches.' : 'Nothing here.'}
        columns={[{ key: 'label', label: level }, ...extra.map((k) => ({ key: k, label: k, render: (n: ExplorerNode) => cell(n.detail?.[k]) }))]} />
      {next && <ActionBar><button className="sa-btn" disabled={busy} onClick={() => void list(next)}>{busy ? <span className="sa-spinner" /> : null}More</button></ActionBar>}
    </div>
  )
}
