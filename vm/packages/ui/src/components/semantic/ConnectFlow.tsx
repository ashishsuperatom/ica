// CONNECTING A SOURCE — one flow for every connector and every person (docs/connectors-plan.md 7d), as BLOCKS in a thread:
// each step opens the next block below, a step done stays above as what it was (its answer; Change opens it again, and
// Next from it then branches). Progressive: only what is needed now. Pick what to connect → the connector's own setup
// steps, each with what to do and its few fields, each PROVEN by its check before Next (✓ what passed, or what was wrong
// and how to fix it) → name it → one's own account or key → its data, seen.
//
// The surface gives the doors (a ConnectAdapter, through the Provider it wraps each block in) and puts the blocks in its
// thread (connectBlocks). What is not secret travels in each block's props (kept with the thread's history); a secret
// stays in this page's memory only — a reload asks for it again.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { useThread, type Registry } from '../frame/LocalThread'
import { Notice, Field, ConnectorFields, CopyButton, Code, Empty, Status, type FormField } from './index'
import { SourceNode } from './SourceNode'
import type { ExplorerNode } from './Explorer'

export interface FlowStep {
  id: string; title: string; say: string; fields?: string[]; copy?: { label: string; value: string }[]
  check?: { kind: string }; who?: 'setup' | 'person'
}
export interface FlowConnector {
  id: string; title: string; icon?: string; kind?: string; description: string; identity?: string[]; oauth?: { provider: string }
  fields: FormField[]; setup?: FlowStep[]; levels?: string[]; org?: { madeBy: string } | null
}
export interface CheckAnswer { ok: boolean; said: string; error?: string; fix?: string; callback?: string }
export interface ConnectAdapter {
  /** 'project': shared by the project (an admin's); 'user': one's own. */
  level: 'project' | 'user'
  catalogue: () => Promise<FlowConnector[]>
  check: (connector: string, step: string, values: Record<string, unknown>, connection?: string) => Promise<CheckAnswer>
  create: (connector: string, o: { name: string; values: Record<string, unknown>; auth: 'shared' | 'per-user'; description?: string }) => Promise<{ id: string } | { error: string }>
  /** Whether the engine runs it now. */
  ready: (id: string) => Promise<{ ready: boolean; state?: string }>
  /** What it holds, as the person asking sees it: its tree's levels (none: one level of tables) and its entities' filters;
   *  what is inside a node; a table's first rows (connectors/src/contract.ts "A SOURCE'S TREE"). */
  describe: (id: string) => Promise<{ tree?: { name: string }[]; entities: { name: string; filters?: string[] }[] }>
  children: (id: string, path: string[], o: { search?: string; cursor?: string | null }) => Promise<{ nodes: ExplorerNode[]; next?: string | null }>
  read: (id: string, path: string[], filters: Record<string, string>) => Promise<Record<string, unknown>[]>
  /** One's own account (OAuth): the address to sign in at. */
  signIn?: (id: string) => Promise<{ url: string } | { error: string }>
  /** One's own key, for a source read with each person's own. */
  giveKey?: (id: string, values: Record<string, unknown>) => Promise<{ ok: true } | { error: string }>
  /** The organisation's app with a provider, set here (who may). */
  setApp?: (provider: string, clientId: string, clientSecret: string) => Promise<{ ok: true } | { error: string }>
  onDone: (id: string, name: string) => void
  /** The connector agent (a source written for, not chosen). */
  onCustom?: () => void
}

const AdapterContext = createContext<ConnectAdapter | null>(null)
/** Gives the blocks their doors. */
export const ConnectAdapterProvider = AdapterContext.Provider
const useAdapter = () => { const a = useContext(AdapterContext); if (!a) throw new Error('a Connect block is drawn inside a ConnectAdapterProvider'); return a }

// what can be connected, read once per page
const catalogues = new Map<string, Promise<FlowConnector[]>>()
function useConnector(id: string | undefined): FlowConnector[] | null | 'failed' {
  const a = useAdapter()
  const [list, setList] = useState<FlowConnector[] | null | 'failed'>(null)
  useEffect(() => {
    const k = a.level
    if (!catalogues.has(k)) catalogues.set(k, a.catalogue().catch((e) => { catalogues.delete(k); throw e }))
    catalogues.get(k)!.then(setList).catch(() => setList('failed'))
  }, [id])   // eslint-disable-line react-hooks/exhaustive-deps
  return list
}
// a flow's secrets: this page's memory only
const secrets = new Map<string, Record<string, string>>()
const valuesOf = (p: Record<string, unknown>) => ({ ...((p.values as Record<string, string>) ?? {}), ...(secrets.get(String(p.flow)) ?? {}) })
function keep(flow: string, c: FlowConnector, values: Record<string, string>): Record<string, string> {
  const secret = (k: string) => c.fields.find((f) => f.name === k)?.type === 'secret'
  secrets.set(flow, { ...(secrets.get(flow) ?? {}), ...Object.fromEntries(Object.entries(values).filter(([k]) => secret(k))) })
  return Object.fromEntries(Object.entries(values).filter(([k]) => !secret(k)))
}
const newFlow = () => `cf${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const before = (c: FlowConnector) => (c.setup ?? []).filter((s) => s.who !== 'person')
const providerTitle = (p?: string) => (p === 'google' ? 'Google' : p ?? '')

/** What a step says, as a person reads it: paragraphs, numbered lines, and [links](https://…). */
function Say({ text, values }: { text: string; values: Record<string, unknown> }) {
  const filled = text.replace(/\{(\w+)\}/g, (_, k) => (values[k] ? String(values[k]) : `the ${k}`))
  const inline = (s: string): ReactNode[] => s.split(/(\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g).map((part, i) => {
    const m = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/)
    return m ? <a key={i} href={m[2]} target="_blank" rel="noreferrer">{m[1]} <Icon icon="lucide:external-link" width={12} height={12} /></a> : part
  })
  return <div className="sa-stack sa-stack--2">{filled.split(/\n\s*\n/).map((para, i) => {
    const lines = para.split('\n')
    return lines.every((l) => /^\d+\.\s/.test(l.trim()))
      ? <ol key={i} className="sa-say__list">{lines.map((l, j) => <li key={j}>{inline(l.trim().replace(/^\d+\.\s/, ''))}</li>)}</ol>
      : <p key={i} className="sa-say">{inline(para)}</p>
  })}</div>
}

/** A check's answer: what passed, or what was wrong — what to do first, then the exact reason, folded. */
function Answer({ a }: { a: CheckAnswer }) {
  return a.ok ? <Notice state="ok">{a.said}</Notice> : (
    <Notice state="critical"><strong>{a.said}</strong>{a.fix && <div>{a.fix}</div>}
      {a.error && a.error !== a.said && <details className="sa-say__why"><summary>The exact reason</summary><Code>{a.error}</Code></details>}</Notice>
  )
}
const Wait = ({ children }: { children: ReactNode }) => <p className="sa-muted"><span className="sa-spinner" /> {children}</p>

// ── 1. what to connect ──
function Pick() {
  const a = useAdapter(), { open, props } = useThread()
  const list = useConnector(undefined)
  const [q, setQ] = useState('')
  const chosen = typeof props.start === 'string' ? props.start : null
  const go = (x: FlowConnector) => {
    const flow = newFlow(), steps = before(x)
    open(steps.length ? 'connect-step' : 'connect-name', { flow, connector: x.id, title: x.title, i: 0, values: {}, ...(steps.length ? { stepTitle: steps[0].title } : {}) }, `Connecting ${x.title}`)
  }
  // opened on one already (a card elsewhere): straight to its first step
  useEffect(() => { if (chosen && Array.isArray(list)) { const x = list.find((k) => k.id === chosen); if (x) go(x) } }, [list])   // eslint-disable-line react-hooks/exhaustive-deps
  if (list === 'failed') return <Notice state="critical">What can be connected could not be read. Reload to try again.</Notice>
  const shown = (list ?? []).filter((x) => (a.level === 'project' ? (x.levels ?? ['project']).includes('project') : (x.levels ?? []).includes('user')) && (!q.trim() || `${x.title} ${x.id} ${x.description}`.toLowerCase().includes(q.trim().toLowerCase())))
  const groups: [string, FlowConnector[]][] = [["Your organisation's", shown.filter((x) => x.org)], ['Databases', shown.filter((x) => !x.org && x.kind === 'sql')], ['Apps, files and APIs', shown.filter((x) => !x.org && x.kind !== 'sql')]]
  return (
    <div className="sa-stack sa-stack--3">
      <input className="sa-input" autoFocus placeholder="What do you want to connect? (Postgres, Google Sheets, files in S3, an API…)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a connector" />
      {!list ? <Wait>Reading what can be connected…</Wait> : groups.filter(([, xs]) => xs.length).map(([label, xs]) => (
        <div key={label} className="sa-stack sa-stack--2">
          <span className="sa-muted">{label}</span>
          <div className="sa-sub-grid">{xs.map((x) => (
            <button key={x.id} type="button" className="sa-sub-card" onClick={() => go(x)}>
              <span className="sa-sub-card__title"><span className="sa-row sa-row--tight"><Icon icon={x.icon ?? (x.kind === 'sql' ? 'solar:database-linear' : 'solar:global-linear')} width={20} height={20} />{x.title}</span></span>
              <span className="sa-sub-card__text">{x.description}</span>
            </button>))}
          </div>
        </div>))}
      {list && !shown.length && <Empty icon="lucide:search">Nothing by that name.</Empty>}
      {a.onCustom && list && <p className="sa-muted">Not here? <button className="sa-btn sa-btn--link" onClick={a.onCustom}>Ask the connector agent to write one</button></p>}
    </div>
  )
}

// ── 2. one of the connector's steps ──
function Step() {
  const a = useAdapter(), { open, props, update } = useThread()
  const list = useConnector(String(props.connector))
  const c = Array.isArray(list) ? list.find((x) => x.id === props.connector) ?? null : null
  const [values, setValues] = useState<Record<string, string>>(() => valuesOf(props))
  const [answer, setAnswer] = useState<CheckAnswer | null>((props.passed as CheckAnswer) ?? null)
  const [busy, setBusy] = useState(false)
  if (list === 'failed') return <Notice state="critical">The connector could not be read. Reload to try again.</Notice>
  if (!c) return <Wait>Reading the connector…</Wait>
  const steps = before(c), i = Number(props.i) || 0, s = steps[i]
  if (!s) return <Notice state="critical">This step is no longer the connector's — start again.</Notice>
  const passed = !!props.passed
  const fields = c.fields.filter((f) => (s.fields ?? []).includes(f.name))
  const next = (kept: Record<string, string>) => {
    const last = i + 1 >= steps.length
    open(last ? 'connect-name' : 'connect-step', { flow: props.flow, connector: c.id, title: c.title, i: i + 1, values: kept, ...(last ? {} : { stepTitle: steps[i + 1].title }) }, last ? `Naming ${c.title}` : steps[i + 1].title)
  }
  const check = async () => {
    setBusy(true)
    const given = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''))
    let r: CheckAnswer
    try { r = s.check ? await a.check(c.id, s.id, given) : { ok: true, said: 'Done.' } } catch (e: any) { r = { ok: false, said: 'It could not be checked.', error: String(e?.message ?? e) } }
    setBusy(false); setAnswer(r)
    if (!r.ok) return
    const kept = keep(String(props.flow), c, values)
    update({ passed: r, values: kept })
    next(kept)   // proven: the next step opens below
  }
  const appMissing = s.check?.kind === 'oauth-app' && answer && !answer.ok
  // done: what it was, and Change to open it again
  if (passed) return (
    <div className="sa-stack sa-stack--2">
      <Answer a={props.passed as CheckAnswer} />
      {fields.filter((f) => f.type !== 'secret' && values[f.name]).length > 0 && <p className="sa-muted">{fields.filter((f) => f.type !== 'secret' && values[f.name]).map((f) => `${f.label}: ${values[f.name]}`).join(' · ')}</p>}
      <div><button className="sa-btn sa-btn--link" onClick={() => { setAnswer(null); update({ passed: null }) }}>Change</button></div>
    </div>
  )
  return (
    <div className="sa-stack sa-stack--3">
      <Say text={s.say} values={values} />
      {(s.copy ?? []).map((x) => <div key={x.label} className="sa-stack sa-stack--1"><span className="sa-row sa-row--tight sa-muted">{x.label}<CopyButton text={x.value} className="sa-btn sa-btn--link" /></span><pre className="sa-code" style={{ whiteSpace: 'pre-wrap' }}>{x.value}</pre></div>)}
      {fields.length > 0 && <div className="sa-stack sa-stack--2"><ConnectorFields idPrefix={`cf-${props.flow}-${s.id}`} fields={fields} values={values} onChange={(v) => { setValues(v); setAnswer(null) }} /></div>}
      {appMissing && c.oauth && <SetApp provider={c.oauth.provider} callback={answer!.callback} onSet={() => void check()} />}
      {answer && <Answer a={answer} />}
      <div className="sa-row sa-row--tight">
        <button className="sa-btn sa-btn--primary" disabled={busy} onClick={() => void check()}>{busy ? <span className="sa-spinner" /> : null}{s.check ? (fields.length ? 'Check it' : "I've done this — check it") : 'Next'}</button>
      </div>
    </div>
  )
}

/** The organisation's app with a provider, set where the step stands (who may; else who to ask). */
function SetApp({ provider, callback, onSet }: { provider: string; callback?: string; onSet: () => void }) {
  const a = useAdapter()
  const [id, setId] = useState(''), [secret, setSecret] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false)
  const title = providerTitle(provider)
  if (!a.setApp) return <Notice state="attention">An organisation admin sets your organisation's {title} app (Organisation → Connectors → Sign-in apps). Ask one, then check again.</Notice>
  const save = async () => { setBusy(true); setErr(''); const r = await a.setApp!(provider, id.trim(), secret.trim()); setBusy(false); if ('error' in r) setErr(r.error); else onSet() }
  return (
    <div className="sa-stack sa-stack--2 sa-flow__inset">
      {callback && <span className="sa-row sa-row--tight sa-muted">Its redirect address: <Code>{callback}</Code><CopyButton text={callback} className="sa-btn sa-btn--link" /></span>}
      <Field label={`${title} client ID`}><input id="cf-app-id" className="sa-input" value={id} onChange={(e) => setId(e.target.value)} autoComplete="off" /></Field>
      <Field label="Client secret" help="Sealed once sent; never shown again."><input id="cf-app-secret" className="sa-input" type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} /></Field>
      {err && <Notice state="critical">{err}</Notice>}
      <div><button className="sa-btn sa-btn--primary" disabled={busy || !id.trim() || !secret.trim()} onClick={() => void save()}>{busy ? <span className="sa-spinner" /> : null}Keep it, and check</button></div>
    </div>
  )
}

// ── 3. its name, and who reads it — then it is made ──
function Name() {
  const a = useAdapter(), { open, props, update } = useThread()
  const list = useConnector(String(props.connector))
  const c = Array.isArray(list) ? list.find((x) => x.id === props.connector) ?? null : null
  const [name, setName] = useState(String(props.name ?? (String(props.title ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, ''))))
  const [auth, setAuth] = useState<'shared' | 'per-user'>((props.auth as any) ?? 'shared')
  const [description, setDescription] = useState('')
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false)
  const made = props.made as { id: string; name: string } | undefined
  useEffect(() => { if (c && !(c.identity ?? ['shared']).includes('shared')) setAuth('per-user') }, [c])
  // made: the engine loads it, then the person's own step (their account or key), or straight to its data
  useEffect(() => {
    if (!made || !c || props.opened) return
    let stop = false
    void (async () => {
      for (let n = 0; n < 60 && !stop; n++) { if ((await a.ready(made.id).catch(() => ({ ready: false }))).ready) break; await new Promise((r) => setTimeout(r, 2000)) }
      if (stop) return
      update({ opened: true })
      const mine = (c.setup ?? []).some((s) => s.who === 'person') || (props.auth === 'per-user' && !c.oauth && a.giveKey)
      open(mine ? 'connect-mine' : 'connect-see', { flow: props.flow, connector: c.id, title: c.title, id: made.id, name: made.name }, mine ? 'Your own' : `${made.name}'s data`)
    })()
    return () => { stop = true }
  }, [made?.id, c])   // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return <Wait>Reading the connector…</Wait>
  if (made) return props.opened ? <Notice state="ok">{made.name} is made.</Notice> : <Wait>{made.name} is made — the engine is loading it…</Wait>
  const both = (c.identity ?? []).includes('shared') && (c.identity ?? []).includes('person-key') && a.level === 'project'
  const personOnly = !(c.identity ?? ['shared']).includes('shared')
  const create = async () => {
    setBusy(true); setErr('')
    const values = valuesOf(props)
    const r = await a.create(c.id, { name: name.trim(), values: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '')), auth, ...(description.trim() ? { description: description.trim() } : {}) })
    setBusy(false)
    if ('error' in r) { setErr(r.error); return }
    secrets.delete(String(props.flow))   // kept sealed by the platform now; not here
    update({ made: { id: r.id, name: name.trim() }, auth, name: name.trim() })
  }
  return (
    <div className="sa-stack sa-stack--3">
      <Field label="Name" help="How people and agents call it — SALES_DB, CRM. Keep it: what names it later finds it by this."><input id={`cf-${props.flow}-name`} className="sa-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      {both && <Field label="Who it reads as" help={auth === 'per-user' ? 'Each person gives their own key: what they read is what their own account may read.' : 'Everyone reads with the account you gave.'}>
        <select id={`cf-${props.flow}-auth`} className="sa-input" value={auth} onChange={(e) => setAuth(e.target.value as 'shared' | 'per-user')}><option value="shared">Everyone, with the account above</option><option value="per-user">Each person, with their own key</option></select></Field>}
      {personOnly && <p className="sa-muted">Each person connects their own {c.oauth ? `${providerTitle(c.oauth.provider)} account` : 'key'}: what they read is what it may read.</p>}
      <details><summary className="sa-muted">Describe what it holds (optional)</summary><textarea id={`cf-${props.flow}-desc`} className="sa-input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Orders and customers since 2019, from the shop" /></details>
      {err && <Notice state="critical">{err}</Notice>}
      <div><button className="sa-btn sa-btn--primary" disabled={busy || !name.trim()} onClick={() => void create()}>{busy ? <span className="sa-spinner" /> : null}Connect it</button></div>
    </div>
  )
}

// ── 4. one's own: their account (a window to sign in, watched until done) or their key ──
function Mine() {
  const a = useAdapter(), { open, props, update } = useThread()
  const list = useConnector(String(props.connector))
  const c = Array.isArray(list) ? list.find((x) => x.id === props.connector) ?? null : null
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false), [vals, setVals] = useState<Record<string, string>>({})
  const [answer, setAnswer] = useState<CheckAnswer | null>(null)
  const id = String(props.id), step = c?.setup?.find((s) => s.who === 'person')
  const toData = () => { update({ done: true }); open('connect-see', { connector: props.connector, title: props.title, id, name: props.name }, `${String(props.name)}'s data`) }
  const check = async () => { if (!c || !step) return; const r = await a.check(c.id, step.id, {}, id).catch((e: any) => ({ ok: false, said: 'It could not be checked.', error: String(e?.message ?? e) })); setAnswer(r); if (r.ok) toData() }
  useEffect(() => {
    if (!c?.oauth || props.done) return
    const on = (e: MessageEvent) => { if ((e.data as any)?.t === 'oauth:done') void check() }
    window.addEventListener('message', on); return () => window.removeEventListener('message', on)
  }, [c])   // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return <Wait>Reading the connector…</Wait>
  if (props.done) return <Notice state="ok">Yours is connected.</Notice>
  if (c.oauth && a.signIn && step) {
    const go = async () => { setErr(''); const r = await a.signIn!(id); if ('error' in r) { setErr(r.error); return } if (!window.open(r.url, 'sa-oauth', 'popup,width=520,height=700')) window.location.assign(r.url) }
    return (
      <div className="sa-stack sa-stack--3">
        <Say text={step.say} values={{}} />
        {answer && <Answer a={answer} />}
        {err && <Notice state="critical">{err}</Notice>}
        <div className="sa-row sa-row--tight">
          <button className="sa-btn sa-btn--primary" onClick={() => void go()}><Icon icon={c.icon ?? 'lucide:log-in'} width={16} height={16} />Connect my {providerTitle(c.oauth.provider)} account</button>
          <button className="sa-btn" onClick={() => void check()}>I've connected it — check</button>
        </div>
      </div>
    )
  }
  const save = async () => { setBusy(true); setErr(''); const r = await a.giveKey!(id, Object.fromEntries(Object.entries(vals).filter(([, v]) => v !== ''))); setBusy(false); if ('error' in r) setErr(r.error); else toData() }
  return (
    <div className="sa-stack sa-stack--3">
      <p className="sa-say">Each person reads it with their own key. Give yours — usually only your user name and password; the rest is the source's own.</p>
      <ConnectorFields idPrefix={`cf-${props.flow}-mine`} fields={c.fields.map((f) => ({ ...f, required: false }))} values={vals} onChange={setVals} />
      {err && <Notice state="critical">{err}</Notice>}
      <div className="sa-row sa-row--tight"><button className="sa-btn" onClick={toData}>Later</button><button className="sa-btn sa-btn--primary" disabled={busy || !Object.values(vals).some(Boolean)} onClick={() => void save()}>{busy ? <span className="sa-spinner" /> : null}Keep it</button></div>
    </div>
  )
}

// ── 5. its data, as the person asking sees it: what it holds; a node opened is a block of its own (titled with its path) ──
function See() {
  const a = useAdapter(), { props, open } = useThread()
  const id = String(props.id), name = String(props.name)
  const [what, setWhat] = useState<{ tree?: { name: string }[]; entities: { name: string; filters?: string[] }[] } | null>(null)
  const [err, setErr] = useState('')
  const [seen, setSeen] = useState(false)
  useEffect(() => { a.describe(id).then(setWhat).catch((e) => setErr(String(e?.message ?? e))) }, [id])   // eslint-disable-line react-hooks/exhaustive-deps
  const doors = { list: async (path: string[], o: { search?: string; cursor?: string | null }) => { const r = await a.children(id, path, o); setSeen(true); return r }, read: (path: string[], f: Record<string, string>) => a.read(id, path, f) }
  return (
    <div className="sa-stack sa-stack--3">
      {err && <Notice state="critical">It is made, but reading it did not work: {err}</Notice>}
      {!what && !err ? <Wait>Asking what it holds…</Wait> : what && <SourceNode doors={doors} path={[]} table={false} levels={what.tree} pageSize={10}
        onOpen={(n) => open('connect-node', { id, name, path: [n.id], labels: [n.label], table: n.table, tree: what.tree ?? null, filters: what.tree ? [] : what.entities.find((e) => e.name === n.id)?.filters ?? [] }, `${name} › ${n.label}`)} />}
      {seen && !err && <Status state="ok">Connected — agents can ask it now; its index is being built.</Status>}
      <div className="sa-row sa-row--tight"><button className="sa-btn" onClick={() => open('connect', {}, 'Connect another')}>Connect another</button><button className="sa-btn sa-btn--primary" onClick={() => a.onDone(id, name)}>Open it</button></div>
    </div>
  )
}

/** A node of what it holds, opened: what is inside it, or its rows. */
function SeeNode() {
  const a = useAdapter(), { props, open } = useThread()
  const id = String(props.id), name = String(props.name)
  const path = (props.path as string[]) ?? [], labels = (props.labels as string[]) ?? [], tree = (props.tree as { name: string }[] | null) ?? undefined
  return <SourceNode doors={{ list: (p, o) => a.children(id, p, o), read: (p, f) => a.read(id, p, f) }} path={path} table={!!props.table} levels={tree} filters={(props.filters as string[]) ?? []}
    onOpen={(n) => open('connect-node', { ...props, path: [...path, n.id], labels: [...labels, n.label], table: n.table, filters: [] }, `${name} › ${[...labels, n.label].join(' › ')}`)} />
}

/** The Connect flow's blocks, each drawn inside the surface's Provider (which gives the ConnectAdapter). */
export function connectBlocks(Provider: (p: { children: ReactNode }) => ReactNode): Registry {
  const wrap = (el: ReactNode) => <Provider>{el}</Provider>
  const t = (p: Record<string, unknown>) => String(p.title ?? '')
  return {
    connect: { label: 'Connect', icon: 'solar:add-circle-linear', accent: 'var(--series-3)', title: () => 'Connect a source', subtitle: () => 'A step at a time — each one checked before the next', render: () => wrap(<Pick />) },
    'connect-step': { label: 'Step', icon: 'solar:checklist-minimalistic-linear', accent: 'var(--series-3)', title: (p) => `${t(p)} · ${Number(p.i) + 1}. ${String(p.stepTitle ?? 'step')}`, subtitle: (p) => (p.passed ? 'Done' : 'Do this, then check it'), render: () => wrap(<Step />) },
    'connect-node': { label: 'Data', icon: 'solar:folder-open-linear', accent: 'var(--series-3)', title: (p) => `${String(p.name)} › ${((p.labels as string[]) ?? []).join(' › ')}`, subtitle: (p) => (p.table ? 'Its first rows, as you may see them' : 'What is inside it'), render: () => wrap(<SeeNode />) },
    'connect-name': { label: 'Name it', icon: 'solar:pen-new-square-linear', accent: 'var(--series-3)', title: (p) => (p.made ? `${(p.made as any).name} is made` : `${t(p)} · name it`), render: () => wrap(<Name />) },
    'connect-mine': { label: 'Your own', icon: 'solar:key-linear', accent: 'var(--series-3)', title: (p) => `${t(p)} · your own`, render: () => wrap(<Mine />) },
    'connect-see': { label: 'Its data', icon: 'solar:eye-linear', accent: 'var(--win)', title: (p) => `${String(p.name)} · its data`, subtitle: () => 'As you may see it', render: () => wrap(<See />) },
  }
}
