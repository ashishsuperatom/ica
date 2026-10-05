// ── Agent keys and the audit history, for one project ───────────────────────────────────────────────────────────────
// A key lets an agent — any system, our own CLI among them — work with this project within the scopes given here. It is
// shown once, when made; only its hash is kept. Revoking is final and ends the key's open connections at once.
// The audit history beside it is everything that happened in the project: who asked what, who changed what, refusals.
// Drawn only with the semantic components (@superatom/ui); no CSS of its own.
import { useCallback, useEffect, useState } from 'react'
import { Section, Form, Field, Choices, RecordList, Notice, Status, Code, Toolbar, Icon } from '@superatom/ui'
import { AGENT_SCOPES, scopeCapabilities, type AgentScope } from '../../shared/agent-scopes'

type Api = (p: string, i?: RequestInit) => Promise<Response>
type Key = { id: string; name: string; prefix: string; scopes: string[]; created_by: string; created_at: string; expires_at: string | null; revoked_at: string | null; revoked_by: string | null; last_used_at: string | null }
type Event = { id: string; at: string; actor: { kind: string; id: string; email?: string }; via: string; action: string; target?: string; outcome: string; detail?: Record<string, unknown> }

const SCOPE_TEXT: Record<AgentScope, string> = { sessions: 'Agents and their sessions: open, change, read', ask: 'Ask questions in words', graph: 'Knowledge: read it, make and change its own concepts and domains, suggest changes', programs: 'Programs: build from source, list, publish its own', decisions: 'Decisions: the paths from a step, record how a step turned out, read decision states', learn: 'Learning: change decision states through their named operations', warehouse: 'Warehouse: the tables and columns this project was granted, and SQL over them', publish: 'Publishing: make concepts, domains, agents and programs seen by everyone; decide suggestions', 'warehouse-write': 'Warehouse writing: append rows to the tables this project may write', connectors: 'Connections: read other systems, run their actions (changes wait for a person), code mode' }
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
const whenFull = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : '')

export function AgentKeysPanel({ api, projectId }: { api: Api; projectId: string }) {
  const [keys, setKeys] = useState<Key[] | null>(null)
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
  // What the person making a key holds here: a scope is offered only to someone who holds what it gives.
  const [held, setHeld] = useState<string[] | null>(null)
  useEffect(() => { api(`/projects/${projectId}/me`).then((r) => (r.ok ? r.json() : null)).then((d) => setHeld(((d as { capabilities?: string[] } | null)?.capabilities) ?? [])).catch(() => setHeld([])) }, [api, projectId])
  const lacks = (s: AgentScope) => (held ? scopeCapabilities(s).filter((c) => !held.includes(c)) : [])

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
  const ready = !!name.trim() && !!scopes.length

  return (
    <div className="sa-stack sa-stack--4">
      {err && <Notice state="critical">{err}</Notice>}

      {made && (
        <Notice state="attention" action={
          <span className="sa-row sa-row--tight">
            <button type="button" className="sa-btn sa-btn--primary" onClick={() => { void navigator.clipboard.writeText(made.key).then(() => setCopied(true)) }}>
              <Icon icon={copied ? 'lucide:check' : 'lucide:copy'} className="sa-btn__icon" />{copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" className="sa-btn" onClick={() => setMade(null)}>Done</button>
          </span>
        }>
          <div className="sa-stack">
            <span><strong>Copy the key for “{made.name}” now.</strong> It will not be shown again.</span>
            <Code>{made.key}</Code>
          </div>
        </Notice>
      )}

      <Section icon="lucide:key-round" title="Make an agent key" subtitle="Let an agent work with this project within the scopes you give it">
        <Form onSubmit={() => { if (ready) void create() }}
          actions={<button className="sa-btn sa-btn--primary" disabled={!ready}>Make key</button>}>
          <Field label="What it is for" help={<>Codex, Claude, any system, or the Superatom CLI (<Code>printf %s "$KEY" | sacli login</Code>). Everything it does is in the audit history.</>}>
            <input id="agent-key-name" className="sa-input" placeholder="ci bot" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Expires">
            <select id="agent-key-days" className="sa-input" value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="7">In 7 days</option><option value="30">In 30 days</option><option value="90">In 90 days</option><option value="365">In a year</option><option value="never">Never</option>
            </select>
          </Field>
          <Choices label="Scopes">
            {(Object.keys(AGENT_SCOPES) as AgentScope[]).map((s) => {
              const missing = lacks(s)
              return (
                <label key={s} title={missing.length ? `Needs ${missing.join(', ')}, which your role here does not hold` : undefined} data-disabled={missing.length > 0}>
                  <input type="checkbox" disabled={missing.length > 0} checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} />
                  <span><strong>{s}</strong> — {SCOPE_TEXT[s]}{missing.length > 0 && <span className="sa-muted"> (needs {missing.join(', ')})</span>}</span>
                </label>
              )
            })}
          </Choices>
        </Form>
      </Section>

      <Section icon="lucide:key-square" title="Agent keys" note={(keys ?? []).length ? `${(keys ?? []).length}` : undefined}>
        <RecordList rows={keys} keyOf={(k) => k.id} empty="No agent keys yet. A key you make appears here; only its prefix is kept on view."
          columns={[
            { key: 'name', label: 'Name', render: (k) => <strong title={k.name}>{k.name}</strong> },
            { key: 'scopes', label: 'Scopes', render: (k) => k.scopes.join(', ') },
            { key: 'by', label: 'Made by', render: (k) => <span title={k.created_by}>{k.created_by}</span> },
            { key: 'made', label: 'Made', render: (k) => <span title={whenFull(k.created_at)}>{when(k.created_at)}</span> },
            { key: 'used', label: 'Last used', render: (k) => <span className="sa-muted" title={whenFull(k.last_used_at)}>{when(k.last_used_at)}</span> },
            { key: 'expires', label: 'Expires', render: (k) => k.revoked_at
              ? <span className="sa-row sa-row--tight" title={`Revoked ${whenFull(k.revoked_at)} by ${k.revoked_by}`}><Status state="critical">Revoked</Status><span className="sa-muted">{when(k.revoked_at)}</span></span>
              : <span className="sa-muted" title={whenFull(k.expires_at)}>{k.expires_at ? when(k.expires_at) : 'Never'}</span> },
            { key: 'prefix', label: 'Key', render: (k) => <Code>{k.prefix.slice(-10)}…</Code> },
            { key: 'revoke', label: '', align: 'end', render: (k) => k.revoked_at ? null : revoking?.id === k.id
              ? <span className="sa-row sa-row--tight"><span>Revoke for good?</span><button type="button" className="sa-btn sa-btn--danger sa-btn--primary" onClick={() => void revoke(k)}>Revoke</button><button type="button" className="sa-btn sa-btn--link" onClick={() => setRevoking(null)}>Keep</button></span>
              : <button type="button" className="sa-btn sa-btn--link" onClick={() => setRevoking(k)}>Revoke…</button> },
          ]} />
      </Section>
    </div>
  )
}

export function AuditPanel({ api, projectId }: { api: Api; projectId: string }) {
  const [events, setEvents] = useState<Event[] | null>(null)
  const [action, setAction] = useState('')
  const [actor, setActor] = useState('')
  const [err, setErr] = useState('')
  const load = useCallback((before?: string) => {
    const q = new URLSearchParams({ limit: '100', ...(action ? { action } : {}), ...(actor ? { actor } : {}), ...(before ? { before } : {}) })
    api(`/projects/${projectId}/audit?${q}`).then(async (r) => {
      if (!r.ok) { setErr(`The history could not be read (${r.status}).`); return }
      const d = await r.json() as { events: Event[] }
      setErr(''); const got = Array.isArray(d.events) ? d.events : []; setEvents((prev) => (before ? [...(prev ?? []), ...got] : got))
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
    <Section icon="lucide:scroll-text" title="Audit history" subtitle="Everything that happened in this project, newest first. It cannot be changed."
      footer={(events ?? []).length >= 100 ? <button type="button" className="sa-btn" onClick={() => load((events ?? [])[(events ?? []).length - 1].at)}>Older</button> : undefined}>
      <div className="sa-section__body sa-stack">
        <Toolbar>
          <input id="audit-action" className="sa-input" placeholder="Action (question, agent-key…)" aria-label="Action" value={action} onChange={(e) => setAction(e.target.value.trim())} />
          <input id="audit-actor" className="sa-input" placeholder="Who (user id or agent:key_…)" aria-label="Who" value={actor} onChange={(e) => setActor(e.target.value.trim())} />
        </Toolbar>
        {err && <Notice state="critical">{err}</Notice>}
      </div>
      {(!err || !!(events ?? []).length) && (
        <RecordList rows={events} keyOf={(e) => e.id} empty="Nothing recorded yet. Who asks or changes anything here appears in this list."
          columns={[
            { key: 'at', label: 'When', render: (e) => <span className="sa-muted">{when(e.at)}</span> },
            { key: 'who', label: 'Who', render: (e) => e.actor.email ?? e.actor.id },
            { key: 'via', label: 'Via', render: (e) => <span className="sa-muted">{e.via}</span> },
            { key: 'action', label: 'Action', render: (e) => <Code>{e.action}</Code> },
            { key: 'what', label: 'What', render: (e) => { const w = what(e); return <span title={e.target ? `${w} · ${e.target}` : w}>{w}{e.target ? <span className="sa-muted"> · {e.target}</span> : null}</span> } },
            { key: 'outcome', label: 'Outcome', render: (e) => <Status state={e.outcome === 'ok' ? 'ok' : 'critical'}>{e.outcome}</Status> },
          ]} />
      )}
    </Section>
  )
}
