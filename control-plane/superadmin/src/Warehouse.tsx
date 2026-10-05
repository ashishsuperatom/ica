// THE ORGANISATION'S WAREHOUSE in the console: whether it is set up, its tables and their columns, making a table,
// asking it in SQL, what each project may read of it, and what has been done to it. Drawn only with the semantic
// components (@superatom/ui); every call goes to /api/warehouse (the organisation's administrator).

import { useCallback, useEffect, useState } from 'react'
import { Section, RecordList, Form, Field, Choices, Notice, Status, Code, Empty, Toolbar, Receipt, ActionBar } from '@superatom/ui'

type Api = (path: string, init?: RequestInit) => Promise<Response>
type Column = { name: string; type: string; required?: boolean }
type Table = { name: string; columns: Column[] }
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

export function WarehousePanel({ api, projects }: { api: Api; projects: { id: string; name: string }[] }) {
  const [state, setState] = useState<{ configured: boolean; tables: Table[]; ops: Op[] } | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    const r = await api('/warehouse'); const j: any = await r.json().catch(() => ({}))
    if (!r.ok) { setError(j.error ?? `The warehouse answered ${r.status}`); setState({ configured: false, tables: [], ops: [] }); return }
    setError(''); setState({ configured: !!j.configured, tables: j.tables ?? [], ops: j.ops ?? [] })
  }, [api])
  useEffect(() => { void load() }, [load])
  // While it is read, the tables and the record are already in their places, as loading rows.
  if (!state) return <div className="sa-stack sa-stack--4"><Tables tables={null} /><Operations ops={null} /></div>
  return (
    <div className="sa-stack sa-stack--4">
      {error && <Notice state="critical">{error}</Notice>}
      {!state.configured && !error && (
        <Notice state="attention">The warehouse is not set up on this platform yet: it needs the catalog's account and bucket, its token, and the bucket bound for writing. Until then nothing can be made or asked here.</Notice>
      )}
      <Tables tables={state.tables} />
      {state.configured && <NewTable api={api} onMade={load} />}
      {state.configured && state.tables.length > 0 && <AddRows api={api} tables={state.tables} onAdded={load} />}
      {state.configured && state.tables.length > 0 && <Ask api={api} tables={state.tables} />}
      {state.tables.length > 0 && projects.length > 0 && <Grants api={api} tables={state.tables} projects={projects} />}
      <Operations ops={state.ops} />
    </div>
  )
}

function Tables({ tables }: { tables: Table[] | null }) {
  const [open, setOpen] = useState<string | null>(null)
  const t = tables?.find((x) => x.name === open)
  return (<>
    <Section icon="lucide:database" title="Tables" subtitle="One warehouse for the organisation; each project reads only what it is granted.">
      <RecordList rows={tables} keyOf={(x) => x.name} onRow={(x) => setOpen(x.name === open ? null : x.name)} empty="No tables yet."
        columns={[{ key: 'name', label: 'Table', render: (x) => <Code>{x.name}</Code> }, { key: 'columns', label: 'Columns', align: 'end', render: (x) => x.columns.length }]} />
    </Section>
    {t && (
      <Section icon="lucide:columns-3" title={t.name} subtitle="Its columns, as the catalog keeps them.">
        <RecordList rows={t.columns} keyOf={(c) => c.name} columns={[
          { key: 'name', label: 'Column', render: (c) => <Code>{c.name}</Code> }, { key: 'type', label: 'Type' },
          { key: 'required', label: '', align: 'end', render: (c) => (c.required ? <Status state="neutral">required</Status> : null) },
        ]} />
      </Section>
    )}
  </>)
}

function NewTable({ api, onMade }: { api: Api; onMade: () => void }) {
  const [name, setName] = useState(''); const [cols, setCols] = useState('id long required\nname string\nat timestamptz')
  const [error, setError] = useState(''); const [made, setMade] = useState('')
  const make = async () => {
    const { columns, problem } = columnsFrom(cols)
    if (problem) { setError(problem); return }
    const r = await api('/warehouse/tables', { method: 'POST', body: JSON.stringify({ name, columns }) }); const j: any = await r.json().catch(() => ({}))
    if (!r.ok) { setError(j.error ?? 'The table was not made'); return }
    setError(''); setMade(name); setName(''); onMade()
  }
  return (
    <Section icon="lucide:table-2" title="Make a table" subtitle="Its columns, one per line: a name, a type, and “required” when every row must have it.">
      {made && <div className="sa-section__body"><Notice state="ok">{made} was made. Rows are added by what sends them to it.</Notice></div>}
      <Form onSubmit={() => void make()} error={error} actions={<button className="sa-btn sa-btn--primary">Make the table</button>}>
        <Field label="Name" help="Lowercase letters, digits and _, starting with a letter."><input id="wh-name" className="sa-input" value={name} onChange={(e) => setName(e.target.value)} required pattern="[a-z][a-z0-9_]*" /></Field>
        <Field label="Columns" help={`Types: ${TYPES.join(', ')}`}><textarea id="wh-cols" className="sa-input sa-input--area" rows={5} value={cols} onChange={(e) => setCols(e.target.value)} /></Field>
      </Form>
    </Section>
  )
}

/** Two rows shaped like the table, to start from. */
function sampleRows(t: Table): string {
  const v = (c: Column, i: number) => c.type === 'string' ? `${c.name} ${i + 1}` : c.type === 'boolean' ? i === 0 : c.type === 'date' ? `2026-10-0${i + 1}` : c.type.startsWith('timestamp') ? `2026-10-0${i + 1}T09:00:00Z` : (i + 1) * (c.type === 'double' || c.type === 'float' ? 10.5 : 1)
  return JSON.stringify([0, 1].map((i) => Object.fromEntries(t.columns.map((c) => [c.name, v(c, i)]))), null, 2)
}

/** Rows added by hand (a list of objects, one per row) — what a sender does, for trying a table out. */
function AddRows({ api, tables, onAdded }: { api: Api; tables: Table[]; onAdded: () => void }) {
  const [table, setTable] = useState(tables[0].name)
  const t = tables.find((x) => x.name === table) ?? tables[0]
  const [text, setText] = useState(() => sampleRows(t))
  const [error, setError] = useState(''); const [done, setDone] = useState(''); const [busy, setBusy] = useState(false)
  const add = async () => {
    setError(''); setDone('')
    let rows: unknown
    try { rows = JSON.parse(text) } catch { setError('The rows are not JSON: write a list of objects, one per row.'); return }
    if (!Array.isArray(rows) || !rows.length) { setError('Write a list of rows, one object each.'); return }
    setBusy(true)
    const r = await api('/warehouse/append', { method: 'POST', body: JSON.stringify({ table, rows }) }); const j: any = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) { setError(j.error ?? 'The rows were not added'); return }
    setDone(`${j.rows} row${j.rows === 1 ? '' : 's'} added to ${table}.`); onAdded()
  }
  return (
    <Section icon="lucide:list-plus" title="Add rows" subtitle="Rows usually arrive from what sends them; here they can be added by hand to try a table out.">
      {done && <div className="sa-section__body"><Notice state="ok">{done}</Notice></div>}
      <Form onSubmit={() => void add()} error={error} actions={<button className="sa-btn sa-btn--primary" disabled={busy}>{busy ? 'Adding…' : 'Add the rows'}</button>}>
        <Field label="Table">
          <select id="wh-rows-table" className="sa-input" value={table} onChange={(e) => { setTable(e.target.value); const nt = tables.find((x) => x.name === e.target.value); if (nt) setText(sampleRows(nt)) }}>
            {tables.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
          </select>
        </Field>
        <Field label="Rows" help="A JSON list, one object per row, its keys the table's columns."><textarea id="wh-rows" className="sa-input sa-input--area sa-input--mono" rows={7} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      </Form>
    </Section>
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
          { key: 'ok', label: '', render: (o) => <Status state={o.ok ? 'ok' : 'critical'}>{o.ok ? 'done' : 'failed'}</Status> },
          { key: 'by', label: 'By', render: (o) => o.by },
        ]} />
    </Section>
  )
}
