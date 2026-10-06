// THE ORGANISATION'S WAREHOUSE in the console: the explorer over its tables (the whole page — tables, rows, columns
// profiled), and around it what the reader's warehouse capabilities let them do: make a table, add rows, set a table's
// owner, grant tables to projects, ask in SQL, read the record, and the organisation's keys. Drawn only with the
// semantic components (@superatom/ui); every call goes to /api/warehouse, checked by the organisation.

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { Section, RecordList, Form, Field, Choices, Notice, Status, Code, Toolbar, Receipt, ActionBar, Dialog, Explorer, notify, type ExplorerTable, type ExplorerRequest } from '@superatom/ui'

type Api = (path: string, init?: RequestInit) => Promise<Response>
type Column = { name: string; type: string; required?: boolean }
type Table = { name: string; columns: Column[]; rows?: number; appended?: number; owner?: string | null; description?: string }
type Op = { seq: number; at: string; op: string; tbl: string | null; project: string | null; rows: number | null; ok: number; detail: string | null; by: string }
const TYPES = ['string', 'long', 'int', 'double', 'float', 'boolean', 'date', 'timestamptz', 'timestamp']
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

/** "name type [required]" per line → columns. */
function columnsFrom(text: string): { columns: Column[]; problem?: string } {
  const columns: Column[] = []
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [name, type = 'string', req] = line.split(/\s+/)
    if (!TYPES.includes(type)) return { columns, problem: `"${type}" is not a column type (${TYPES.join(', ')})` }
    columns.push({ name, type, ...(req === 'required' ? { required: true } : {}) })
  }
  return { columns }
}

export function WarehousePanel({ api, projects, keys }: { api: Api; projects: { id: string; name: string }[]; keys?: ReactNode }) {
  const [state, setState] = useState<{ configured: boolean; tables: Table[]; ops: Op[]; caps: string[] } | null>(null)
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<{ kind: 'new' } | { kind: 'rows' | 'owner'; table: Table } | null>(null)
  const load = useCallback(async () => {
    const r = await api('/warehouse'); const j: any = await r.json().catch(() => ({}))
    if (!r.ok) { setError(j.error ?? `The warehouse answered ${r.status}`); setState({ configured: false, tables: [], ops: [], caps: [] }); return }
    setError(''); setState({ configured: !!j.configured, tables: j.tables ?? [], ops: j.ops ?? [], caps: j.capabilities ?? [] })
  }, [api])
  useEffect(() => { void load() }, [load])
  const read = useCallback(async (req: ExplorerRequest) => {
    const r = await api('/warehouse/explore', { method: 'POST', body: JSON.stringify(req) }); const j: any = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error ?? `The warehouse answered ${r.status}`)
    return j
  }, [api])
  const may = (c: string) => !!state?.caps.includes(c)
  const tables: ExplorerTable[] | null = state ? state.tables.map((t) => ({ ...t, group: t.owner ? `Owned by ${t.owner}` : 'No owner set' })) : null
  const places = [
    ...(state?.configured && may('warehouse.query') ? [{ key: 'sql', label: 'Ask in SQL', icon: 'lucide:terminal-square', render: () => <Ask api={api} tables={state.tables} /> }] : []),
    ...(state && state.tables.length > 0 && projects.length > 0 && may('warehouse.manage') ? [{ key: 'grants', label: 'What projects may read', icon: 'lucide:shield-check', render: () => <Grants api={api} tables={state.tables} projects={projects} /> }] : []),
    ...(may('warehouse.query') || may('warehouse.manage') ? [{ key: 'record', label: 'What was done', icon: 'lucide:history', render: () => <Operations ops={state?.ops ?? null} /> }] : []),
    ...(keys ? [{ key: 'keys', label: 'Organisation keys', icon: 'lucide:key-round', render: () => keys }] : []),
  ]
  return (
    <div className="sa-graphpage">
      {error && <Notice state="critical">{error}</Notice>}
      {state && !state.configured && !error && (
        <Notice state="attention">The warehouse is not set up on this platform yet: it needs the catalog's account and bucket, its token, and the bucket bound for writing. Until then nothing can be made or asked here.</Notice>
      )}
      <Explorer keep="org-warehouse" tables={tables} read={read} places={places}
        empty={state?.configured ? 'No tables yet — make the first one.' : 'No tables.'}
        tablesHead={state?.configured && may('warehouse.manage') ? <button className="sa-btn sa-btn--link" onClick={() => setDialog({ kind: 'new' })}><Icon icon="lucide:plus" className="sa-btn__icon" />New</button> : null}
        actions={(t) => {
          const table = state?.tables.find((x) => x.name === t.name)
          if (!table) return null
          return (<>
            {may('warehouse.write') && <button className="sa-btn" onClick={() => setDialog({ kind: 'rows', table })}><Icon icon="lucide:list-plus" className="sa-btn__icon" />Add rows</button>}
            {may('warehouse.manage') && <button className="sa-btn" onClick={() => setDialog({ kind: 'owner', table })}><Icon icon="lucide:user-round-pen" className="sa-btn__icon" />Owner</button>}
          </>)
        }} />
      {dialog?.kind === 'new' && <NewTable api={api} onClose={() => setDialog(null)} onMade={() => { setDialog(null); void load() }} />}
      {dialog?.kind === 'rows' && <AddRows api={api} table={dialog.table} onClose={() => setDialog(null)} onAdded={() => { setDialog(null); void load() }} />}
      {dialog?.kind === 'owner' && <Owner api={api} table={dialog.table} projects={projects} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); void load() }} />}
    </div>
  )
}

/** Who owns a table — a person (their email) or a project — and what it is. */
function Owner({ api, table, projects, onClose, onSaved }: { api: Api; table: Table; projects: { id: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const [owner, setOwner] = useState(table.owner ?? ''), [description, setDescription] = useState(table.description ?? ''), [error, setError] = useState('')
  const save = async () => {
    const r = await api('/warehouse/owner', { method: 'POST', body: JSON.stringify({ table: table.name, owner, description }) }); const j: any = await r.json().catch(() => ({}))
    if (!r.ok) { setError(j.error ?? 'Not saved'); return }
    notify(`${table.name}: owner saved`, 'note'); onSaved()
  }
  return (
    <Dialog title={`Who owns ${table.name}`} onClose={onClose}>
      <Form onSubmit={() => void save()} error={error} actions={<><button type="button" className="sa-btn" onClick={onClose}>Cancel</button><button className="sa-btn sa-btn--primary" disabled={!owner.trim()}>Save</button></>}>
        <Field label="Owner" help="A person's email, or a project of the organisation.">
          <input id="wh-owner" className="sa-input" list="wh-owner-projects" autoFocus value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="name@company.com, or a project" />
          <datalist id="wh-owner-projects">{projects.map((p) => <option key={p.id} value={`project:${p.name}`} />)}</datalist>
        </Field>
        <Field label="What it holds"><textarea id="wh-owner-desc" className="sa-input sa-input--area" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What one row is, where the rows come from, how often" /></Field>
      </Form>
    </Dialog>
  )
}

function NewTable({ api, onClose, onMade }: { api: Api; onClose: () => void; onMade: () => void }) {
  const [name, setName] = useState(''); const [cols, setCols] = useState('id long required\nname string\nat timestamptz')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const make = async () => {
    const { columns, problem } = columnsFrom(cols)
    if (problem) { setError(problem); return }
    const r = await api('/warehouse/tables', { method: 'POST', body: JSON.stringify({ name, columns, description }) }); const j: any = await r.json().catch(() => ({}))
    if (!r.ok) { setError(j.error ?? 'The table was not made'); return }
    notify(`${name} was made — you own it`, 'note'); onMade()
  }
  return (
    <Dialog title="Make a table" onClose={onClose}>
      <Form onSubmit={() => void make()} error={error} actions={<><button type="button" className="sa-btn" onClick={onClose}>Cancel</button><button className="sa-btn sa-btn--primary">Make the table</button></>}>
        <Field label="Name" help="Lowercase letters, digits and _, starting with a letter."><input id="wh-name" className="sa-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} required pattern="[a-z][a-z0-9_]*" /></Field>
        <Field label="Columns" help={`One per line: a name, a type, and “required” when every row must have it. Types: ${TYPES.join(', ')}`}><textarea id="wh-cols" className="sa-input sa-input--area sa-input--mono" rows={6} value={cols} onChange={(e) => setCols(e.target.value)} /></Field>
        <Field label="What it holds"><textarea id="wh-desc" className="sa-input sa-input--area" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What one row is, where the rows come from" /></Field>
      </Form>
    </Dialog>
  )
}

/** Two rows shaped like the table, to start from. */
function sampleRows(t: Table): string {
  const v = (c: Column, i: number) => c.type === 'string' ? `${c.name} ${i + 1}` : c.type === 'boolean' ? i === 0 : c.type === 'date' ? `2026-10-0${i + 1}` : c.type.startsWith('timestamp') ? `2026-10-0${i + 1}T09:00:00Z` : (i + 1) * (c.type === 'double' || c.type === 'float' ? 10.5 : 1)
  return JSON.stringify([0, 1].map((i) => Object.fromEntries(t.columns.map((c) => [c.name, v(c, i)]))), null, 2)
}

/** Rows added by hand (a list of objects, one per row) — what a sender does, for trying a table out. */
function AddRows({ api, table, onClose, onAdded }: { api: Api; table: Table; onClose: () => void; onAdded: () => void }) {
  const [text, setText] = useState(() => sampleRows(table))
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  const add = async () => {
    setError('')
    let rows: unknown
    try { rows = JSON.parse(text) } catch { setError('The rows are not JSON: write a list of objects, one per row.'); return }
    if (!Array.isArray(rows) || !rows.length) { setError('Write a list of rows, one object each.'); return }
    setBusy(true)
    const r = await api('/warehouse/append', { method: 'POST', body: JSON.stringify({ table: table.name, rows }) }); const j: any = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) { setError(j.error ?? 'The rows were not added'); return }
    notify(`${j.rows} row${j.rows === 1 ? '' : 's'} added to ${table.name}`, 'note'); onAdded()
  }
  return (
    <Dialog title={`Add rows to ${table.name}`} onClose={onClose}>
      <Form onSubmit={() => void add()} error={error} actions={<><button type="button" className="sa-btn" onClick={onClose}>Cancel</button><button className="sa-btn sa-btn--primary" disabled={busy}>{busy ? 'Adding…' : 'Add the rows'}</button></>}>
        <Field label="Rows" help="A JSON list, one object per row, its keys the table's columns. Rows usually arrive from what sends them, in batches; this is for trying a table out."><textarea id="wh-rows" className="sa-input sa-input--area sa-input--mono" rows={10} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      </Form>
    </Dialog>
  )
}

function Ask({ api, tables }: { api: Api; tables: Table[] }) {
  const [sql, setSql] = useState(`SELECT * FROM ${tables[0].name} LIMIT 20`)
  const [result, setResult] = useState<{ columns: string[]; rows: Record<string, unknown>[]; truncated: boolean } | null>(null)
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true); setError('')
    const r = await api('/warehouse/query', { method: 'POST', body: JSON.stringify({ sql, limit: 100 }) }); const j: any = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) { setError(j.error ?? 'The query was not answered'); setResult(null); return }
    setResult(j)
  }
  return (
    <Section icon="lucide:terminal-square" title="Ask the warehouse" subtitle="SELECT over the organisation's tables, named plainly. At most 100 rows come back.">
      <Form onSubmit={() => void run()} error={error} actions={<button className="sa-btn sa-btn--primary" disabled={busy}>{busy ? 'Asking…' : 'Run'}</button>}>
        <Field label="SQL"><textarea id="wh-sql" className="sa-input sa-input--area sa-input--mono" rows={4} value={sql} onChange={(e) => setSql(e.target.value)} /></Field>
      </Form>
      {result && (
        <RecordList rows={result.rows.map((r, i) => ({ ...r, __i: i }))} keyOf={(r) => String(r.__i)} empty="No rows."
          columns={result.columns.map((c) => ({ key: c, label: c, render: (r: any) => (r[c] === null || r[c] === undefined ? '—' : String(r[c])) }))} />
      )}
      {result?.truncated && <div className="sa-section__body"><Notice>More rows matched; the first 100 are shown.</Notice></div>}
    </Section>
  )
}

function Grants({ api, tables, projects }: { api: Api; tables: Table[]; projects: { id: string; name: string }[] }) {
  const [project, setProject] = useState(projects[0].id)
  const [grant, setGrant] = useState<Record<string, string[] | null>>({})
  const [writable, setWritable] = useState<string[]>([])
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    const r = await api(`/warehouse/grants?project=${encodeURIComponent(project)}`); const j: any = await r.json().catch(() => ({}))
    if (!r.ok) { setError(j.error ?? 'The grants could not be read'); return }
    setError(''); setGrant(j.grant ?? {}); setWritable(j.writable ?? [])
  }, [api, project])
  useEffect(() => { void load() }, [load])
  const set = async (table: string, columns: string[] | null | 'revoke', write = columns === null && writable.includes(table)) => {
    const r = await api(`/warehouse/grants?project=${encodeURIComponent(project)}`, { method: columns === 'revoke' ? 'DELETE' : 'PUT', body: JSON.stringify({ table, ...(columns === 'revoke' ? {} : { columns, write }) }) })
    const j: any = await r.json().catch(() => ({}))
    if (!r.ok) { setError(j.error ?? 'The grant was not changed'); return }
    setError(''); setGrant(j.grant ?? {}); setWritable(j.writable ?? [])
  }
  return (
    <Section icon="lucide:key-round" title="What each project may read and write" subtitle="A project sees only the tables granted to it, and within a table perhaps only some columns; it appends only to tables it may write.">
      <div className="sa-section__body sa-stack">
        <Toolbar>
          <Field label="Project">
            <select id="wh-project" className="sa-input" value={project} onChange={(e) => setProject(e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </Field>
        </Toolbar>
        {error && <Notice state="critical">{error}</Notice>}
        {tables.map((t) => {
          const g = t.name in grant ? grant[t.name] : undefined
          return (
            <div key={t.name} className="sa-stack">
              <Receipt items={[[t.name, g === undefined ? <Status key="s" state="neutral">not granted</Status> : g === null ? <Status key="s" state="ok">{writable.includes(t.name) ? 'reads and writes every column' : 'every column'}</Status> : <Status key="s" state="attention">{`${g.length} of ${t.columns.length} columns`}</Status>]]} />
              <Choices label={`Columns of ${t.name} this project may read`}>
                {t.columns.map((c) => {
                  const on = g === null || (Array.isArray(g) && g.includes(c.name))
                  return (
                    <label key={c.name}><input type="checkbox" id={`wh-${t.name}-${c.name}`} checked={on} onChange={(e) => {
                      const now = g === null ? t.columns.map((x) => x.name) : g ?? []
                      const next = e.target.checked ? [...new Set([...now, c.name])] : now.filter((x) => x !== c.name)
                      void set(t.name, next.length === t.columns.length ? null : next.length ? next : 'revoke')
                    }} /> {c.name}</label>
                  )
                })}
              </Choices>
              <ActionBar>
                <button className="sa-btn" onClick={() => void set(t.name, null)}>Grant every column</button>
                {writable.includes(t.name)
                  ? <button className="sa-btn" onClick={() => void set(t.name, null, false)}>Stop writing</button>
                  : <button className="sa-btn" title="Writing is the whole table: the project reads every column too" onClick={() => void set(t.name, null, true)}>Let it write</button>}
                {g !== undefined && <button className="sa-btn sa-btn--link" onClick={() => void set(t.name, 'revoke')}>Revoke</button>}
              </ActionBar>
            </div>
          )
        })}
      </div>
    </Section>
  )
}

function Operations({ ops }: { ops: Op[] | null }) {
  return (
    <Section icon="lucide:history" title="What was done" subtitle="Tables made, rows added, questions asked — newest first.">
      <RecordList rows={ops} keyOf={(o) => String(o.seq)} empty="Nothing yet."
        columns={[
          { key: 'at', label: 'When', render: (o) => when(o.at) },
          { key: 'op', label: 'What', render: (o) => o.op },
          { key: 'tbl', label: 'Table', render: (o) => (o.tbl ? <Code>{o.tbl}</Code> : '—') },
          { key: 'project', label: 'Project', render: (o) => o.project ?? '—' },
          { key: 'rows', label: 'Rows', align: 'end', render: (o) => o.rows ?? '—' },
          { key: 'took', label: 'Took', align: 'end', render: (o) => { const ms = Number((() => { try { return JSON.parse(o.detail ?? '{}').ms } catch { return NaN } })()); return Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : '—' } },
          { key: 'ok', label: '', render: (o) => <Status state={o.ok ? 'ok' : 'critical'}>{o.ok ? 'done' : 'failed'}</Status> },
          { key: 'by', label: 'By', render: (o) => o.by },
        ]} />
    </Section>
  )
}
