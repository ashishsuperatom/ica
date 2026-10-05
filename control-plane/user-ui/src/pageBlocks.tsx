// THE USER UI'S OWN BLOCKS — what used to be pages, as blocks of a thread kept in the browser (LocalThread): home, the
// agents a person sees, making an agent (a form that locks when sent and leaves its receipt), activity, connections.
// Each click opens a block below; each block is drawn in the platform's frame with the design system's primitives.

import { createContext, useContext, useEffect, useState } from 'react'
import { Section, notify, useThread, Form, Field, Choices, Receipt, RecordList, Status, ActionBar, Empty, type Registry } from '@superatom/ui'
import type { Connector } from '../../shared/connectors'

type Request = (payload: Record<string, unknown>, onProgress?: (m: any) => void) => Promise<any>
export interface PagesEnv {
  request: Request
  subscribeLive: (fn: (m: any) => void) => () => void
  projectId: string
  token?: string | null
  scopes: string[]
  agents: { id: string; name: string }[]
  sessions: { session: string; agent: string; title: string; updated?: string }[]
  /** Go to a session, or start one with an agent (s/<agent>). */
  go: (path: string) => void
}
export const PagesContext = createContext<PagesEnv | null>(null)
const useEnv = () => { const e = useContext(PagesContext); if (!e) throw new Error('page blocks need their environment'); return e }
const newId = () => `ses-${crypto.randomUUID()}`
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '')

function Home() {
  const env = useEnv()
  const { open } = useThread()
  const [asking, setAsking] = useState('')
  const [beats, setBeats] = useState<string[]>([])
  const agentName = (id: string) => env.agents.find((a) => a.id === id)?.name ?? id
  const ask = async (text: string) => {
    const t = text.trim(); if (!t || asking) return
    const sid = newId()
    setAsking(t); setBeats(['Finding the agent for this question…'])
    const m = await env.request({ t: 'session:start', session: sid, text: t, kind: 'language' }, (p) => { if (p?.t === 'narration' && p.text) setBeats((b) => [...b, String(p.text)]) })
    setAsking(''); setBeats([])
    if (m?.t === 'session:view') env.go(sid); else notify(m?.reason ?? 'The question could not be asked', 'refused')
  }
  return (<>
    <form className="sa-askbar__form" onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget.elements.namedItem('q') as HTMLInputElement; void ask(f.value) }}>
      <div className="sa-askbar__field">
        <input id="sa-ask-anything" name="q" className="sa-askbar__input" placeholder={asking ? 'Working…' : 'Ask anything — the agent that knows answers'} disabled={!!asking} autoComplete="off" />
        <button className="sa-btn sa-btn--primary" disabled={!!asking}>Ask</button>
      </div>
    </form>
    {asking && <div className="sa-askbar__working"><span className="sa-label">Working on: {asking}</span>{beats.slice(-3).map((b, i) => <div key={i} className="sa-note">{b}</div>)}</div>}
    <Section icon="lucide:bot" title="Agents" subtitle="Each knows one part of the organisation and the programs that work on it."
      actions={<button className="sa-btn" onClick={() => open('agents', {}, 'Looked at the agents')}>Manage</button>}>
      {env.agents.length === 0 ? <Empty>No agents you can see yet.</Empty> : (
        <div className="sa-sub-grid">{env.agents.map((a) => <button key={a.id} className="sa-sub-card" onClick={() => env.go(`s/${a.id}`)}><span className="sa-sub-card__title">{a.name}</span><span className="sa-sub-card__text">Start a session</span></button>)}</div>
      )}
    </Section>
    {env.sessions.length > 0 && (
      <Section icon="lucide:history" title="Your sessions" subtitle="Pick up where you left off.">
        <div className="sa-sub-grid">{env.sessions.slice(0, 12).map((s) => <button key={s.session} className="sa-sub-card" onClick={() => env.go(s.session)}><span className="sa-sub-card__title">{s.title || agentName(s.agent)}</span><span className="sa-sub-card__text">{agentName(s.agent)}{s.updated ? ` · ${when(s.updated)}` : ''}</span></button>)}</div>
      </Section>
    )}
  </>)
}

function AgentsBlock() {
  const env = useEnv()
  const { open } = useThread()
  const [agents, setAgents] = useState<{ id: string; name: string; scope: string; isDefault?: boolean }[]>([])
  useEffect(() => { void env.request({ t: 'session:agents' }).then((r) => setAgents(r.agents ?? [])) }, [env.request])
  const publish = async (a: { id: string; name: string }) => {
    const r = await env.request({ t: 'graph:publish', name: a.id, scope: 'global', reason: 'ready for everyone in the project' })
    notify(r.t === 'graph:reply' ? `Asked to publish ${a.name} — an administrator decides` : r.reason ?? 'Could not ask to publish it', r.t === 'graph:reply' ? 'note' : 'refused')
  }
  return (
    <Section icon="lucide:bot" title={`${agents.length} agents you can see`} subtitle="Open one to start a session, or make a new one."
      actions={<button className="sa-btn sa-btn--primary" onClick={() => open('agent-new', {}, 'Making an agent')}>New agent</button>}>
      <RecordList rows={agents} keyOf={(a) => a.id} empty="No agents you can see yet." onRow={(a) => env.go(`s/${a.id}`)} columns={[
        { key: 'name', label: 'Agent', render: (a) => <>{a.name}{a.isDefault ? <> <Status state="neutral">default</Status></> : null}</> },
        { key: 'scope', label: 'Who sees it', render: (a) => (!a.scope || a.scope === 'global' ? 'Everyone in the project' : a.scope.startsWith('group:') ? `The ${a.scope.slice(6)} group` : 'Only its owner') },
        { key: 'publish', label: '', align: 'end', render: (a) => (a.scope && a.scope !== 'global' ? <button className="sa-btn sa-btn--link" onClick={(e) => { e.stopPropagation(); void publish(a) }}>Publish to everyone</button> : null) },
      ]} />
    </Section>
  )
}

/** Making an agent: a form that locks when sent and opens its receipt below. */
function AgentNew() {
  const env = useEnv()
  const { props, update, open } = useThread()
  const sent = !!props.sent
  const [domains, setDomains] = useState<string[]>([])
  const [programs, setPrograms] = useState<{ name: string; published_at: string | null }[]>([])
  const [f, setF] = useState({ title: String(props.title ?? ''), domain: String(props.domain ?? ''), programs: (props.programs as string[]) ?? [], scope: String(props.scope ?? 'global') })
  const [err, setErr] = useState('')
  useEffect(() => {
    void env.request({ t: 'graph:domains' }).then((r) => setDomains((r.domains ?? []).map((d: any) => d.name)))
    void env.request({ t: 'program:list' }).then((r) => setPrograms(Object.values(Object.fromEntries((r.programs ?? []).map((p: any) => [p.name, p]))) as any))
  }, [env.request])
  const send = async () => {
    setErr('')
    const name = f.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    const r = await env.request({ t: 'graph:agent', name, scope: f.scope, body: { title: f.title.trim(), domain: f.domain, programs: f.programs, ica: 'composer' }, reason: 'made in the user UI' })
    if (r.t !== 'graph:reply') { setErr(r.reason ?? 'The agent could not be made.'); return }
    update({ ...f, sent: true })
    open('agent-made', { id: name, title: f.title.trim(), domain: f.domain, programs: f.programs, scope: f.scope }, `Made ${f.title.trim()}`)
  }
  return (
    <Form onSubmit={() => void send()} locked={sent} error={err} actions={<button className="sa-btn sa-btn--primary" disabled={!f.title.trim() || !f.domain}>Make the agent</button>}>
      <Field label="Title"><input id="ag-title" className="sa-input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Unsettled trips" required /></Field>
      <Field label="Answers from (its domain of knowledge)">
        <select id="ag-domain" className="sa-input" value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} required><option value="" />{domains.map((d) => <option key={d}>{d}</option>)}</select></Field>
      <Choices label="Programs it may run" help={programs.length ? undefined : 'No programs yet.'}>
        {programs.map((p) => <label key={p.name}><input type="checkbox" checked={f.programs.includes(p.name)} onChange={(e) => setF({ ...f, programs: e.target.checked ? [...f.programs, p.name] : f.programs.filter((x) => x !== p.name) })} /> {p.name}{p.published_at ? '' : ' (draft)'}</label>)}
      </Choices>
      <Field label="Who sees it" help="Everyone else asks for it to be published; an administrator decides.">
        <select id="ag-scope" className="sa-input" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}>
          <option value="global">Everyone in the project</option>
          {env.scopes.filter((x) => x.startsWith('group:')).map((g) => <option key={g} value={g}>The {g.slice(6)} group</option>)}
          {env.scopes.filter((x) => x.startsWith('user:')).map((u) => <option key={u} value={u}>Only me</option>)}
        </select></Field>
    </Form>
  )
}

function AgentMade() {
  const env = useEnv()
  const { props } = useThread()
  return (<>
    <Receipt items={[['Agent', String(props.title)], ['Answers from', String(props.domain)], ['Programs', ((props.programs as string[]) ?? []).join(', ') || 'none — it answers in words'], ['Who sees it', props.scope === 'global' ? 'Everyone in the project' : String(props.scope)]]} />
    <ActionBar><button className="sa-btn sa-btn--primary" onClick={() => env.go(`s/${String(props.id)}`)}>Start a session with it</button></ActionBar>
  </>)
}

function ActivityBlock() {
  const env = useEnv()
  const [rows, setRows] = useState<any[]>([])
  useEffect(() => { void env.request({ t: 'activity:list' }).then((r) => setRows(r.activities ?? [])) }, [env.request])
  useEffect(() => env.subscribeLive((m) => { if (m.t === 'activity' && m.activity?.id) setRows((prev) => [m.activity, ...prev.filter((x) => x.id !== m.activity.id)].slice(0, 100)) }), [env.subscribeLive])
  return (
    <Section icon="lucide:activity" title="Running for you, and lately" subtitle="Program builds and session runs; kept current as they change.">
      <RecordList rows={rows} keyOf={(a) => a.id} empty="Nothing running, and nothing in the last day." columns={[
        { key: 'state', label: 'State', render: (a) => <Status state={a.state === 'failed' ? 'critical' : a.state === 'running' ? 'running' : 'ok'}>{a.state}</Status> },
        { key: 'title', label: 'What', wrap: true, render: (a) => <>{a.title}{a.progress || a.detail ? ` — ${a.progress ?? a.detail}` : ''}</> },
        { key: 'when', label: 'When', align: 'end', render: (a) => when(a.updated_at ?? a.updatedAt) },
      ]} />
    </Section>
  )
}

type Conn = { id: string; connector: string; name: string; level: 'project' | 'user'; runnable: boolean; runs: 'code' | 'api'; origin: 'platform' | 'engine' }
const useApi = () => {
  const env = useEnv()
  return (path: string, init: RequestInit = {}) => fetch(`/api/projects/${encodeURIComponent(env.projectId)}${path}`, { ...init, credentials: 'include', headers: { 'content-type': 'application/json', ...(env.token ? { authorization: `Bearer ${env.token}` } : {}) } })
}

function ConnectionsBlock() {
  const api = useApi()
  const { open } = useThread()
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [list, setList] = useState<Conn[]>([])
  const load = () => {
    api('/connectors').then((r) => r.json()).then((d: any) => setConnectors(d.connectors ?? [])).catch(() => {})
    api('/connections').then((r) => r.json()).then((d: any) => setList(d.connections ?? [])).catch(() => {})
  }
  useEffect(load, [])   // eslint-disable-line react-hooks/exhaustive-deps
  const remove = async (id: string) => { const r = await api(`/connections/${id}`, { method: 'DELETE' }); if (!r.ok) notify(((await r.json().catch(() => ({}))) as any).error ?? 'Refused', 'refused'); load() }
  return (<>
    <Section icon="lucide:plug" title={`${list.length} connections`} subtitle="Yours and the project's shared ones. A secret is sent once, sealed, and never shown again.">
      <RecordList rows={list} keyOf={(c) => c.id} empty="No connections yet." columns={[
        { key: 'name', label: 'Name' },
        { key: 'what', label: 'What', render: (c) => `${connectors.find((x) => x.id === c.connector)?.title ?? c.connector} · ${c.runs === 'code' ? 'code' : 'API'}${c.origin === 'engine' ? ' (on the engine)' : ''}` },
        { key: 'state', label: 'State', render: (c) => <Status state={c.runnable ? 'ok' : 'attention'}>{c.runnable ? 'connected' : 'not runnable yet'}</Status> },
        { key: 'level', label: 'Who uses it', render: (c) => (c.level === 'project' ? 'the project' : 'you') },
        { key: 'remove', label: '', align: 'end', render: (c) => (c.origin === 'platform' ? <button className="sa-btn sa-btn--link" onClick={() => void remove(c.id)}>Remove</button> : null) },
      ]} />
    </Section>
    <Section icon="lucide:plus" title="Connect" subtitle="Pick what to connect.">
      <ActionBar>{connectors.map((c) => <button key={c.id} className="sa-btn" title={c.description} onClick={() => open('connection-new', { connector: c.id }, `Connecting ${c.title}`)}>{c.title}</button>)}</ActionBar>
    </Section>
  </>)
}

function ConnectionNew() {
  const api = useApi()
  const { props, update, open } = useThread()
  const sent = !!props.sent
  const [c, setC] = useState<Connector | null>(null)
  const [name, setName] = useState(String(props.name ?? ''))
  const [level, setLevel] = useState<'project' | 'user'>((props.level as any) ?? 'user')
  const [values, setValues] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')
  useEffect(() => { api('/connectors').then((r) => r.json()).then((d: any) => { const x = (d.connectors ?? []).find((k: Connector) => k.id === props.connector) ?? null; setC(x); if (x && !name) { setName(x.title); setLevel(x.levels.includes('user') ? 'user' : 'project') } }).catch(() => {}) }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return <Empty>Reading the connector…</Empty>
  const connect = async () => {
    const r = await api('/connections', { method: 'POST', body: JSON.stringify({ connector: c.id, name, level, values }) })
    const d = await r.json().catch(() => ({})) as { error?: string; connection?: { id: string } }
    if (!r.ok) { setErr(d.error ?? `Refused (${r.status}).`); return }
    update({ sent: true, name, level })   // the secret values are never kept in the thread
    open('connection-made', { title: c.title, name, level }, `Connected ${name}`)
  }
  return (
    <Form onSubmit={() => void connect()} locked={sent} error={err} actions={<button className="sa-btn sa-btn--primary">Connect</button>}>
      <Field label="What" help={c.description}><span>{c.title}</span></Field>
      <Field label="Name"><input id="con-name" className="sa-input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      {c.levels.length > 1 && <Field label="Who uses it">
        <select id="con-level" className="sa-input" value={level} onChange={(e) => setLevel(e.target.value as 'project' | 'user')}><option value="user">Only me</option><option value="project">Everyone in the project (admins)</option></select></Field>}
      {!sent && c.fields.map((fd) => (
        <Field key={fd.name} label={`${fd.label}${fd.required ? ' *' : ''}`} help={fd.help}>
          {fd.type === 'select'
            ? <select id={`con-${fd.name}`} className="sa-input" value={values[fd.name] ?? ''} onChange={(e) => setValues({ ...values, [fd.name]: e.target.value })}><option value="" />{fd.options?.map((o) => <option key={o}>{o}</option>)}</select>
            : fd.type === 'textarea' || (fd.type === 'secret' && /key/i.test(fd.label))
              ? <textarea id={`con-${fd.name}`} className="sa-input" rows={4} value={values[fd.name] ?? ''} onChange={(e) => setValues({ ...values, [fd.name]: e.target.value })} />
              : <input id={`con-${fd.name}`} className="sa-input" type={fd.type === 'secret' ? 'password' : fd.type === 'number' ? 'number' : 'text'} placeholder={fd.placeholder} value={values[fd.name] ?? ''} onChange={(e) => setValues({ ...values, [fd.name]: e.target.value })} />}
        </Field>
      ))}
    </Form>
  )
}

function ConnectionMade() {
  const { props } = useThread()
  return <Receipt items={[['Connected', String(props.name)], ['What', String(props.title)], ['Who uses it', props.level === 'project' ? 'Everyone in the project' : 'Only you'], ['Its secrets', "Sealed with the platform's key; never shown again."]]} />
}

export const PAGE_BLOCKS: Registry = {
  home: { label: 'Home', icon: 'lucide:home', accent: 'var(--primary)', title: () => 'Where do you want to start?', render: () => <Home /> },
  agents: { label: 'Agents', icon: 'lucide:bot', accent: 'var(--series-1)', render: () => <AgentsBlock /> },
  'agent-new': { label: 'New agent', icon: 'lucide:plus', accent: 'var(--series-1)', title: (p) => (p.sent ? `Agent: ${String(p.title)}` : 'Make an agent'), subtitle: (p) => (p.sent ? 'Sent — kept as it was made' : 'A title, the knowledge it answers from, the programs it may run, who sees it'), render: () => <AgentNew /> },
  'agent-made': { label: 'Made', icon: 'lucide:check', accent: 'var(--win)', title: (p) => `${String(p.title)} is made`, subtitle: () => 'A node of the knowledge graph: owned, versioned, governed', render: () => <AgentMade /> },
  activity: { label: 'Activity', icon: 'lucide:activity', accent: 'var(--series-2)', render: () => <ActivityBlock /> },
  connections: { label: 'Connections', icon: 'lucide:plug', accent: 'var(--series-3)', render: () => <ConnectionsBlock /> },
  'connection-new': { label: 'New connection', icon: 'lucide:plus', accent: 'var(--series-3)', title: (p) => (p.sent ? `Connection: ${String(p.name)}` : 'Connect'), render: () => <ConnectionNew /> },
  'connection-made': { label: 'Connected', icon: 'lucide:check', accent: 'var(--win)', title: (p) => `${String(p.name)} is connected`, render: () => <ConnectionMade /> },
}
