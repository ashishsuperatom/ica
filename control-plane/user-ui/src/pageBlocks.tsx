// THE USER UI'S OWN BLOCKS — what used to be pages, as blocks of a thread kept in the browser (LocalThread): home, the
// agents a person sees, making an agent (a form that locks when sent and leaves its receipt), activity, connections.
// Each click opens a block below; each block is drawn in the platform's frame with the design system's primitives.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Section, notify, useThread, Form, Field, Choices, ConnectorFields, connectBlocks, ConnectAdapterProvider, type ConnectAdapter, SourceNode, type SourceTreeDoors, Receipt, RecordList, Status, ActionBar, Empty, Loading, dateTime, Icon, ACCENT, Notice, type Accent, type Registry } from '@superatom/ui'
import type { WorkAgent, Conversation } from './Workspace'
import { PROJECT_CAPABILITIES } from '../../shared/permissions'
import { accentOf } from './agentLook'
import { iconOfConnection, type Connector } from '../../shared/connectors'
import { formRefusal, plainly } from './plainly'
import { asWords, updatedOf, useActivities } from './activity'

type Request = (payload: Record<string, unknown>, onProgress?: (m: any) => void) => Promise<any>
export interface PagesEnv {
  request: Request
  subscribeLive: (fn: (m: any) => void) => () => void
  projectId: string
  token?: string | null
  scopes: string[]
  /** null until the platform has said which agents there are. */
  agents: WorkAgent[] | null
  /** Why the agents cannot be read now (the engine is not running), in plain words; null when they can. */
  offline: string | null
  sessions: Conversation[]
  /** Go to a session, or start one with an agent (s/<agent>). */
  go: (path: string) => void
  /** What the person may do in this project. */
  caps: string[]
  me: { name: string; email?: string }
  projectName: string
  /** Keep a conversation the person's way (name, pinned, archived, collection). */
  keep: (session: string, change: { name?: string; pinned?: boolean; archived?: boolean; collection?: string }) => Promise<void>
  onSignOut?: () => void
  /** Whether the project's engine is reached now. */
  connected: boolean
}
export const PagesContext = createContext<PagesEnv | null>(null)
const useEnv = () => { const e = useContext(PagesContext); if (!e) throw new Error('page blocks need their environment'); return e }

function Home() {
  // The project's front door: every agent the person can ask, as the project defines it — its main view as the card,
  // each of its starting points beneath with when to use it. Nothing here is the platform's own: it is the agents'.
  const env = useEnv()
  const { open } = useThread()
  if (!env.agents) return env.offline ? <Notice state="attention">{env.offline}</Notice> : <Loading>Reading the agents…</Loading>
  const named = env.agents.filter((a) => !a.isDefault)
  return (
    <div className="sa-home">
      {named.map((a) => {
        const accent = accentOf(a.look.accent)
        const icon = a.look.icon ?? 'solar:widget-linear'
        return (
          <Section key={a.id} tinted icon={icon} accent={(a.look.accent && a.look.accent in ACCENT ? a.look.accent : 'series-1') as Accent} title={a.name} subtitle={a.look.says}>
            <div className="sa-home__group">
              <button type="button" onClick={() => env.go(`s/${a.id}`)} className="sa-card sa-card--lift sa-action-card" style={{ '--accent': accent } as React.CSSProperties} title={a.look.says}>
                <span className="sa-action-card__tile"><Icon icon={icon} /></span>
                <div className="sa-action-card__body">
                  <p className="sa-action-card__title">{a.look.main?.label ?? a.name}</p>
                  <p className="sa-action-card__text">{a.look.main?.says ?? a.look.says ?? ''}</p>
                </div>
                <span className="sa-action-card__cta">Open <Icon icon="solar:arrow-right-linear" /></span>
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
      {named.length === 0 && <Empty icon="solar:widget-linear">No agents you can see yet. <button className="sa-btn sa-btn--link" onClick={() => open('agents', {}, 'Looked at the agents')}>Manage agents</button></Empty>}
    </div>
  )
}

function AgentsBlock() {
  const env = useEnv()
  const { open } = useThread()
  const [agents, setAgents] = useState<{ id: string; name: string; scope: string; isDefault?: boolean }[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => { void env.request({ t: 'session:agents' }).then((r) => { if (r.t !== 'session:agents') { plainly('agents not read', r.reason); setFailed(true) } setAgents(r.agents ?? []) }) }, [env.request])
  const publish = async (a: { id: string; name: string }) => {
    const r = await env.request({ t: 'graph:publish', name: a.id, scope: 'global', reason: 'ready for everyone in the project' })
    notify(r.t === 'graph:reply' ? `Asked to publish ${a.name} — an administrator decides` : plainly('Could not ask to publish it. Try again in a moment.', r.reason), r.t === 'graph:reply' ? 'note' : 'refused')
  }
  return (
    <Section icon="solar:widget-linear" title="Agents you can see" note={agents ? `${agents.length}` : undefined} subtitle="Open one to start a session, or make a new one."
      actions={<button className="sa-btn sa-btn--primary" onClick={() => open('agent-new', {}, 'Making an agent')}>New agent</button>}>
      {!agents && env.offline ? <Notice state="attention">{env.offline}</Notice> : failed && <Notice state="critical">The agents could not be read. Reload to try again.</Notice>}
      <RecordList search pageSize={20} rows={agents} keyOf={(a) => a.id} empty="No agents you can see yet." onRow={(a) => env.go(`s/${a.id}`)} columns={[
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
    if (r.t !== 'graph:reply') { setErr(plainly('The agent could not be made. Try again in a moment.', r.reason)); return }
    update({ ...f, sent: true })
    open('agent-made', { id: name, title: f.title.trim(), domain: f.domain, programs: f.programs, scope: f.scope }, `Made ${f.title.trim()}`)
  }
  return (
    <Form onSubmit={() => void send()} locked={sent} error={err} actions={<button className="sa-btn sa-btn--primary" disabled={!f.title.trim() || !f.domain}>Make the agent</button>}>
      <Field label="Title"><input id="ag-title" className="sa-input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="What it is about, in a few words" required /></Field>
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
  const rows = useActivities(env.request, env.subscribeLive)
  return (
    <Section icon="solar:pulse-linear" title="Running for you, and lately" subtitle="Program builds and session runs; kept current as they change.">
      <RecordList search pageSize={20} rows={rows} keyOf={(a) => a.id} empty="Nothing running, and nothing in the last day." columns={[
        { key: 'state', label: 'State', render: (a) => <Status state={a.state === 'failed' ? 'critical' : a.state === 'running' ? 'running' : 'ok'}>{a.state}</Status> },
        { key: 'title', label: 'What', wrap: true, render: (a) => <>{asWords(a.title)}{a.progress || a.detail ? <span className="sa-muted"> — {asWords(a.progress ?? a.detail)}</span> : null}</> },
        { key: 'when', label: 'When', align: 'end', render: (a) => dateTime(updatedOf(a)) },
      ]} />
    </Section>
  )
}

type Conn = { id: string; connector: string; name: string; level: 'project' | 'user'; runnable: boolean; state?: string; origin: 'platform' | 'engine'; auth?: string }
const useApi = () => {
  const env = useEnv()
  return (path: string, init: RequestInit = {}) => fetch(`/api/projects/${encodeURIComponent(env.projectId)}${path}`, { ...init, credentials: 'include', headers: { 'content-type': 'application/json', ...(env.token ? { authorization: `Bearer ${env.token}` } : {}) } })
}

/** A connector's default icon, by what it reads, when it has none of its own. */
const kindIcon = (kind?: string) => (kind === 'sql' ? 'solar:database-linear' : kind === 'documents' ? 'solar:documents-linear' : 'solar:global-linear')
/** A connection's icon: its connector's (or its dialect's) logo, else its connector's kind. */
function iconOf(c: Conn, connectors: Connector[]): string {
  return iconOfConnection(c as { connector?: string; dialect?: string }) ?? kindIcon(connectors.find((x) => x.id === c.connector)?.kind)
}

/** A link to a connection is followed once per page load (not again when the list is read again). */
let linkFollowed = false

function ConnectionsBlock() {
  const api = useApi()
  const { open } = useThread()
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [list, setList] = useState<Conn[] | null>(null)
  const [failed, setFailed] = useState(false)
  const load = () => {
    setFailed(false)
    const read = <T,>(path: string, key: string, set: (v: T[]) => void) => api(path).then(async (r) => { if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`); set(((await r.json()) as Record<string, T[]>)[key] ?? []) })
      .catch((e) => { plainly('connections not read', e); set([]); setFailed(true) })
    void read<Connector>('/connectors', 'connectors', setConnectors)
    void read<Conn>('/connections', 'connections', setList)
  }
  const needsMine = (list ?? []).filter((c) => c.auth === 'per-user')
  useEffect(load, [])   // eslint-disable-line react-hooks/exhaustive-deps
  // a link to a connection (/connections?connection=<id>, its address) opens it below, once, when the page is opened by it
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('connection')
    const c = id && !linkFollowed ? list?.find((x) => x.id === id) : undefined
    if (c) { linkFollowed = true; open('connection', { id: c.id, name: c.name, connector: c.connector, auth: c.auth ?? 'shared' }, `Opened ${c.name}`) }
  }, [list])   // eslint-disable-line react-hooks/exhaustive-deps
  const remove = async (id: string) => { const r = await api(`/connections/${id}`, { method: 'DELETE' }); if (!r.ok) notify(plainly('The connection could not be removed.', ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`), 'refused'); load() }
  return (<>
    <Section icon="solar:link-round-linear" title="Connections" note={list ? `${list.length}` : undefined} subtitle="Yours and the project's shared ones. A secret is sent once, sealed, and never shown again.">
      {failed && <Notice state="critical">The connections could not be read. <button className="sa-btn sa-btn--link" onClick={load}>Try again</button></Notice>}
      {needsMine.length > 0 && <Notice state="neutral">{needsMine.map((c) => c.name).join(', ')} {needsMine.length === 1 ? 'reads' : 'read'} with each person's own key: open {needsMine.length === 1 ? 'it' : 'one'} to give yours.</Notice>}
      <RecordList search pageSize={20} rows={list} keyOf={(c) => c.id} empty="No connections yet." columns={[
        { key: 'name', label: 'Name', render: (c) => <span className="sa-row sa-row--tight"><Icon icon={iconOf(c, connectors)} width={18} height={18} />{c.name}</span> },
        { key: 'what', label: 'What', render: (c) => `${connectors.find((x) => x.id === c.connector)?.title ?? c.connector}${c.origin === 'engine' ? ' (set up by an agent)' : ''}` },
        { key: 'state', label: 'State', render: (c) => <Status state={c.runnable ? 'ok' : c.state === 'not reachable' || c.state === 'no code yet' ? 'critical' : 'attention'}>{c.runnable ? 'ready' : c.state ?? 'not ready'}</Status> },
        { key: 'level', label: 'Who uses it', render: (c) => (c.level === 'project' ? (c.auth === 'per-user' ? 'the project — each with their own key' : 'the project') : 'you') },
        { key: 'remove', label: '', align: 'end', render: (c) => (c.origin === 'platform' ? <button className="sa-btn sa-btn--link" onClick={(e) => { e.stopPropagation(); void remove(c.id) }}>Remove</button> : null) },
      ]} onRow={(c) => open('connection', { id: c.id, name: c.name, connector: c.connector, auth: c.auth ?? 'shared' }, `Opened ${c.name}`)} />
    </Section>
    <Section icon="solar:add-circle-linear" title="Connect" subtitle="What can be connected: each reads its system, and some can act in it.">
      <div className="sa-section__body">
        <div className="sa-sub-grid">
          {connectors.map((c) => (
            <button key={c.id} type="button" className="sa-sub-card" title={c.description} onClick={() => open('connect', { start: c.id }, `Connecting ${c.title}`)}>
              <span className="sa-sub-card__title"><span className="sa-row sa-row--tight"><Icon icon={c.icon ?? kindIcon(c.kind)} width={18} height={18} />{c.title}</span></span>
              <span className="sa-sub-card__text">{c.description}</span>
            </button>
          ))}
        </div>
      </div>
    </Section>
  </>)
}

/** Connecting one's own: the Connect flow's blocks (@superatom/ui connectBlocks), each drawn with the app's doors. */
function UserConnect({ children }: { children: ReactNode }) {
  const env = useEnv()
  const api = useApi()
  const { open } = useThread()
  const res = async (r: Response) => { const d: any = await r.json().catch(() => ({})); return r.ok ? d : { error: formRefusal(r.status, d.error, 'It could not be done. Try again in a moment.') } }
  const ask = async (p: Record<string, unknown>) => { const r = await env.request(p); if (r?.t === 'connector:refused') throw new Error(r.reason); return r?.result }
  const adapter: ConnectAdapter = {
    level: 'user',
    catalogue: async () => (((await api('/connectors').then((r) => r.json())) as any).connectors ?? []).filter((c: any) => c.id !== 'code'),
    check: (connector, step, values, connection) => api('/connections/check', { method: 'POST', body: JSON.stringify({ connector, step, values, level: 'user', ...(connection ? { connection } : {}) }) }).then(res).then((d) => (d.error && d.ok === undefined ? { ok: false, said: 'It could not be checked.', error: d.error } : d)),
    create: async (connector, x) => { const d = await api('/connections', { method: 'POST', body: JSON.stringify({ connector, name: x.name, level: 'user', values: x.values, auth: x.auth, ...(x.description ? { description: x.description } : {}) }) }).then(res); return d.error ? { error: d.error } : { id: d.connection.id } },
    ready: async (id) => { const c = ((((await api('/connections').then((r) => r.json())) as any).connections ?? []) as any[]).find((x) => x.id === id); return { ready: !!c?.runnable, state: c?.state } },
    describe: async (id) => { const r = await ask({ t: 'connector:introspect', connection: id }); return { ...(r?.tree ? { tree: r.tree } : {}), entities: (r?.entities ?? []).map((e: any) => ({ name: e.name, filters: e.filters })) } },
    children: async (id, path, x) => await ask({ t: 'connector:children', connection: id, path, ...x }),
    read: async (id, path, filters) => (await ask({ t: 'connector:read', connection: id, path, filters, limit: 20 }))?.rows ?? [],
    signIn: async (id) => { const d = await api(`/connections/${id}/oauth/start`, { method: 'POST' }).then(res); return d.error ? { error: d.error } : { url: d.url } },
    giveKey: async (id, values) => { const d = await api(`/connections/${id}/my-key`, { method: 'PUT', body: JSON.stringify({ values }) }).then(res); return d.error ? { error: d.error } : { ok: true } },
    onDone: (id, name) => open('connection', { id, name }, `Opened ${name}`),
  }
  return <ConnectAdapterProvider value={adapter}>{children}</ConnectAdapterProvider>
}

type Entity = { name: string; label?: string; description?: string; fields: { name: string; type: string }[]; filters?: string[] }
type Offers = { tree?: { name: string }[]; entities: Entity[]; actions: ConnAction[] }
type ConnAction = { name: string; label: string; description: string; effect: 'read' | 'write' | 'irreversible'; confirm?: boolean; input: { name: string; type: string; description?: string; required?: boolean }[] }

/** What is inside a connection's node, and its rows — through the engine, as the one asking (connector:children, :read). */
const treeDoors = (ask: (t: string, extra?: Record<string, unknown>) => Promise<any>): SourceTreeDoors => ({
  list: async (path, o) => (await ask('children', { path, ...o })).result,
  read: async (path, filters) => (await ask('read', { path, filters, limit: 50 })).result?.rows ?? [],
})

/** A node of a connection, opened (a spreadsheet, a sheet): what is inside it, or its rows; a node inside it opens below. */
function ConnectionNode() {
  const env = useEnv()
  const { props, open } = useThread()
  const id = String(props.id), name = String(props.name)
  const path = (props.path as string[]) ?? [], labels = (props.labels as string[]) ?? []
  const ask = async (t: string, extra: Record<string, unknown> = {}) => { const r = await env.request({ t: `connector:${t}`, connection: id, ...extra }); if (r?.t === 'connector:refused') throw new Error(r.reason); return r }
  return <SourceNode doors={treeDoors(ask)} path={path} table={!!props.table} levels={(props.tree as { name: string }[] | null) ?? undefined} filters={(props.filters as string[]) ?? []}
    onOpen={(n) => open('connection-node', { ...props, path: [...path, n.id], labels: [...labels, n.label], table: n.table, filters: [] }, `${name} › ${[...labels, n.label].join(' › ')}`)} />
}

/** A connection: does it work, what it offers (things to read, things it can do), a look at what it reads — as you may
 *  see it — and its actions (one that changes the other system runs only when you confirm it). */
function ConnectionBlock() {
  const env = useEnv()
  const { props, open } = useThread()
  const id = String(props.id)
  const [test, setTest] = useState<{ ok: boolean; message?: string } | null>(null)
  const [offers, setOffers] = useState<Offers | null>(null)
  const [err, setErr] = useState('')
  const [action, setAction] = useState<ConnAction | null>(null)
  const [input, setInput] = useState<Record<string, string>>({})
  const [done, setDone] = useState<string>('')
  // How it is read (one shared key, or each person's own): as opened, else asked of the platform.
  const api = useApi()
  const [auth, setAuth] = useState<string | undefined>(props.auth as string | undefined)
  useEffect(() => { if (auth === undefined) api('/connections').then((r) => r.json()).then((d: any) => setAuth((d.connections ?? []).find((c: Conn) => c.id === id)?.auth ?? 'shared')).catch(() => {}) }, [id])   // eslint-disable-line react-hooks/exhaustive-deps
  const ask = async (t: string, extra: Record<string, unknown> = {}) => {
    const r = await env.request({ t: `connector:${t}`, connection: id, ...extra })
    if (r?.t === 'connector:refused') throw new Error(r.reason)
    return r
  }
  useEffect(() => {
    void ask('test').then((r) => setTest(r.result)).catch((e) => setTest({ ok: false, message: e.message }))
    void ask('introspect').then((r) => setOffers(r.result)).catch((e) => setErr(e.message))
  }, [id])   // eslint-disable-line react-hooks/exhaustive-deps
  const doors = treeDoors(ask)
  const run = async () => {
    if (!action) return
    setErr(''); setDone('')
    try { const r = await ask('act', { action: action.name, input, confirmed: true }); setDone(r.result?.message ?? 'Done'); notify(`${action.label}: done`, 'note') } catch (e: any) { setErr(e.message) }
  }
  return (<div className="sa-stack">
    {auth === 'per-user' && <YourKey id={id} connector={String(props.connector ?? '')} onChanged={() => void ask('test').then((r) => setTest(r.result)).catch((e) => setTest({ ok: false, message: e.message }))} />}
    {test && <Notice state={test.ok ? 'ok' : 'critical'}>{test.ok ? (test.message ? `It works — ${test.message}.` : 'It works.') : `It does not answer: ${test.message ?? 'no reason given'}`}</Notice>}
    {err && <Notice state="critical">{err}</Notice>}
    {!offers ? <Empty icon="lucide:loader">Asking what it offers…</Empty> : (<>
      <Section icon="solar:clipboard-list-linear" title="What it holds" subtitle={offers.tree ? offers.tree.map((l) => l.name).join(' › ') : 'Choose one to read it'}>
        <div className="sa-section__body">
          {test?.ok !== false && <SourceNode doors={doors} path={[]} table={false} levels={offers.tree}
            onOpen={(n) => open('connection-node', { id, name: String(props.name), path: [n.id], labels: [n.label], table: n.table, tree: offers.tree ?? null, filters: offers.tree ? [] : offers.entities.find((e) => e.name === n.id)?.filters ?? [] }, `${String(props.name)} › ${n.label}`)} />}
        </div>
      </Section>
      {offers.actions.length > 0 && (
        <Section icon="solar:bolt-linear" title="What it can do" subtitle="An action that changes the other system runs only when you confirm it; agents ask you first.">
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
  </div>)
}

/** Your own key, for a connection read with each person's own: whether you gave it, and giving, replacing or removing
 *  it. Sent once, sealed, kept in your own place; never shown back. */
function YourKey({ id, connector, onChanged }: { id: string; connector: string; onChanged: () => void }) {
  const api = useApi()
  const [mine, setMine] = useState<{ given: boolean; account?: { provider: string; email: string | null } } | null>(null)
  const [k, setK] = useState<Connector | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const read = () => api(`/connections/${id}/my-key`).then(async (r) => { const d = await r.json().catch(() => ({})) as { given?: boolean; account?: any; error?: string }; if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`); setMine({ given: !!d.given, ...(d.account ? { account: d.account } : {}) }) }).catch((e) => { plainly('your key not read', e); setMine(null) })
  useEffect(() => { void read(); api('/connectors').then((r) => r.json()).then((d: any) => setK((d.connectors ?? []).find((x: Connector) => x.id === connector) ?? null)).catch(() => {}) }, [id, connector])   // eslint-disable-line react-hooks/exhaustive-deps
  // the sign-in window says when it is done (oauth-flow.ts): read again
  useEffect(() => { const on = (e: MessageEvent) => { if ((e.data as any)?.t === 'oauth:done') { void read(); onChanged() } }; window.addEventListener('message', on); return () => window.removeEventListener('message', on) }, [id])   // eslint-disable-line react-hooks/exhaustive-deps
  const provider = k?.oauth ? (k.oauth.provider === 'google' ? 'Google' : k.oauth.provider) : null
  const connect = async () => {
    setBusy(true); setErr('')
    const r = await api(`/connections/${id}/oauth/start`, { method: 'POST' })
    const d = await r.json().catch(() => ({})) as { url?: string; error?: string }
    setBusy(false)
    if (!r.ok || !d.url) { setErr(formRefusal(r.status, d.error, 'The sign-in could not be started. Try again in a moment.')); return }
    if (!window.open(d.url, 'sa-oauth', 'popup,width=520,height=700')) window.location.assign(d.url)   // no pop-up allowed: this tab goes, and comes back
  }
  const save = async () => {
    setBusy(true); setErr('')
    const sent = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''))
    const r = await api(`/connections/${id}/my-key`, { method: 'PUT', body: JSON.stringify({ values: sent }) })
    const d = await r.json().catch(() => ({})) as { error?: string }
    setBusy(false)
    if (!r.ok) { setErr(formRefusal(r.status, d.error, 'Your key could not be kept. Try again in a moment.')); return }
    setValues({}); setOpen(false); setMine({ given: true }); notify('Your key is kept, sealed', 'note'); onChanged()
  }
  const remove = async () => {
    const r = await api(`/connections/${id}/my-key`, { method: 'DELETE' })
    if (!r.ok) { notify(plainly(provider ? 'Your account could not be disconnected.' : 'Your key could not be removed.', ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`), 'refused'); return }
    setMine({ given: false }); notify(provider ? 'Your account is disconnected' : 'Your key is removed', 'note'); onChanged()
  }
  if (provider) return (
    <Section icon="solar:login-3-linear" title={`Your ${provider} account`} subtitle={`This source reads with each person's own ${provider} account: what you read here is what your account may read.`}>
      <div className="sa-section__body sa-stack">
        <Notice state={mine?.given ? 'ok' : 'attention'}>{mine === null ? 'Whether yours is connected could not be read.' : mine.given ? `Connected${mine.account?.email ? ` as ${mine.account.email}` : ''}. Its sign-in is kept sealed and renewed as needed.` : `Yours is not connected: reading this source is refused until you connect it.`}</Notice>
        {err && <Notice state="critical">{err}</Notice>}
        <ActionBar>
          <button className="sa-btn sa-btn--primary" disabled={busy} onClick={() => void connect()}>{mine?.given ? 'Connect again' : `Connect my ${provider} account`}</button>
          {mine?.given && <button className="sa-btn" onClick={() => void remove()}>Disconnect</button>}
        </ActionBar>
      </div>
    </Section>
  )
  return (
    <Section icon="solar:key-linear" title="Your key" subtitle="This source reads with each person's own key: what you read here is what your own account may read.">
      <div className="sa-section__body sa-stack">
        <Notice state={mine?.given ? 'ok' : 'attention'}>{mine === null ? 'Whether you gave yours could not be read.' : mine.given ? 'Yours is kept, sealed. It is never shown again; replace it or remove it.' : 'You have not given yours: reading this source is refused until you do.'}</Notice>
        {!open ? <ActionBar>
          <button className="sa-btn sa-btn--primary" onClick={() => setOpen(true)}>{mine?.given ? 'Replace it' : 'Give yours'}</button>
          {mine?.given && <button className="sa-btn" onClick={() => void remove()}>Remove it</button>}
        </ActionBar> : (
          <Form onSubmit={() => void save()} error={err} actions={<><button type="button" className="sa-btn" onClick={() => { setOpen(false); setValues({}) }}>Cancel</button><button className="sa-btn sa-btn--primary" disabled={busy || !Object.values(values).some(Boolean)}>Keep it</button></>}>
            <p className="sa-note">Only what is yours — usually your user name and password; the rest is the source's own.</p>
            <ConnectorFields idPrefix="mine" fields={(k?.fields ?? []).map((f) => ({ ...f, required: false }))} values={values} onChange={setValues} />
          </Form>
        )}
      </div>
    </Section>
  )
}

function AboutBlock() {
  const env = useEnv()
  const named = (env.agents ?? []).filter((a) => !a.isDefault)
  return (<>
    <Section icon="solar:info-circle-linear" title="Superatom">
      <p className="sa-section__text">Ask about your organisation in your own words. Each question goes to the agent that knows its subject: it answers from the organisation's knowledge and the programs it may run, shows the numbers it read, and every conversation is kept for you to come back to.</p>
    </Section>
    <Section icon="solar:folder-linear" title="This project">
      <Receipt items={[
        ['Project', env.projectName],
        ['Connection', <span key="c" className="sa-row sa-row--tight"><span className="sa-dot" style={{ background: env.connected ? 'var(--win)' : 'var(--warn)' }} />{env.connected ? 'Connected' : 'Reconnecting…'}</span>],
        ['Agents you can ask', named.length],
        ['Your conversations', env.sessions.length],
      ]} />
    </Section>
    <Section icon="solar:widget-linear" title="Who answers">
      <RecordList rows={named} keyOf={(a) => a.id} empty="No agents you can see yet." onRow={(a) => env.go(`s/${a.id}`)} columns={[
        { key: 'name', label: 'Agent', render: (a) => <span className="sa-row sa-row--tight"><Icon icon={a.look.icon ?? 'solar:widget-linear'} />{a.name}</span> },
        { key: 'says', label: 'Answers about', wrap: true, render: (a) => a.look.says ?? '' },
      ]} />
    </Section>
  </>)
}

function ProfileBlock() {
  const env = useEnv()
  const held = (Object.keys(PROJECT_CAPABILITIES) as (keyof typeof PROJECT_CAPABILITIES)[]).filter((c) => env.caps.includes(c))
  return (<>
    <Section icon="solar:user-circle-linear" title={env.me.name}>
      <Receipt items={[['Name', env.me.name], ['Email', env.me.email ?? '—'], ['Project', env.projectName], ['Conversations', env.sessions.length]]} />
      {env.onSignOut && <ActionBar><button type="button" className="sa-btn" onClick={env.onSignOut}>Log out</button></ActionBar>}
    </Section>
    <Section icon="solar:shield-check-linear" title="What you can do here">
      {held.length
        ? <RecordList rows={held.map((c) => ({ c, what: PROJECT_CAPABILITIES[c] }))} keyOf={(r) => r.c} columns={[{ key: 'what', label: 'Allowed', wrap: true, render: (r) => r.what }]} />
        : <Empty icon="solar:shield-linear">Nothing yet — a project admin gives you a role.</Empty>}
    </Section>
  </>)
}

function SettingsBlock() {
  const env = useEnv()
  const archived = env.sessions.filter((s) => s.archived)
  const collections = [...env.sessions.reduce((m, s) => (s.collection && !s.archived ? m.set(s.collection, (m.get(s.collection) ?? 0) + 1) : m), new Map<string, number>())]
  const titleOf = (s: Conversation) => s.name || asWords(s.title) || env.agents?.find((a) => a.id === s.agent)?.name || s.agent
  return (<>
    <Section icon="solar:archive-linear" title="Archived conversations">
      <RecordList search pageSize={20} rows={archived} keyOf={(s) => s.session} empty="Nothing archived." onRow={(s) => env.go(s.session)} columns={[
        { key: 'title', label: 'Conversation', render: (s) => titleOf(s) },
        { key: 'updated', label: 'Last step', render: (s) => dateTime(s.updated) },
        { key: 'act', label: '', align: 'end', render: (s) => <button type="button" className="sa-btn" onClick={(e) => { e.stopPropagation(); void env.keep(s.session, { archived: false }) }}>Unarchive</button> },
      ]} />
    </Section>
    <Section icon="solar:folder-linear" title="Collections">
      <RecordList rows={collections} keyOf={([c]) => c} empty="No collections — keep a conversation in one from its … menu." columns={[
        { key: 'name', label: 'Collection', render: ([c]) => c },
        { key: 'n', label: 'Conversations', align: 'end', render: ([, n]) => n },
      ]} />
    </Section>
    <Section icon="solar:keyboard-linear" title="Keyboard shortcuts"><KeyboardShortcuts /></Section>
  </>)
}

/** The keys the workspace answers to. */
export function KeyboardShortcuts() {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  const k = (m: string) => (mac ? m : m.replace('⌘', 'Ctrl+').replace('⌥', 'Alt+'))
  const rows: [string, string][] = [['Search conversations, or go to a page', k('⌘K')], ['Show or hide the activity', k('⌥⌘U')], ['Send the question', 'Enter'], ['A new line in the question', 'Shift+Enter'], ['Close a menu or a dialog', 'Esc']]
  return <div className="sa-dialog__keys sa-section__text">{rows.map(([what, keys]) => [<span key={what}>{what}</span>, <kbd key={`${what}:k`}>{keys}</kbd>])}</div>
}

export const PAGE_BLOCKS: Registry = {
  home: { label: 'Home', icon: 'solar:home-2-linear', accent: 'var(--primary)', title: () => 'Where do you want to start?', subtitle: () => 'Open an agent, then narrow, break down and follow the next moves — or ask in your own words.', render: () => <Home /> },
  agents: { label: 'Agents', icon: 'solar:widget-linear', accent: 'var(--series-1)', render: () => <AgentsBlock /> },
  'agent-new': { label: 'New agent', icon: 'solar:add-circle-linear', accent: 'var(--series-1)', title: (p) => (p.sent ? `Agent: ${String(p.title)}` : 'Make an agent'), subtitle: (p) => (p.sent ? 'Sent — kept as it was made' : 'A title, the knowledge it answers from, the programs it may run, who sees it'), render: () => <AgentNew /> },
  'agent-made': { label: 'Made', icon: 'solar:check-circle-linear', accent: 'var(--win)', title: (p) => `${String(p.title)} is made`, subtitle: () => 'Ready to ask; every change to it is kept', render: () => <AgentMade /> },
  activity: { label: 'Activity', icon: 'solar:pulse-linear', accent: 'var(--series-2)', render: () => <ActivityBlock /> },
  about: { label: 'About', icon: 'solar:info-circle-linear', accent: 'var(--primary)', render: () => <AboutBlock /> },
  profile: { label: 'Profile', icon: 'solar:user-circle-linear', accent: 'var(--primary)', render: () => <ProfileBlock /> },
  settings: { label: 'Settings', icon: 'solar:settings-linear', accent: 'var(--primary)', render: () => <SettingsBlock /> },
  connections: { label: 'Connections', icon: 'solar:link-round-linear', accent: 'var(--series-3)', render: () => <ConnectionsBlock /> },
  ...connectBlocks(UserConnect),
  'connection-node': { label: 'Data', icon: 'solar:folder-open-linear', accent: 'var(--series-3)', title: (p) => `${String(p.name)} › ${((p.labels as string[]) ?? []).join(' › ')}`, subtitle: (p) => (p.table ? 'Its first rows, as you may see them' : 'What is inside it'), render: () => <ConnectionNode /> },
  connection: { label: 'Connection', icon: 'solar:link-round-linear', accent: 'var(--series-3)', title: (p) => String(p.name), subtitle: (p) => String(p.connector ?? ''), render: () => <ConnectionBlock /> },
}
