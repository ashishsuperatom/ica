// CONNECTIONS — the person's own connections and the project's shared ones, and connecting a new one: pick what to
// connect, fill the form its connector declares (secret fields are sent once, sealed, and never shown again). A shared
// connection is an admin's to make; anyone connects their own.

import { useCallback, useEffect, useState } from 'react'
import type { Connector } from '../../shared/connectors'
import './session.css'

type Conn = { id: string; connector: string; name: string; level: 'project' | 'user'; settings: Record<string, unknown>; runnable: boolean; created_by: string; runs: 'code' | 'api'; origin: 'platform' | 'engine' }

export default function Connections({ projectId, token }: { projectId: string; token: string | null }) {
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [list, setList] = useState<Conn[]>([])
  const [picked, setPicked] = useState<Connector | null>(null)
  const [name, setName] = useState('')
  const [level, setLevel] = useState<'project' | 'user'>('user')
  const [values, setValues] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')
  const api = useCallback((path: string, init: RequestInit = {}) => fetch(`/api/projects/${encodeURIComponent(projectId)}${path}`, { ...init, credentials: 'include', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } }), [projectId, token])
  const load = useCallback(() => {
    api('/connectors').then((r) => r.json()).then((d) => setConnectors((d as { connectors: Connector[] }).connectors ?? [])).catch(() => {})
    api('/connections').then((r) => r.json()).then((d) => setList((d as { connections: Conn[] }).connections ?? [])).catch(() => {})
  }, [api])
  useEffect(load, [load])

  const pick = (c: Connector) => { setPicked(c); setName(c.title); setLevel(c.levels.includes('user') ? 'user' : 'project'); setValues({}); setErr('') }
  const connect = async () => {
    if (!picked) return
    const r = await api('/connections', { method: 'POST', body: JSON.stringify({ connector: picked.id, name, level, values }) })
    const d = await r.json().catch(() => ({})) as { error?: string }
    if (!r.ok) { setErr(d.error ?? `Refused (${r.status}).`); return }
    setPicked(null); setValues({}); load()
  }
  const remove = async (id: string) => { const r = await api(`/connections/${id}`, { method: 'DELETE' }); if (!r.ok) setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? 'Refused.'); load() }

  return (
    <div className="sa-session">
      <header className="sa-session-head"><h1>Connections</h1></header>
      {err && <p className="sa-session-refused" role="alert">{err}</p>}
      {!list.length && <p className="sa-session-empty">No connections yet.</p>}
      {list.map((c) => (
        <div key={c.id} className="sa-block" style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
          <strong style={{ flex: 1 }}>{c.name}</strong>
          <span className="sa-session-empty">{connectors.find((x) => x.id === c.connector)?.title ?? c.connector} · {c.runs === 'code' ? 'code connector' : 'API connector'}{c.origin === 'engine' ? ' (on the engine)' : ''} · {c.level === 'project' ? 'shared by the project' : 'yours'}{c.runnable ? '' : c.origin === 'engine' ? ' · not connected now' : ' · saved, not yet runnable'}</span>
          {c.origin === 'platform' && <button type="button" className="sa-session-action" onClick={() => remove(c.id)}>Remove</button>}
        </div>
      ))}
      <h2 style={{ fontSize: 15, margin: '24px 0 8px' }}>Connect</h2>
      {!picked ? (
        <div className="sa-session-actions">{connectors.map((c) => <button key={c.id} type="button" className="sa-session-action" title={c.description} onClick={() => pick(c)}>{c.title}</button>)}</div>
      ) : (
        <form className="sa-thread-block" onSubmit={(e) => { e.preventDefault(); void connect() }} style={{ display: 'grid', gap: 10, maxWidth: 520 }}>
          <p className="sa-session-empty">{picked.description}</p>
          <label>Name <input id="con-name" className="sa-session-action" style={{ width: '100%' }} value={name} onChange={(e) => setName(e.target.value)} /></label>
          {picked.levels.length > 1 && (
            <label>Who uses it <select id="con-level" className="sa-session-action" value={level} onChange={(e) => setLevel(e.target.value as 'project' | 'user')}>
              <option value="user">Only me</option><option value="project">Everyone in the project (admins)</option></select></label>
          )}
          {picked.fields.map((f) => (
            <label key={f.name}>{f.label}{f.required ? ' *' : ''}
              {f.type === 'select'
                ? <select id={`con-${f.name}`} className="sa-session-action" value={values[f.name] ?? ''} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}><option value="" />{f.options?.map((o) => <option key={o}>{o}</option>)}</select>
                : f.type === 'textarea' || (f.type === 'secret' && /key/i.test(f.label))
                  ? <textarea id={`con-${f.name}`} className="sa-session-action" style={{ width: '100%', minHeight: 80 }} value={values[f.name] ?? ''} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
                  : <input id={`con-${f.name}`} className="sa-session-action" style={{ width: '100%' }} type={f.type === 'secret' ? 'password' : f.type === 'number' ? 'number' : 'text'} placeholder={f.placeholder} value={values[f.name] ?? ''} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />}
              {f.help && <span className="sa-session-empty" style={{ display: 'block' }}>{f.help}</span>}
            </label>
          ))}
          <div className="sa-session-actions"><button type="submit" className="sa-session-action">Connect</button><button type="button" className="sa-session-action" onClick={() => setPicked(null)}>Cancel</button></div>
        </form>
      )}
    </div>
  )
}
