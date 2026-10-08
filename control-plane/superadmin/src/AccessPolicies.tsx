// ── Data access, for one project ─────────────────────────────────────────────────────────────────────────────────────
// What each person or agent may read: rules (a row filter, a hidden table or a hidden column) per data source and table,
// for everyone, a role, one person (by email) or one agent key; the readers' attributes a row filter can name
// ({attr.branches}); and who is let in by their company's domain. Applied by the datasource manager to every table a
// query reads; a filter naming an attribute the reader lacks hides the table.
//
// Each rule reads as a sentence. A new rule is made in a dialog whose source, table and column are picked from the
// project's data source index (the same copy the data source page keeps), never typed from memory.
// Drawn only with the semantic components (@superatom/ui); no CSS of its own.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Section, Form, Field, Choices, RecordList, Notice, Code, Dialog } from '@superatom/ui'
import type { useProjectHub } from './hub'

type Api = (p: string, i?: RequestInit) => Promise<Response>
type Policy = { id: string; applies_to: string; source: string; table: string; kind: 'row' | 'deny' | 'mask'; predicate?: string | null; column?: string | null; note?: string | null }
type Reader = { subject: string; attributes: Record<string, unknown> }
type IndexSource = { source: string; tables: { table: string; fields: { field: string }[] }[] }

/** Who a rule is for, in words. */
function whoOf(appliesTo: string): string {
  if (appliesTo === 'everyone') return 'Everyone'
  const [kind, ...rest] = appliesTo.split(':'), what = rest.join(':')
  return kind === 'role' ? `Role ${what}` : kind === 'email' ? what : kind === 'agent' ? `Agent ${what}` : appliesTo
}
/** What a rule does, as a sentence: the filter with the table's name and the reader's attributes said in words. */
function whatOf(p: Policy): string {
  if (p.kind === 'deny') return 'the whole table is hidden'
  if (p.kind === 'mask') return `column ${p.column} is hidden`
  return `only rows where ${String(p.predicate ?? '').replace(/\{t\}\./g, '').replace(/\{attr\.([\w-]+)\}/g, 'their $1')}`
}
const valueOf = (v: unknown) => (Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : JSON.stringify(v))

export function AccessPoliciesPanel({ api, hub, projectId }: { api: Api; hub: ReturnType<typeof useProjectHub>; projectId: string }) {
  const [list, setList] = useState<Policy[] | null>(null)
  const [readers, setReaders] = useState<Reader[] | null>(null)
  const [domains, setDomains] = useState<{ domain: string; role_id: string; added_by: string }[] | null>(null)
  const [index, setIndex] = useState<IndexSource[]>([])
  const [err, setErr] = useState('')
  const [making, setMaking] = useState<'rule' | 'attribute' | null>(null)
  const base = `/projects/${projectId}`
  const get = useCallback(<T,>(path: string, pick: (d: any) => T, set: (v: T) => void) => {
    api(`${base}${path}`).then((r) => (r.ok ? r.json() : {})).then((d) => set(pick(d))).catch(() => {})
  }, [api, base])
  const loadRules = useCallback(() => get('/access-policies', (d) => (d.policies ?? []) as Policy[], setList), [get])
  const loadReaders = useCallback(() => get('/access-attributes', (d) => (d.readers ?? []) as Reader[], setReaders), [get])
  const loadDomains = useCallback(() => get('/access-domains', (d) => d.domains ?? [], setDomains), [get])
  useEffect(() => { loadRules(); loadReaders(); loadDomains() }, [loadRules, loadReaders, loadDomains])
  // the data source index, for the pickers: the kept copy at once, then the fresh one
  useEffect(() => { hub.kept({ t: 'dsi:snapshot' }, (r: any) => { if (!r.reason && !r.parcelError) setIndex(r.sources ?? []) }).catch(() => {}) }, [hub, hub.status])
  const say = async (r: Response) => { if (!r.ok) setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Refused (${r.status}).`); else setErr(''); return r.ok }

  const removeRule = async (id: string) => { if (await say(await api(`${base}/access-policies/${id}`, { method: 'DELETE' }))) loadRules() }
  const setAttribute = async (subject: string, key: string, value: unknown) => {
    const ok = await say(await api(`${base}/access-attributes`, { method: 'PUT', body: JSON.stringify({ subject, key, value }) }))
    if (ok) loadReaders()
    return ok
  }
  const [dom, setDom] = useState({ domain: '', roleId: 'viewer' })
  const addDomain = async () => { if (await say(await api(`${base}/access-domains`, { method: 'POST', body: JSON.stringify({ domain: dom.domain.trim(), roleId: dom.roleId }) }))) { setDom({ domain: '', roleId: 'viewer' }); loadDomains() } }
  const removeDomain = async (d: string) => { if (await say(await api(`${base}/access-domains/${d}`, { method: 'DELETE' }))) loadDomains() }
  const count = list?.length ?? 0

  return (
    <div className="sa-stack sa-stack--4">
      {err && <Notice state="critical">{err}</Notice>}

      <Section icon="lucide:shield-check" title="Rules" subtitle="Applied to every table a query reads" note={count ? `${count}` : undefined}
        actions={<button type="button" className="sa-btn sa-btn--primary" onClick={() => setMaking('rule')}>New rule</button>}>
        <RecordList rows={list} keyOf={(p) => p.id} empty="No rules: everyone with access to the project reads everything."
          columns={[
            { key: 'who', label: 'For', render: (p) => <strong>{whoOf(p.applies_to)}</strong> },
            { key: 'where', label: 'Table', render: (p) => <Code>{`${p.source} › ${p.table}`}</Code> },
            { key: 'what', label: 'Rule', wrap: true, render: (p) => <>{whatOf(p)}{p.note ? <span className="sa-muted"> — {p.note}</span> : null}</> },
            { key: 'remove', label: '', align: 'end', render: (p) => <button type="button" className="sa-btn sa-btn--link" onClick={() => void removeRule(p.id)}>Remove</button> },
          ]} />
      </Section>

      <Section icon="lucide:user-cog" title="Readers" subtitle="What a row filter can name about each person or agent key" note={readers?.length ? `${readers.length}` : undefined}
        actions={<button type="button" className="sa-btn" onClick={() => setMaking('attribute')}>Add</button>}>
        <RecordList rows={readers} keyOf={(r) => r.subject} empty="No reader has attributes yet."
          columns={[
            { key: 'who', label: 'Reader', render: (r) => <strong>{whoOf(r.subject)}</strong> },
            { key: 'attrs', label: 'Attributes', wrap: true, render: (r) => (
              <span className="sa-row sa-row--tight sa-row--wrap">
                {Object.entries(r.attributes).map(([k, v]) => (
                  <span key={k} className="sa-row sa-row--tight"><Code>{`${k} = ${valueOf(v)}`}</Code>
                    <button type="button" className="sa-btn sa-btn--link" aria-label={`Remove ${k}`} onClick={() => void setAttribute(r.subject, k, null)}>Remove</button></span>
                ))}
              </span>) },
          ]} />
      </Section>

      <Section icon="lucide:building-2" title="Company sign-in" subtitle="Anyone verified at the domain is let in with the role on first sign-in" note={domains?.length ? `${domains.length}` : undefined}>
        <RecordList rows={domains} keyOf={(d) => d.domain} empty="No domains: people are let in one by one."
          columns={[
            { key: 'domain', label: 'Domain', render: (d) => <Code>{d.domain}</Code> },
            { key: 'role_id', label: 'Role' },
            { key: 'added_by', label: 'Added by', render: (d) => <span className="sa-muted">{d.added_by}</span> },
            { key: 'remove', label: '', align: 'end', render: (d) => <button type="button" className="sa-btn sa-btn--link" onClick={() => void removeDomain(d.domain)}>Remove</button> },
          ]} />
        <Form onSubmit={() => { if (dom.domain.trim()) void addDomain() }} actions={<button className="sa-btn sa-btn--primary" disabled={!dom.domain.trim()}>Let in</button>}>
          <Field label="Domain" help="Their company's sign-in, connected in Clerk, verifies the address.">
            <input id="dom-name" className="sa-input" value={dom.domain} onChange={(e) => setDom({ ...dom, domain: e.target.value })} placeholder="acme.com" />
          </Field>
          <Field label="Role">
            <select id="dom-role" className="sa-input" value={dom.roleId} onChange={(e) => setDom({ ...dom, roleId: e.target.value })}><option value="viewer">viewer</option><option value="member">member</option></select>
          </Field>
        </Form>
      </Section>

      {making === 'rule' && <NewRule index={index} onClose={() => setMaking(null)}
        onSave={async (body) => { const ok = await say(await api(`${base}/access-policies`, { method: 'POST', body: JSON.stringify(body) })); if (ok) { setMaking(null); loadRules() } }} />}
      {making === 'attribute' && <NewAttribute onClose={() => setMaking(null)}
        onSave={async (subject, key, value) => { if (await setAttribute(subject, key, value)) setMaking(null) }} />}
    </div>
  )
}

/** A new rule: who it is for, which table (picked from the index), what it does, and why. */
function NewRule({ index, onSave, onClose }: { index: IndexSource[]; onSave: (body: Record<string, unknown>) => void; onClose: () => void }) {
  const [who, setWho] = useState<'everyone' | 'role' | 'email' | 'agent'>('everyone')
  const [whom, setWhom] = useState('')
  const [source, setSource] = useState(index[0]?.source ?? '')
  const [table, setTable] = useState('')
  const [kind, setKind] = useState<'row' | 'deny' | 'mask'>('row')
  const [predicate, setPredicate] = useState('')
  const [column, setColumn] = useState('')
  const [note, setNote] = useState('')
  useEffect(() => { if (!source && index[0]) setSource(index[0].source) }, [index, source])
  const tables = useMemo(() => index.find((s) => s.source === source)?.tables ?? [], [index, source])
  const fields = useMemo(() => tables.find((t) => t.table === table)?.fields ?? [], [tables, table])
  const appliesTo = who === 'everyone' ? 'everyone' : `${who}:${whom.trim()}`
  const ready = !!source && !!table.trim() && (who === 'everyone' || !!whom.trim()) && (kind !== 'row' || !!predicate.trim()) && (kind !== 'mask' || !!column.trim())
  const save = () => { if (ready) onSave({ applies_to: appliesTo, source, table: table.trim(), kind, note: note.trim() || null, ...(kind === 'row' ? { predicate: predicate.trim() } : {}), ...(kind === 'mask' ? { column: column.trim() } : {}) }) }
  const radio = <T extends string>(name: string, value: T, current: T, set: (v: T) => void, label: string) => (
    <label key={value}><input type="radio" name={name} checked={current === value} onChange={() => set(value)} />{label}</label>)
  return (
    <Dialog title="New rule" onClose={onClose}
      actions={<><button type="button" className="sa-btn" onClick={onClose}>Cancel</button><button type="button" className="sa-btn sa-btn--primary" disabled={!ready} onClick={save}>Add rule</button></>}>
      <Form onSubmit={save}>
        <Choices label="For">
          {radio('rule-who', 'everyone', who, setWho, 'Everyone')}
          {radio('rule-who', 'role', who, setWho, 'A role')}
          {radio('rule-who', 'email', who, setWho, 'One person')}
          {radio('rule-who', 'agent', who, setWho, 'One agent key')}
        </Choices>
        {who !== 'everyone' && (
          <Field label={who === 'role' ? 'Role' : who === 'email' ? 'Their email' : 'Agent key id'}>
            <input id="rule-whom" className="sa-input" value={whom} onChange={(e) => setWhom(e.target.value)} placeholder={who === 'role' ? 'viewer' : who === 'email' ? 'name@company.com' : 'key_…'} />
          </Field>
        )}
        <Field label="Source">
          <select id="rule-source" className="sa-input" value={source} onChange={(e) => { setSource(e.target.value); setTable(''); setColumn('') }}>
            {!index.length && <option value="">Loading the index…</option>}
            {index.map((s) => <option key={s.source} value={s.source}>{s.source}</option>)}
          </select>
        </Field>
        <Field label="Table" help={tables.length ? `${tables.length.toLocaleString()} tables in ${source} — type to narrow.` : undefined}>
          <input id="rule-table" className="sa-input" list="rule-tables" value={table} onChange={(e) => { setTable(e.target.value); setColumn('') }} placeholder="Start typing a table's name" />
          <datalist id="rule-tables">{tables.map((t) => <option key={t.table} value={t.table} />)}</datalist>
        </Field>
        <Choices label="Rule">
          {radio('rule-kind', 'row', kind, setKind, 'Only some rows')}
          {radio('rule-kind', 'deny', kind, setKind, 'Hide the table')}
          {radio('rule-kind', 'mask', kind, setKind, 'Hide a column')}
        </Choices>
        {kind === 'row' && (
          <Field label="Rows where" help={<>The table is <Code>{'{t}'}</Code>; a reader's attribute is <Code>{'{attr.branches}'}</Code>. A reader without that attribute sees none of the table.</>}>
            <input id="rule-predicate" className="sa-input" value={predicate} onChange={(e) => setPredicate(e.target.value)} placeholder="{t}.Location IN {attr.branches}" />
          </Field>
        )}
        {kind === 'mask' && (
          <Field label="Column">
            <input id="rule-column" className="sa-input" list="rule-fields" value={column} onChange={(e) => setColumn(e.target.value)} placeholder={fields.length ? 'Start typing a column' : 'Choose the table first'} />
            <datalist id="rule-fields">{fields.map((f) => <option key={f.field} value={f.field} />)}</datalist>
          </Field>
        )}
        <Field label="Why (optional)">
          <input id="rule-note" className="sa-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="So a colleague knows why it is there" />
        </Field>
      </Form>
    </Dialog>
  )
}

/** A reader's attribute: who, which attribute, its value (JSON — a list or a value — or plain text). */
function NewAttribute({ onSave, onClose }: { onSave: (subject: string, key: string, value: unknown) => void; onClose: () => void }) {
  const [who, setWho] = useState<'email' | 'agent'>('email')
  const [whom, setWhom] = useState('')
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const ready = !!whom.trim() && !!key.trim()
  const save = () => {
    if (!ready) return
    let v: unknown; try { v = JSON.parse(value) } catch { v = value }
    onSave(`${who}:${who === 'email' ? whom.trim().toLowerCase() : whom.trim()}`, key.trim(), v)
  }
  return (
    <Dialog title="A reader's attribute" onClose={onClose}
      actions={<><button type="button" className="sa-btn" onClick={onClose}>Cancel</button><button type="button" className="sa-btn sa-btn--primary" disabled={!ready} onClick={save}>Set</button></>}>
      <Form onSubmit={save}>
        <Choices label="Reader">
          <label><input type="radio" name="attr-who" checked={who === 'email'} onChange={() => setWho('email')} />A person</label>
          <label><input type="radio" name="attr-who" checked={who === 'agent'} onChange={() => setWho('agent')} />An agent key</label>
        </Choices>
        <Field label={who === 'email' ? 'Their email' : 'Agent key id'}>
          <input id="attr-whom" className="sa-input" value={whom} onChange={(e) => setWhom(e.target.value)} placeholder={who === 'email' ? 'name@company.com' : 'key_…'} />
        </Field>
        <Field label="Attribute">
          <input id="attr-key" className="sa-input" value={key} onChange={(e) => setKey(e.target.value)} placeholder="branches" />
        </Field>
        <Field label="Value" help="A list as JSON, or a single value.">
          <input id="attr-value" className="sa-input" value={value} onChange={(e) => setValue(e.target.value)} placeholder='["HYDERABAD", "PUNE"]' />
        </Field>
      </Form>
    </Dialog>
  )
}
