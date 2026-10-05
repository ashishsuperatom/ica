// THE USER UI'S OWN BLOCKS — what used to be pages, as blocks of a thread kept in the browser (LocalThread): home, the
// agents a person sees, making an agent (a form that locks when sent and leaves its receipt), activity, connections.
// Each click opens a block below; each block is drawn in the platform's frame with the design system's primitives.

import { createContext, useContext, useEffect, useState } from 'react'
import { Section, notify, useThread, Form, Field, Choices, Receipt, RecordList, Status, ActionBar, Empty, AskBar, BeatRows, Icon, ACCENT, Notice, Toolbar, type Accent, type Registry } from '@superatom/ui'
import type { WorkAgent } from './Workspace'
import { accentOf } from './agentLook'
import type { Connector } from '../../shared/connectors'

type Request = (payload: Record<string, unknown>, onProgress?: (m: any) => void) => Promise<any>
export interface PagesEnv {
  request: Request
  subscribeLive: (fn: (m: any) => void) => () => void
  projectId: string
  token?: string | null
  scopes: string[]
  agents: WorkAgent[]
  sessions: { session: string; agent: string; title: string; updated?: string }[]
  /** Go to a session, or start one with an agent (s/<agent>). */
  go: (path: string) => void
}
export const PagesContext = createContext<PagesEnv | null>(null)
const useEnv = () => { const e = useContext(PagesContext); if (!e) throw new Error('page blocks need their environment'); return e }
const newId = () => `ses-${crypto.randomUUID()}`
const plainTitle = (s: string) => (s ?? '').replace(/\*\*|__|`/g, '').replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2').trim()
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '')

function Home() {
  const env = useEnv()
  const { open } = useThread()
  const [asking, setAsking] = useState('')
  const [beats, setBeats] = useState<{ text: string; at: number }[]>([])
  const agentOf = (id: string) => env.agents.find((a) => a.id === id)
  const ask = async (text: string) => {
    const t = text.trim(); if (!t || asking) return
    const sid = newId()
    setAsking(t); setBeats([{ text: 'Finding the agent for this question…', at: Date.now() }])
    const m = await env.request({ t: 'session:start', session: sid, text: t, kind: 'language' }, (p) => { if (p?.t === 'narration' && p.text) setBeats((b) => [...b, { text: String(p.text), at: Date.now() }]) })
    setAsking(''); setBeats([])
    if (m?.t === 'session:view') env.go(sid); else notify(m?.reason ?? 'The question could not be asked', 'refused')
  }
  const named = env.agents.filter((a) => !a.isDefault)
  return (
    <div className="sa-home">
      <div className="sa-home__ask">
        <AskBar onAsk={(t) => void ask(t)} busy={!!asking} placeholder="Ask anything — the agent that knows answers"
          working={<><span className="sa-label">Working on: {asking}</span><BeatRows beats={beats.slice(-3)} live /></>} />
      </div>
      {named.map((a) => {
        const accent = accentOf(a.look.accent)
        const icon = a.look.icon ?? 'lucide:bot'
        return (
          <Section key={a.id} tinted icon={icon} accent={(a.look.accent && a.look.accent in ACCENT ? a.look.accent : 'series-1') as Accent} title={a.name} subtitle={a.look.says}>
            <div className="sa-home__group">
              <button type="button" onClick={() => env.go(`s/${a.id}`)} className="sa-card sa-card--lift sa-action-card" style={{ '--accent': accent } as React.CSSProperties} title={a.look.says}>
                <span className="sa-action-card__tile"><Icon icon={icon} /></span>
                <div className="sa-action-card__body">
                  <p className="sa-action-card__title">{a.look.main?.label ?? a.name}</p>
                  <p className="sa-action-card__text">{a.look.main?.says ?? (a.look.says || 'Start a session')}</p>
                </div>
                <span className="sa-action-card__cta">Open <Icon icon="mdi:arrow-right" /></span>
              </button>
              {a.starts.length > 0 && (
                <div className="sa-sub-grid">
                  {a.starts.map((x) => (
                    <button key={x.key} type="button" className="sa-sub-card" title={x.says} onClick={() => env.go(`s/${a.id}/${x.key}`)}>
                      <span className="sa-sub-card__title">{x.label}</span>
                      <span className="sa-sub-card__text">{x.says}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </Section>
        )
      })}
      {named.length === 0 && <Empty icon="lucide:bot">No agents you can see yet. <button className="sa-btn sa-btn--link" onClick={() => open('agents', {}, 'Looked at the agents')}>Manage agents</button></Empty>}
      {env.sessions.length > 0 && (
        <Section icon="lucide:history" title="Your sessions" subtitle="Pick up where you left off.">
          <RecordList rows={env.sessions.slice(0, 8)} keyOf={(s) => s.session} onRow={(s) => env.go(s.session)} columns={[
            { key: 'title', label: 'Session', render: (s) => <span className="sa-row sa-row--tight"><Icon icon={agentOf(s.agent)?.look.icon ?? 'lucide:messages-square'} />{plainTitle(s.title) || agentOf(s.agent)?.name || s.agent}</span> },
            { key: 'agent', label: 'Agent', render: (s) => agentOf(s.agent)?.name ?? s.agent },
            { key: 'updated', label: 'Last step', align: 'end', render: (s) => when(s.updated) },
          ]} />
        </Section>
      )}
    </div>
  )
}

function AgentsBlock() {
  const env = useEnv()
  const { open } = useThread()
  const [agents, setAgents] = useState<{ id: string; name: string; scope: string; isDefault?: boolean }[] | null>(null)
  useEffect(() => { void env.request({ t: 'session:agents' }).then((r) => setAgents(r.agents ?? [])) }, [env.request])
  const publish = async (a: { id: string; name: string }) => {
    const r = await env.request({ t: 'graph:publish', name: a.id, scope: 'global', reason: 'ready for everyone in the project' })
    notify(r.t === 'graph:reply' ? `Asked to publish ${a.name} — an administrator decides` : r.reason ?? 'Could not ask to publish it', r.t === 'graph:reply' ? 'note' : 'refused')
  }
  return (
    <Section icon="lucide:bot" title={`${(agents ?? []).length} agents you can see`} subtitle="Open one to start a session, or make a new one."
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
  const [rows, setRows] = useState<any[] | null>(null)
  useEffect(() => { void env.request({ t: 'activity:list' }).then((r) => setRows(r.activities ?? [])) }, [env.request])
  useEffect(() => env.subscribeLive((m) => { if (m.t === 'activity' && m.activity?.id) setRows((prev) => [m.activity, ...(prev ?? []).filter((x) => x.id !== m.activity.id)].slice(0, 100)) }), [env.subscribeLive])
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

type Conn = { id: string; connector: string; name: string; level: 'project' | 'user'; runnable: boolean; runs: 'code' | 'api' | 'cloud'; origin: 'platform' | 'engine' }
const useApi = () => {
  const env = useEnv()
  return (path: string, init: RequestInit = {}) => fetch(`/api/projects/${encodeURIComponent(env.projectId)}${path}`, { ...init, credentials: 'include', headers: { 'content-type': 'application/json', ...(env.token ? { authorization: `Bearer ${env.token}` } : {}) } })
}

function ConnectionsBlock() {
  const api = useApi()
  const { open } = useThread()
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [list, setList] = useState<Conn[] | null>(null)
  const load = () => {
    api('/connectors').then((r) => r.json()).then((d: any) => setConnectors(d.connectors ?? [])).catch(() => {})
    api('/connections').then((r) => r.json()).then((d: any) => setList(d.connections ?? [])).catch(() => {})
  }
  useEffect(load, [])   // eslint-disable-line react-hooks/exhaustive-deps
  const remove = async (id: string) => { const r = await api(`/connections/${id}`, { method: 'DELETE' }); if (!r.ok) notify(((await r.json().catch(() => ({}))) as any).error ?? 'Refused', 'refused'); load() }
  return (<>
    <Section icon="lucide:plug" title={`${(list ?? []).length} connections`} subtitle="Yours and the project's shared ones. A secret is sent once, sealed, and never shown again.">
      <RecordList rows={list} keyOf={(c) => c.id} empty="No connections yet." columns={[
        { key: 'name', label: 'Name' },
        { key: 'what', label: 'What', render: (c) => `${connectors.find((x) => x.id === c.connector)?.title ?? c.connector} · ${c.runs === 'code' ? 'code' : c.runs === 'cloud' ? 'cloud' : 'API'}${c.origin === 'engine' ? ' (on the engine)' : ''}` },
        { key: 'state', label: 'State', render: (c) => <Status state={c.runnable ? 'ok' : 'attention'}>{c.runnable ? 'connected' : 'not runnable yet'}</Status> },
        { key: 'level', label: 'Who uses it', render: (c) => (c.level === 'project' ? 'the project' : 'you') },
        { key: 'remove', label: '', align: 'end', render: (c) => (c.origin === 'platform' ? <button className="sa-btn sa-btn--link" onClick={(e) => { e.stopPropagation(); void remove(c.id) }}>Remove</button> : null) },
      ]} onRow={(c) => { if (c.runs === 'cloud') open('connection', { id: c.id, name: c.name, connector: c.connector }, `Opened ${c.name}`) }} />
    </Section>
    <Section icon="lucide:plus" title="Connect" subtitle="What can be connected: each reads its system, and some can act in it.">
      <div className="sa-section__body">
        <div className="sa-sub-grid">
          {connectors.map((c) => (
            <button key={c.id} type="button" className="sa-sub-card" title={c.description} onClick={() => open('connection-new', { connector: c.id }, `Connecting ${c.title}`)}>
              <span className="sa-sub-card__title"><span className="sa-row sa-row--tight"><Icon icon={c.icon ?? (c.kind === 'sql' ? 'lucide:database' : c.kind === 'mcp' ? 'lucide:plug-zap' : 'lucide:globe')} />{c.title}</span></span>
              <span className="sa-sub-card__text">{c.description}{c.offers?.actions ? ' · can act' : ''}</span>
            </button>
          ))}
        </div>
      </div>
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
    open('connection-made', { title: c.title, name, level, id: d.connection?.id, connector: c.id, cloud: c.runs === 'cloud' }, `Connected ${name}`)
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
  const { props, open } = useThread()
  return (<>
    <Receipt items={[['Connected', String(props.name)], ['What', String(props.title)], ['Who uses it', props.level === 'project' ? 'Everyone in the project' : 'Only you'], ['Its secrets', "Sealed with the platform's key; never shown again."]]} />
    {!!props.cloud && !!props.id && <ActionBar><button className="sa-btn sa-btn--primary" onClick={() => open('connection', { id: props.id, name: props.name, connector: props.connector }, `Opened ${String(props.name)}`)}>Open it</button></ActionBar>}
  </>)
}

type Entity = { name: string; label?: string; description?: string; fields: { name: string; type: string }[]; filters?: string[] }
type ConnAction = { name: string; label: string; description: string; effect: 'read' | 'write' | 'irreversible'; confirm?: boolean; input: { name: string; type: string; description?: string; required?: boolean }[] }

/** A cloud connection: does it work, what it offers (things to read, things it can do), a look at what it reads, its
 *  actions (one that changes the other system runs only when you confirm it), and the record of every call. */
function ConnectionBlock() {
  const env = useEnv()
  const { props } = useThread()
  const id = String(props.id)
  const [test, setTest] = useState<{ ok: boolean; message?: string } | null>(null)
  const [offers, setOffers] = useState<{ entities: Entity[]; actions: ConnAction[] } | null>(null)
  const [err, setErr] = useState('')
  const [entity, setEntity] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null)
  const [action, setAction] = useState<ConnAction | null>(null)
  const [input, setInput] = useState<Record<string, string>>({})
  const [done, setDone] = useState<string>('')
  const [calls, setCalls] = useState<any[] | null>(null)
  const ask = async (t: string, extra: Record<string, unknown> = {}) => {
    const r = await env.request({ t: `connector:${t}`, connection: id, ...extra })
    if (r?.t === 'connector:refused') throw new Error(r.reason)
    return r
  }
  const refreshCalls = () => { void ask('calls').then((r) => setCalls(r.calls ?? [])).catch(() => {}) }
  useEffect(() => {
    void ask('test').then((r) => setTest(r.result)).catch((e) => setTest({ ok: false, message: e.message }))
    void ask('introspect').then((r) => { setOffers(r.result); const first = r.result?.entities?.[0]?.name; if (first) setEntity(first) }).catch((e) => setErr(e.message)).finally(refreshCalls)
  }, [id])   // eslint-disable-line react-hooks/exhaustive-deps
  const ent = offers?.entities.find((e) => e.name === entity)
  const read = async () => { setErr(''); setRows(null); try { const r = await ask('read', { entity, filters, limit: 20 }); setRows(r.result?.rows ?? []) } catch (e: any) { setErr(e.message) } refreshCalls() }
  const run = async () => {
    if (!action) return
    setErr(''); setDone('')
    try { const r = await ask('act', { action: action.name, input, confirmed: true }); setDone(r.result?.message ?? 'Done'); notify(`${action.label}: done`, 'note') } catch (e: any) { setErr(e.message) }
    refreshCalls()
  }
  const cols = rows?.length ? Object.keys(rows[0]).slice(0, 8) : []
  return (<div className="sa-stack">
    {test && <Notice state={test.ok ? 'ok' : 'critical'}>{test.ok ? (test.message ? `It works — ${test.message}.` : 'It works.') : `It does not answer: ${test.message ?? 'no reason given'}`}</Notice>}
    {err && <Notice state="critical">{err}</Notice>}
    {!offers ? <Empty icon="lucide:loader">Asking what it offers…</Empty> : (<>
      <Section icon="lucide:table" title="What it reads" subtitle={`${offers.entities.length} thing${offers.entities.length === 1 ? '' : 's'} to read`}>
        <div className="sa-section__body sa-stack">
          <Toolbar>
            <Field label="Read"><select id="con-entity" className="sa-input" value={entity} onChange={(e) => { setEntity(e.target.value); setRows(null); setFilters({}) }}>{offers.entities.map((e) => <option key={e.name} value={e.name}>{e.label ?? e.name}</option>)}</select></Field>
            {(ent?.filters ?? []).map((f) => <Field key={f} label={f}><input id={`con-f-${f}`} className="sa-input" value={filters[f] ?? ''} onChange={(e) => setFilters({ ...filters, [f]: e.target.value })} /></Field>)}
          </Toolbar>
          {ent?.description && <p className="sa-note">{ent.description}</p>}
          <ActionBar><button className="sa-btn sa-btn--primary" onClick={() => void read()}>Read the first 20</button></ActionBar>
        </div>
        {rows && <RecordList rows={rows.map((r, i) => ({ ...r, __i: i }))} keyOf={(r: any) => String(r.__i)} empty="Nothing came back." columns={cols.map((c) => ({ key: c, label: c, render: (r: any) => (r[c] === null || r[c] === undefined ? '—' : typeof r[c] === 'object' ? JSON.stringify(r[c]).slice(0, 80) : String(r[c])) }))} />}
      </Section>
      {offers.actions.length > 0 && (
        <Section icon="lucide:zap" title="What it can do" subtitle="An action that changes the other system runs only when you confirm it; agents ask you first.">
          <RecordList rows={offers.actions} keyOf={(a) => a.name} onRow={(a) => { setAction(a); setInput({}); setDone('') }} columns={[
            { key: 'label', label: 'Action' }, { key: 'description', label: 'What it does', wrap: true },
            { key: 'effect', label: 'Changes', render: (a) => <Status state={a.effect === 'read' ? 'neutral' : a.effect === 'irreversible' ? 'critical' : 'attention'}>{a.effect === 'read' ? 'nothing' : a.effect === 'irreversible' ? 'cannot be undone' : 'something'}</Status> },
          ]} />
          {action && (
            <Form onSubmit={() => void run()} actions={<><button type="button" className="sa-btn" onClick={() => setAction(null)}>Cancel</button><button className={`sa-btn sa-btn--primary${action.effect === 'irreversible' ? ' sa-btn--danger' : ''}`}>{action.effect === 'read' ? 'Run' : `Confirm: ${action.label}`}</button></>}>
              <Field label="Action" help={action.description}><span>{action.label}</span></Field>
              {action.input.map((f) => <Field key={f.name} label={`${f.name}${f.required ? ' *' : ''}`} help={f.description}><input id={`con-a-${f.name}`} className="sa-input" value={input[f.name] ?? ''} onChange={(e) => setInput({ ...input, [f.name]: e.target.value })} required={f.required} /></Field>)}
              {done && <Notice state="ok">{done}</Notice>}
            </Form>
          )}
        </Section>
      )}
    </>)}
    <Section icon="lucide:history" title="What it did" subtitle="Every operation and every request it made — never a credential or a body.">
      <RecordList rows={calls} keyOf={(c) => String(c.seq)} empty="Nothing yet." columns={[
        { key: 'at', label: 'When', render: (c) => when(c.at) }, { key: 'op', label: 'What' }, { key: 'target', label: 'On', wrap: true, render: (c) => c.target ?? '—' },
        { key: 'rows', label: 'Rows', align: 'end', render: (c) => c.rows ?? '—' },
        { key: 'ok', label: '', render: (c) => <Status state={c.ok ? 'ok' : 'critical'}>{c.ok ? (c.status ? String(c.status) : 'done') : (c.error ?? 'failed')}</Status> },
      ]} />
    </Section>
  </div>)
}

export const PAGE_BLOCKS: Registry = {
  home: { label: 'Home', icon: 'lucide:house', accent: 'var(--primary)', title: () => 'Where do you want to start?', subtitle: () => 'Open an agent, then narrow, break down and follow the next moves — or ask in your own words.', render: () => <Home /> },
  agents: { label: 'Agents', icon: 'lucide:bot', accent: 'var(--series-1)', render: () => <AgentsBlock /> },
  'agent-new': { label: 'New agent', icon: 'lucide:plus', accent: 'var(--series-1)', title: (p) => (p.sent ? `Agent: ${String(p.title)}` : 'Make an agent'), subtitle: (p) => (p.sent ? 'Sent — kept as it was made' : 'A title, the knowledge it answers from, the programs it may run, who sees it'), render: () => <AgentNew /> },
  'agent-made': { label: 'Made', icon: 'lucide:check', accent: 'var(--win)', title: (p) => `${String(p.title)} is made`, subtitle: () => 'A node of the knowledge graph: owned, versioned, governed', render: () => <AgentMade /> },
  activity: { label: 'Activity', icon: 'lucide:activity', accent: 'var(--series-2)', render: () => <ActivityBlock /> },
  connections: { label: 'Connections', icon: 'lucide:plug', accent: 'var(--series-3)', render: () => <ConnectionsBlock /> },
  'connection-new': { label: 'New connection', icon: 'lucide:plus', accent: 'var(--series-3)', title: (p) => (p.sent ? `Connection: ${String(p.name)}` : 'Connect'), render: () => <ConnectionNew /> },
  'connection-made': { label: 'Connected', icon: 'lucide:check', accent: 'var(--win)', title: (p) => `${String(p.name)} is connected`, render: () => <ConnectionMade /> },
  connection: { label: 'Connection', icon: 'lucide:plug', accent: 'var(--series-3)', title: (p) => String(p.name), subtitle: (p) => String(p.connector ?? ''), render: () => <ConnectionBlock /> },
}
