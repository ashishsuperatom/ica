// ── Agent keys and the audit history, for one project ───────────────────────────────────────────────────────────────
// A key lets an agent — any system, our own CLI among them — work with this project within the scopes given here. It is
// shown once, when made; only its hash is kept. Revoking is final and ends the key's open connections at once.
// The audit history beside it is everything that happened in the project: who asked what, who changed what, refusals.
import React, { useCallback, useEffect, useState } from 'react'
import { AGENT_SCOPES, type AgentScope } from '../../shared/agent-scopes'

type Api = (p: string, i?: RequestInit) => Promise<Response>
type Key = { id: string; name: string; prefix: string; scopes: string[]; created_by: string; created_at: string; expires_at: string | null; revoked_at: string | null; revoked_by: string | null; last_used_at: string | null }
type Event = { id: string; at: string; actor: { kind: string; id: string; email?: string }; via: string; action: string; target?: string; outcome: string; detail?: Record<string, unknown> }

const SCOPE_TEXT: Record<AgentScope, string> = { sessions: 'Agents and their sessions: open, change, read', ask: 'Ask questions in words', graph: 'Knowledge: read it, make and change its own concepts and domains, suggest changes' }
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : '—')
const ERR = { color: '#b3261e', fontSize: 12.5, marginBottom: 10 }

export function AgentKeysPanel({ api, projectId }: { api: Api; projectId: string }) {
  const [keys, setKeys] = useState<Key[]>([])
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<AgentScope[]>(['sessions'])
  const [days, setDays] = useState('90')
  const [made, setMade] = useState<{ key: string; name: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [revoking, setRevoking] = useState<Key | null>(null)
  const [err, setErr] = useState('')

  const load = useCallback(() => {
    api(`/projects/${projectId}/agent-keys`).then((r) => (r.ok ? r.json() : { keys: [] })).then((d) => setKeys((d as { keys?: Key[] }).keys ?? [])).catch(() => {})
  }, [api, projectId])
  useEffect(load, [load])

  const create = async () => {
    setErr(''); setMade(null); setCopied(false)
    const expiresAt = days === 'never' ? null : new Date(Date.now() + Number(days) * 86_400_000).toISOString()
    const r = await api(`/projects/${projectId}/agent-keys`, { method: 'POST', body: JSON.stringify({ name: name.trim(), scopes, expiresAt }) })
    const body = await r.json().catch(() => ({})) as { key?: string; error?: string }
    if (!r.ok || !body.key) { setErr(body.error ?? `The key could not be made (${r.status}).`); return }
    setMade({ key: body.key, name: name.trim() }); setName(''); load()
  }
  const revoke = async (k: Key) => {
    const r = await api(`/projects/${projectId}/agent-keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' })
    if (!r.ok) setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Revoking failed (${r.status}).`)
    setRevoking(null); load()
  }

  return (
    <div className="card">
      <strong>Agent keys</strong>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 2, marginBottom: 10 }}>
        A key lets an agent work with this project within its scopes — Codex, Claude, any system, or the Superatom CLI
        (<code className="mono">printf %s "$KEY" | sacli login</code>). Everything it does is in the audit history.
      </div>

      <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <input id="agent-key-name" className="input" style={{ maxWidth: 240 }} placeholder="What it is for (e.g. ci bot)" value={name} onChange={(e) => setName(e.target.value)} />
        <select id="agent-key-days" className="input" style={{ maxWidth: 150 }} value={days} onChange={(e) => setDays(e.target.value)}>
          <option value="7">Expires in 7 days</option><option value="30">Expires in 30 days</option><option value="90">Expires in 90 days</option><option value="365">Expires in a year</option><option value="never">Never expires</option>
        </select>
        <button className="btn" onClick={create} disabled={!name.trim() || !scopes.length}>Make key</button>
      </div>
      <div className="row" style={{ gap: 14, marginBottom: 12, flexWrap: 'wrap' }}>
        {(Object.keys(AGENT_SCOPES) as AgentScope[]).map((s) => (
          <label key={s} style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} />
            <span><strong>{s}</strong> — {SCOPE_TEXT[s]}</span>
          </label>
        ))}
      </div>
      {err && <div style={ERR}>{err}</div>}

      {made && (
        <div style={{ border: '1px solid #e8c16b', background: '#fff8e6', borderRadius: 6, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12.5, marginBottom: 6 }}><strong>Copy the key for “{made.name}” now.</strong> It will not be shown again.</div>
          <div className="row" style={{ gap: 8 }}>
            <code className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all', flex: 1 }}>{made.key}</code>
            <button className="btn" onClick={() => { void navigator.clipboard.writeText(made.key).then(() => setCopied(true)) }}>{copied ? 'Copied' : 'Copy'}</button>
            <button className="btn" onClick={() => setMade(null)}>Done</button>
          </div>
        </div>
      )}

      {!keys.length && <div className="muted" style={{ fontSize: 12.5 }}>No agent keys yet.</div>}
      {!!keys.length && (
        <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
          <thead><tr className="muted" style={{ textAlign: 'left' }}><th style={{ padding: '5px 6px' }}>Name</th><th>Scopes</th><th>Made</th><th>Last used</th><th>Expires</th><th>Key</th><th /></tr></thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} style={{ borderTop: '1px solid var(--hair, #e2e4e8)', opacity: k.revoked_at ? 0.55 : 1 }}>
                <td style={{ padding: '6px' }}><strong>{k.name}</strong></td>
                <td>{k.scopes.join(', ')}</td>
                <td className="muted">{when(k.created_at)}<br />{k.created_by}</td>
                <td className="muted">{when(k.last_used_at)}</td>
                <td className="muted">{k.revoked_at ? `revoked ${when(k.revoked_at)} by ${k.revoked_by}` : k.expires_at ? when(k.expires_at) : 'never'}</td>
                <td className="mono muted" style={{ fontSize: 11 }}>{k.prefix}…</td>
                <td style={{ textAlign: 'right' }}>
                  {!k.revoked_at && (revoking?.id === k.id
                    ? <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}><span style={{ fontSize: 12 }}>Revoke for good?</span><button className="btn" style={{ color: '#b3261e' }} onClick={() => revoke(k)}>Revoke</button><button className="btn" onClick={() => setRevoking(null)}>Keep</button></span>
                    : <button className="btn" onClick={() => setRevoking(k)}>Revoke…</button>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function AuditPanel({ api, projectId }: { api: Api; projectId: string }) {
  const [events, setEvents] = useState<Event[]>([])
  const [action, setAction] = useState('')
  const [actor, setActor] = useState('')
  const [err, setErr] = useState('')
  const load = useCallback((before?: string) => {
    const q = new URLSearchParams({ limit: '100', ...(action ? { action } : {}), ...(actor ? { actor } : {}), ...(before ? { before } : {}) })
    api(`/projects/${projectId}/audit?${q}`).then(async (r) => {
      if (!r.ok) { setErr(`The history could not be read (${r.status}).`); return }
      const d = await r.json() as { events: Event[] }
      setErr(''); setEvents((prev) => (before ? [...prev, ...d.events] : d.events))
    }).catch(() => setErr('The history could not be read.'))
  }, [api, projectId, action, actor])
  useEffect(() => load(), [load])
  const what = (e: Event) => {
    const d = e.detail ?? {}
    if (typeof d.question === 'string') return `“${d.question}”`
    if (Array.isArray(d.ops)) return (d.ops as { op: string; path: string; value?: unknown }[]).map((o) => `${o.op} ${o.path}${o.value !== undefined ? ` = ${JSON.stringify(o.value)}` : ''}`).join('; ')
    if (typeof d.reason === 'string') return d.reason
    if (typeof d.name === 'string') return d.name
    return ''
  }
  return (
    <div className="card">
      <strong>Audit history</strong>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 2, marginBottom: 10 }}>Everything that happened in this project, newest first: who asked what, who changed what, and what was refused. It cannot be changed.</div>
      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <input id="audit-action" className="input" style={{ maxWidth: 220 }} placeholder="Action (e.g. question, agent-key)" value={action} onChange={(e) => setAction(e.target.value.trim())} />
        <input id="audit-actor" className="input" style={{ maxWidth: 260 }} placeholder="Who (user id or agent:key_…)" value={actor} onChange={(e) => setActor(e.target.value.trim())} />
      </div>
      {err && <div style={ERR}>{err}</div>}
      {!events.length && !err && <div className="muted" style={{ fontSize: 12.5 }}>Nothing recorded yet.</div>}
      {!!events.length && (
        <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
          <thead><tr className="muted" style={{ textAlign: 'left' }}><th style={{ padding: '5px 6px' }}>When</th><th>Who</th><th>Via</th><th>Action</th><th>What</th><th>Outcome</th></tr></thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} style={{ borderTop: '1px solid var(--hair, #e2e4e8)' }}>
                <td className="muted" style={{ padding: '5px 6px', whiteSpace: 'nowrap' }}>{when(e.at)}</td>
                <td>{e.actor.email ?? e.actor.id}</td>
                <td className="muted">{e.via}</td>
                <td className="mono" style={{ fontSize: 11.5 }}>{e.action}</td>
                <td style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis' }}>{what(e)}{e.target ? <span className="muted"> · {e.target}</span> : null}</td>
                <td style={{ color: e.outcome === 'ok' ? undefined : '#b3261e' }}>{e.outcome}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {events.length >= 100 && <button className="btn" style={{ marginTop: 10 }} onClick={() => load(events[events.length - 1].at)}>Older</button>}
    </div>
  )
}
