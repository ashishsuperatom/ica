// ── Data access, for one project ─────────────────────────────────────────────────────────────────────────────────────
// What each person or agent may read: row filters, denials and column masks per data source and table, for everyone, a
// role, one person (by email) or one agent key; and the attributes a row filter can name ({attr.branches}). Applied by
// the datasource manager to every table a query reads. A filter naming an attribute the reader lacks denies the table.
// Drawn only with the semantic components (@superatom/ui); no CSS of its own.
import { useCallback, useEffect, useState } from 'react'
import { Section, Form, Field, RecordList, Notice, Code } from '@superatom/ui'

type Api = (p: string, i?: RequestInit) => Promise<Response>
type Policy = { id: string; applies_to: string; source: string; table: string; kind: 'row' | 'deny' | 'mask'; predicate?: string | null; column?: string | null; note?: string | null }

export function AccessPoliciesPanel({ api, projectId }: { api: Api; projectId: string }) {
  const [list, setList] = useState<Policy[] | null>(null)
  const [form, setForm] = useState({ applies_to: 'everyone', source: '', table: '', kind: 'row', predicate: '', column: '', note: '' })
  const [subject, setSubject] = useState('')
  const [attrs, setAttrs] = useState<Record<string, unknown> | null>(null)
  const [attr, setAttr] = useState({ key: '', value: '' })
  const [err, setErr] = useState('')
  const [domains, setDomains] = useState<{ domain: string; role_id: string; added_by: string }[] | null>(null)
  const [dom, setDom] = useState({ domain: '', roleId: 'viewer' })
  const base = `/projects/${projectId}`
  const loadDomains = useCallback(() => { api(`${base}/access-domains`).then((r) => (r.ok ? r.json() : { domains: [] })).then((d) => setDomains((d as { domains: typeof domains }).domains)).catch(() => {}) }, [api, base])
  useEffect(loadDomains, [loadDomains])
  const load = useCallback(() => { api(`${base}/access-policies`).then((r) => (r.ok ? r.json() : { policies: [] })).then((d) => setList((d as { policies: Policy[] }).policies)).catch(() => {}) }, [api, base])
  useEffect(load, [load])
  const say = async (r: Response) => { if (!r.ok) setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Refused (${r.status}).`); else setErr(''); return r.ok }

  const add = async () => {
    const body = { applies_to: form.applies_to, source: form.source.trim(), table: form.table.trim(), kind: form.kind, note: form.note || null,
      ...(form.kind === 'row' ? { predicate: form.predicate } : {}), ...(form.kind === 'mask' ? { column: form.column.trim() } : {}) }
    if (await say(await api(`${base}/access-policies`, { method: 'POST', body: JSON.stringify(body) }))) { setForm({ ...form, table: '', predicate: '', column: '', note: '' }); load() }
  }
  const remove = async (id: string) => { if (await say(await api(`${base}/access-policies/${id}`, { method: 'DELETE' }))) load() }
  const loadAttrs = async () => {
    const r = await api(`${base}/access-attributes?subject=${encodeURIComponent(subject.trim())}`)
    if (await say(r.clone())) setAttrs(((await r.json()) as { attributes: Record<string, unknown> }).attributes)
  }
  /** Set an attribute from the form, or remove one by its key (null). */
  const setOne = async (key: string, remove = false) => {
    let value: unknown = null
    if (!remove) { try { value = JSON.parse(attr.value) } catch { value = attr.value } }
    if (await say(await api(`${base}/access-attributes`, { method: 'PUT', body: JSON.stringify({ subject: subject.trim(), key: key.trim(), value }) }))) { setAttr({ key: '', value: '' }); loadAttrs() }
  }

  const removeDomain = async (d: string) => { if (await say(await api(`${base}/access-domains/${d}`, { method: 'DELETE' }))) loadDomains() }
  const addDomain = async () => { if (await say(await api(`${base}/access-domains`, { method: 'POST', body: JSON.stringify({ domain: dom.domain.trim(), roleId: dom.roleId }) }))) { setDom({ domain: '', roleId: 'viewer' }); loadDomains() } }
  const policyReady = !!form.source.trim() && !!form.table.trim()

  return (
    <div className="sa-stack sa-stack--4">
      {err && <Notice state="critical">{err}</Notice>}

      <Section icon="lucide:shield-check" title="Data access" subtitle="What each person or agent may read, applied to every table a query reads" note={(list ?? []).length ? `${(list ?? []).length} polic${(list ?? []).length === 1 ? 'y' : 'ies'}` : undefined}>
        <RecordList rows={list} keyOf={(p) => p.id} empty="No policies: everyone with access to the project reads everything."
          columns={[
            { key: 'applies_to', label: 'Applies to' },
            { key: 'source', label: 'Source' },
            { key: 'table', label: 'Table', render: (p) => <Code>{p.table}</Code> },
            { key: 'rule', label: 'Rule', wrap: true, render: (p) => <><Code>{p.kind === 'row' ? p.predicate : p.kind === 'mask' ? `mask ${p.column}` : 'deny'}</Code>{p.note ? <span className="sa-muted"> · {p.note}</span> : null}</> },
            { key: 'remove', label: '', align: 'end', render: (p) => <button type="button" className="sa-btn sa-btn--link" onClick={() => void remove(p.id)}>Remove</button> },
          ]} />
      </Section>

      <Section icon="lucide:shield-plus" title="Add a policy" subtitle="A row filter, a denied table or a masked column">
        <Form onSubmit={() => { if (policyReady) void add() }}
          actions={<button className="sa-btn sa-btn--primary" disabled={!policyReady}>Add policy</button>}>
          <Field label="Applies to" help={<><Code>everyone</Code>, a role (<Code>role:viewer</Code>), one person (<Code>email:a@b.c</Code>) or one agent key (<Code>agent:key_…</Code>).</>}>
            <input id="pol-applies" className="sa-input" value={form.applies_to} onChange={(e) => setForm({ ...form, applies_to: e.target.value })} placeholder="everyone" />
          </Field>
          <Field label="Source">
            <input id="pol-source" className="sa-input" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} placeholder="TOTALGROUP" />
          </Field>
          <Field label="Table">
            <input id="pol-table" className="sa-input" value={form.table} onChange={(e) => setForm({ ...form, table: e.target.value })} placeholder="Table" />
          </Field>
          <Field label="Rule">
            <select id="pol-kind" className="sa-input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="row">Row filter</option><option value="deny">Deny table</option><option value="mask">Mask column</option>
            </select>
          </Field>
          {form.kind === 'row' && (
            <Field label="Row filter" help={<>Name the table as <Code>{'{t}'}</Code>; a reader's attribute as <Code>{'{attr.branches}'}</Code>. A reader without that attribute cannot read the table.</>}>
              <input id="pol-predicate" className="sa-input" value={form.predicate} onChange={(e) => setForm({ ...form, predicate: e.target.value })} placeholder="{t}.TripLocation IN {attr.branches}" />
            </Field>
          )}
          {form.kind === 'mask' && (
            <Field label="Column">
              <input id="pol-column" className="sa-input" value={form.column} onChange={(e) => setForm({ ...form, column: e.target.value })} placeholder="Column" />
            </Field>
          )}
          <Field label="Why (optional)">
            <input id="pol-note" className="sa-input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
        </Form>
      </Section>

      <Section icon="lucide:building-2" title="Sign-in by company domain" subtitle="Anyone verified at the domain is let in with the role on first sign-in">
        <RecordList rows={domains} keyOf={(d) => d.domain} empty="No domains: people are let in one by one."
          columns={[
            { key: 'domain', label: 'Domain', render: (d) => <Code>{d.domain}</Code> },
            { key: 'role_id', label: 'Role' },
            { key: 'added_by', label: 'Added by', render: (d) => <span className="sa-muted">{d.added_by}</span> },
            { key: 'remove', label: '', align: 'end', render: (d) => <button type="button" className="sa-btn sa-btn--link" onClick={() => void removeDomain(d.domain)}>Remove</button> },
          ]} />
        <Form onSubmit={() => { if (dom.domain.trim()) void addDomain() }}
          actions={<button className="sa-btn sa-btn--primary" disabled={!dom.domain.trim()}>Let in</button>}>
          <Field label="Domain" help="Their company's sign-in, connected in Clerk, verifies the address.">
            <input id="dom-name" className="sa-input" value={dom.domain} onChange={(e) => setDom({ ...dom, domain: e.target.value })} placeholder="acme.com" />
          </Field>
          <Field label="Role">
            <select id="dom-role" className="sa-input" value={dom.roleId} onChange={(e) => setDom({ ...dom, roleId: e.target.value })}><option value="viewer">viewer</option><option value="member">member</option></select>
          </Field>
        </Form>
      </Section>

      <Section icon="lucide:user-cog" title="A reader's attributes" subtitle="What a row filter can name, per person or agent key">
        <Form onSubmit={() => { if (subject.trim()) void loadAttrs() }}
          actions={<button className="sa-btn" disabled={!subject.trim()}>Show</button>}>
          <Field label="Reader">
            <input id="attr-subject" className="sa-input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="email:a@b.c or agent:key_…" />
          </Field>
        </Form>
        {attrs && (<>
          <RecordList rows={Object.entries(attrs).map(([key, value]) => ({ key, value }))} keyOf={(a) => a.key} empty="No attributes."
            columns={[
              { key: 'key', label: 'Attribute', render: (a) => <Code>{a.key}</Code> },
              { key: 'value', label: 'Value', wrap: true, render: (a) => <Code>{JSON.stringify(a.value)}</Code> },
              { key: 'remove', label: '', align: 'end', render: (a) => <button type="button" className="sa-btn sa-btn--link" onClick={() => void setOne(a.key, true)}>Remove</button> },
            ]} />
          <Form onSubmit={() => { if (attr.key.trim()) void setOne(attr.key) }}
            actions={<button className="sa-btn sa-btn--primary" disabled={!attr.key.trim()}>Set</button>}>
            <Field label="Attribute">
              <input id="attr-key" className="sa-input" value={attr.key} onChange={(e) => setAttr({ ...attr, key: e.target.value })} placeholder="branches" />
            </Field>
            <Field label="Value" help="JSON (a list or a value), or plain text.">
              <input id="attr-value" className="sa-input" value={attr.value} onChange={(e) => setAttr({ ...attr, value: e.target.value })} placeholder='["HYDERABAD"] or a single value' />
            </Field>
          </Form>
        </>)}
      </Section>
    </div>
  )
}
