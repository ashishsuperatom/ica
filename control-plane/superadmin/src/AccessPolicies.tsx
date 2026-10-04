// ── Data access, for one project ─────────────────────────────────────────────────────────────────────────────────────
// What each person or agent may read: row filters, denials and column masks per data source and table, for everyone, a
// role, one person (by email) or one agent key; and the attributes a row filter can name ({attr.branches}). Applied by
// the datasource manager to every table a query reads. A filter naming an attribute the reader lacks denies the table.
import React, { useCallback, useEffect, useState } from 'react'

type Api = (p: string, i?: RequestInit) => Promise<Response>
type Policy = { id: string; applies_to: string; source: string; table: string; kind: 'row' | 'deny' | 'mask'; predicate?: string | null; column?: string | null; note?: string | null }
const ERR = { color: '#b3261e', fontSize: 12.5, marginBottom: 10 }

export function AccessPoliciesPanel({ api, projectId }: { api: Api; projectId: string }) {
  const [list, setList] = useState<Policy[]>([])
  const [form, setForm] = useState({ applies_to: 'everyone', source: '', table: '', kind: 'row', predicate: '', column: '', note: '' })
  const [subject, setSubject] = useState('')
  const [attrs, setAttrs] = useState<Record<string, unknown> | null>(null)
  const [attr, setAttr] = useState({ key: '', value: '' })
  const [err, setErr] = useState('')
  const [domains, setDomains] = useState<{ domain: string; role_id: string; added_by: string }[]>([])
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

  return (
    <div className="card">
      <strong>Data access</strong>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 2, marginBottom: 10 }}>
        What each person or agent may read, applied to every table a query reads. A row filter names the table as <code className="mono">{'{t}'}</code> and
        may name a reader's attribute, e.g. <code className="mono">{'{t}.TripLocation IN {attr.branches}'}</code> — a reader without that attribute cannot read the table.
      </div>
      {err && <div style={ERR}>{err}</div>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <input id="pol-applies" className="input" style={{ maxWidth: 230 }} value={form.applies_to} onChange={(e) => setForm({ ...form, applies_to: e.target.value })} placeholder="everyone · role:viewer · email:a@b.c · agent:key_…" />
        <input id="pol-source" className="input" style={{ maxWidth: 140 }} value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} placeholder="Source (e.g. TOTALGROUP)" />
        <input id="pol-table" className="input" style={{ maxWidth: 200 }} value={form.table} onChange={(e) => setForm({ ...form, table: e.target.value })} placeholder="Table" />
        <select id="pol-kind" className="input" style={{ maxWidth: 120 }} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
          <option value="row">Row filter</option><option value="deny">Deny table</option><option value="mask">Mask column</option>
        </select>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {form.kind === 'row' && <input id="pol-predicate" className="input" style={{ flex: 1, minWidth: 260 }} value={form.predicate} onChange={(e) => setForm({ ...form, predicate: e.target.value })} placeholder="{t}.TripLocation IN {attr.branches}" />}
        {form.kind === 'mask' && <input id="pol-column" className="input" style={{ maxWidth: 200 }} value={form.column} onChange={(e) => setForm({ ...form, column: e.target.value })} placeholder="Column" />}
        <input id="pol-note" className="input" style={{ maxWidth: 220 }} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Why (optional)" />
        <button className="btn" onClick={add} disabled={!form.source.trim() || !form.table.trim()}>Add policy</button>
      </div>
      {!list.length ? <div className="muted" style={{ fontSize: 12.5, marginBottom: 14 }}>No policies: everyone with access to the project reads everything.</div> : (
        <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse', marginBottom: 16 }}>
          <thead><tr className="muted" style={{ textAlign: 'left' }}><th style={{ padding: '5px 6px' }}>Applies to</th><th>Source</th><th>Table</th><th>Rule</th><th /></tr></thead>
          <tbody>{list.map((p) => (
            <tr key={p.id} style={{ borderTop: '1px solid var(--hair, #e2e4e8)' }}>
              <td style={{ padding: 6 }}>{p.applies_to}</td><td>{p.source}</td><td className="mono" style={{ fontSize: 11.5 }}>{p.table}</td>
              <td className="mono" style={{ fontSize: 11.5 }}>{p.kind === 'row' ? p.predicate : p.kind === 'mask' ? `mask ${p.column}` : 'deny'}{p.note ? <span className="muted"> · {p.note}</span> : null}</td>
              <td style={{ textAlign: 'right' }}><button className="btn" onClick={() => remove(p.id)}>Remove</button></td>
            </tr>))}</tbody>
        </table>
      )}
      <strong style={{ fontSize: 13 }}>Sign-in by company domain</strong>
      <div className="muted" style={{ fontSize: 12, margin: '2px 0 8px' }}>Anyone whose verified address is at the domain (their company's sign-in, connected in Clerk) is let in with the role on first sign-in.</div>
      {domains.map((d) => <div key={d.domain} className="row" style={{ gap: 8, fontSize: 12.5, marginBottom: 4 }}><span className="mono">{d.domain}</span><span className="muted">→ {d.role_id} · added by {d.added_by}</span>
        <button className="btn" onClick={async () => { if (await say(await api(`${base}/access-domains/${d.domain}`, { method: 'DELETE' }))) loadDomains() }}>Remove</button></div>)}
      <div className="row" style={{ gap: 8, margin: '6px 0 16px' }}>
        <input id="dom-name" className="input" style={{ maxWidth: 200 }} value={dom.domain} onChange={(e) => setDom({ ...dom, domain: e.target.value })} placeholder="acme.com" />
        <select id="dom-role" className="input" style={{ maxWidth: 120 }} value={dom.roleId} onChange={(e) => setDom({ ...dom, roleId: e.target.value })}><option value="viewer">viewer</option><option value="member">member</option></select>
        <button className="btn" disabled={!dom.domain.trim()} onClick={async () => { if (await say(await api(`${base}/access-domains`, { method: 'POST', body: JSON.stringify({ domain: dom.domain.trim(), roleId: dom.roleId }) }))) { setDom({ domain: '', roleId: 'viewer' }); loadDomains() } }}>Let in</button>
      </div>
      <strong style={{ fontSize: 13 }}>A reader's attributes</strong>
      <div className="row" style={{ gap: 8, margin: '8px 0', flexWrap: 'wrap' }}>
        <input id="attr-subject" className="input" style={{ maxWidth: 280 }} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="email:a@b.c or agent:key_…" />
        <button className="btn" onClick={loadAttrs} disabled={!subject.trim()}>Show</button>
      </div>
      {attrs && (
        <div>
          {!Object.keys(attrs).length && <div className="muted" style={{ fontSize: 12.5 }}>No attributes.</div>}
          {Object.entries(attrs).map(([k, v]) => <div key={k} className="mono" style={{ fontSize: 12 }}>{k} = {JSON.stringify(v)} <a href="#" onClick={(e) => { e.preventDefault(); void setOne(k, true) }}>remove</a></div>)}
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <input id="attr-key" className="input" style={{ maxWidth: 160 }} value={attr.key} onChange={(e) => setAttr({ ...attr, key: e.target.value })} placeholder="branches" />
            <input id="attr-value" className="input" style={{ maxWidth: 260 }} value={attr.value} onChange={(e) => setAttr({ ...attr, value: e.target.value })} placeholder='["HYDERABAD"] or a single value' />
            <button className="btn" onClick={() => setOne(attr.key)} disabled={!attr.key.trim()}>Set</button>
          </div>
        </div>
      )}
    </div>
  )
}
