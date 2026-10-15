// CONNECTING A SOURCE — one flow for every connector and every person (docs/connectors-plan.md 7d), shown a step at a
// time (progressive: only what is needed now). Pick what to connect → the connector's own setup steps, each with what to
// do and its few fields, each PROVEN by its check before the next opens (✓ what passed, or what was wrong and how to fix
// it) → name it → made → a person's own steps (their account) → its data, seen. A value changed after a step passed
// opens that step again. What is not secret is kept in this browser, so a setup left half-way is picked up again.
// The surface gives the flow its doors (an adapter): the console and the app draw the same flow.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import Track, { type TrackStep } from './Track'
import { Notice, Field, ConnectorFields, CopyButton, Code, RecordList, Empty, Status, type FormField } from './index'

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
  /** Whether the engine runs it now (its state, in words, while not). */
  ready: (id: string) => Promise<{ ready: boolean; state?: string }>
  /** Its entities, then rows of one (as the person asking). */
  entities: (id: string) => Promise<{ name: string; label?: string; description?: string }[]>
  read: (id: string, entity: string) => Promise<Record<string, unknown>[]>
  /** One's own account (OAuth): the address to sign in at. */
  signIn?: (id: string) => Promise<{ url: string } | { error: string }>
  /** One's own key, for a source read with each person's own. */
  giveKey?: (id: string, values: Record<string, unknown>) => Promise<{ ok: true } | { error: string }>
  /** The organisation's app with a provider, set here (who may). */
  setApp?: (provider: string, clientId: string, clientSecret: string) => Promise<{ ok: true } | { error: string }>
  /** Where what is not secret is kept between visits. */
  keepKey: string
  onDone: (id: string, name: string) => void
  /** The connector agent (a source written for, not chosen). */
  onCustom?: () => void
}

type Phase = { at: 'pick' } | { at: 'steps'; i: number } | { at: 'name' } | { at: 'loading'; id: string } | { at: 'person'; id: string; i: number } | { at: 'see'; id: string }
const remember = (k: string, v: unknown) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)) } catch { /* private window */ } }
const recall = <T,>(k: string): T | null => { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) as T : null } catch { return null } }

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

export function ConnectFlow({ adapter, start }: { adapter: ConnectAdapter; /** a connector already chosen (its id) */ start?: string }) {
  const [list, setList] = useState<FlowConnector[] | null>(null)
  const [q, setQ] = useState('')
  const [c, setC] = useState<FlowConnector | null>(null)
  const [phase, setPhase] = useState<Phase>({ at: 'pick' })
  const [values, setValues] = useState<Record<string, string>>({})
  // each step proven: its answer, and the values it was proven with (a change opens it again)
  const [proven, setProven] = useState<Record<string, { a: CheckAnswer; with: string }>>({})
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [auth, setAuth] = useState<'shared' | 'per-user'>('shared')
  const [description, setDescription] = useState('')
  const [err, setErr] = useState('')
  const kept = useRef(false)
  useEffect(() => { adapter.catalogue().then(setList).catch(() => setList([])) }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const before = useMemo(() => (c?.setup ?? []).filter((s) => s.who !== 'person'), [c])
  const person = useMemo(() => (c?.setup ?? []).filter((s) => s.who === 'person'), [c])
  const personOnly = !!c && !(c.identity ?? ['shared']).includes('shared')
  const secret = (k: string) => c?.fields.find((f) => f.name === k)?.type === 'secret'
  const stepValues = (s: FlowStep) => JSON.stringify((s.fields ?? []).map((f) => values[f] ?? ''))

  // A setup left half-way: picked up again (what is not secret; secrets are asked again)
  useEffect(() => {
    if (!list || kept.current) return
    kept.current = true
    const k = recall<{ connector: string; values: Record<string, string>; i: number; name?: string }>(adapter.keepKey)
    const was = k && list.find((x) => x.id === k.connector && (!start || x.id === start))
    const chosen = !was && start ? list.find((x) => x.id === start) : null
    if (chosen) { choose(chosen); return }
    if (was) { setC(was); setValues(k!.values ?? {}); setName(k!.name ?? ''); setPhase({ at: 'steps', i: Math.min(k!.i, (was.setup ?? []).filter((s) => s.who !== 'person').length - 1) }) }
  }, [list])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!c || phase.at === 'pick') return
    if (phase.at === 'see' || phase.at === 'person' || phase.at === 'loading') { remember(adapter.keepKey, null); return }
    remember(adapter.keepKey, { connector: c.id, values: Object.fromEntries(Object.entries(values).filter(([k]) => !secret(k))), i: phase.at === 'steps' ? phase.i : before.length, name })
  }, [c, phase, values, name])   // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (x: FlowConnector) => {
    setC(x); setValues({}); setProven({}); setErr(''); setName(x.title.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, ''))
    setAuth((x.identity ?? ['shared']).includes('shared') ? 'shared' : 'per-user'); setDescription('')
    const steps = (x.setup ?? []).filter((s) => s.who !== 'person')
    setPhase(steps.length ? { at: 'steps', i: 0 } : { at: 'name' })
  }
  const restart = () => { remember(adapter.keepKey, null); setC(null); setPhase({ at: 'pick' }); setValues({}); setProven({}) }

  const runCheck = async (s: FlowStep, connection?: string) => {
    setBusy(true); setErr('')
    try {
      const a = s.check ? await adapter.check(c!.id, s.id, Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '')), connection) : { ok: true, said: 'Done.' }
      setProven((p) => ({ ...p, [s.id]: { a, with: stepValues(s) } }))
      return a.ok
    } catch (e: any) { setProven((p) => ({ ...p, [s.id]: { a: { ok: false, said: 'It could not be checked.', error: String(e?.message ?? e) }, with: stepValues(s) } })); return false }
    finally { setBusy(false) }
  }
  const passed = (s: FlowStep) => proven[s.id]?.a.ok && proven[s.id].with === stepValues(s)

  const create = async () => {
    setBusy(true); setErr('')
    const r = await adapter.create(c!.id, { name: name.trim(), values: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '')), auth, ...(description.trim() ? { description: description.trim() } : {}) })
    setBusy(false)
    if ('error' in r) { setErr(r.error); return }
    setPhase({ at: 'loading', id: r.id })
  }
  // made: the engine loads it — then each person's own steps, then its data
  useEffect(() => {
    if (phase.at !== 'loading') return
    let stop = false
    void (async () => {
      for (let i = 0; i < 60 && !stop; i++) {
        const r = await adapter.ready(phase.id).catch(() => ({ ready: false }))
        if (r.ready) break
        await new Promise((res) => setTimeout(res, 2000))
      }
      if (stop) return
      const needsMine = person.length || (auth === 'per-user' && adapter.giveKey && !c?.oauth)
      setPhase(needsMine ? { at: 'person', id: phase.id, i: 0 } : { at: 'see', id: phase.id })
    })()
    return () => { stop = true }
  }, [phase])   // eslint-disable-line react-hooks/exhaustive-deps

  const track: TrackStep[] = c ? [
    ...before.map((s, i) => ({ key: s.id, label: s.title, state: (phase.at === 'steps' ? (i < phase.i ? 'done' : i === phase.i ? 'current' : 'ahead') : 'done') as TrackStep['state'] })),
    { key: '_name', label: 'Name it', state: phase.at === 'name' ? 'current' : phase.at === 'steps' ? 'ahead' : 'done' },
    ...(person.length || auth === 'per-user' ? [{ key: '_mine', label: c.oauth ? 'Your account' : 'Your key', state: (phase.at === 'person' ? 'current' : phase.at === 'see' ? 'done' : 'ahead') as TrackStep['state'] }] : []),
    { key: '_see', label: 'See its data', state: phase.at === 'see' ? 'current' : 'ahead' },
  ] : []

  // ── pick ──
  if (phase.at === 'pick' || !c) {
    const shown = (list ?? []).filter((x) => (adapter.level === 'project' ? (x.levels ?? ['project']).includes('project') : (x.levels ?? []).includes('user')) && (!q.trim() || `${x.title} ${x.id} ${x.description}`.toLowerCase().includes(q.trim().toLowerCase())))
    const groups: [string, FlowConnector[]][] = [["Your organisation's", shown.filter((x) => x.org)], ['Databases', shown.filter((x) => !x.org && x.id !== 'code' && x.kind === 'sql')], ['Apps and files', shown.filter((x) => !x.org && x.id !== 'code' && x.kind !== 'sql')]]
    return (
      <div className="sa-stack sa-stack--3">
        <input className="sa-input" autoFocus placeholder="What do you want to connect? (Postgres, Google Sheets, an API…)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a connector" />
        {!list ? <p className="sa-muted"><span className="sa-spinner" /> Reading what can be connected…</p> : groups.filter(([, xs]) => xs.length).map(([label, xs]) => (
          <div key={label} className="sa-stack sa-stack--2">
            <span className="sa-muted">{label}</span>
            <div className="sa-sub-grid">{xs.map((x) => (
              <button key={x.id} type="button" className="sa-sub-card" onClick={() => choose(x)}>
                <span className="sa-sub-card__title"><span className="sa-row sa-row--tight"><Icon icon={x.icon ?? (x.kind === 'sql' ? 'solar:database-linear' : 'solar:global-linear')} width={20} height={20} />{x.title}</span></span>
                <span className="sa-sub-card__text">{x.description}</span>
              </button>))}
            </div>
          </div>))}
        {list && !shown.length && <Empty icon="lucide:search">Nothing by that name.{adapter.onCustom ? ' The connector agent can write one for it.' : ''}</Empty>}
        {adapter.onCustom && list && <p className="sa-muted">Not here? <button className="sa-btn sa-btn--link" onClick={adapter.onCustom}>Ask the connector agent to write one</button></p>}
      </div>
    )
  }

  const head = (
    <div className="sa-stack sa-stack--2">
      <div className="sa-row sa-row--tight"><Icon icon={c.icon ?? 'solar:link-round-linear'} width={22} height={22} /><strong>{c.title}</strong>
        {(phase.at === 'steps' || phase.at === 'name') && <button className="sa-btn sa-btn--link" onClick={restart}>Something else</button>}</div>
      <Track steps={track} label="Connecting" />
    </div>
  )

  // ── the connector's own steps, one at a time ──
  if (phase.at === 'steps') {
    const s = before[phase.i], done = passed(s), answer = proven[s.id]?.with === stepValues(s) ? proven[s.id]?.a : undefined
    const fields = c.fields.filter((f) => (s.fields ?? []).includes(f.name))
    const next = () => setPhase(phase.i + 1 < before.length ? { at: 'steps', i: phase.i + 1 } : { at: 'name' })
    const appMissing = s.check?.kind === 'oauth-app' && answer && !answer.ok
    return (
      <div className="sa-stack sa-stack--3">
        {head}
        <h3 className="sa-flow__title">{phase.i + 1}. {s.title}</h3>
        <Say text={s.say} values={values} />
        {(s.copy ?? []).map((x) => <div key={x.label} className="sa-stack sa-stack--1"><span className="sa-row sa-row--tight sa-muted">{x.label}<CopyButton text={x.value} className="sa-btn sa-btn--link" /></span><pre className="sa-code" style={{ whiteSpace: 'pre-wrap' }}>{x.value}</pre></div>)}
        {fields.length > 0 && <div className="sa-stack sa-stack--2"><ConnectorFields idPrefix={`cf-${s.id}`} fields={fields} values={values} onChange={setValues} /></div>}
        {appMissing && c.oauth && <SetApp adapter={adapter} provider={c.oauth.provider} callback={answer!.callback} onSet={() => void runCheck(s)} />}
        {answer && <Answer a={answer} />}
        <div className="sa-row sa-row--tight">
          {phase.i > 0 && <button className="sa-btn" onClick={() => setPhase({ at: 'steps', i: phase.i - 1 })}>Back</button>}
          {done ? <button className="sa-btn sa-btn--primary" autoFocus onClick={next}>Next</button>
            : <button className="sa-btn sa-btn--primary" disabled={busy} onClick={() => void runCheck(s).then((ok) => { if (ok && !s.check) next() })}>{busy ? <span className="sa-spinner" /> : null}{s.check ? (fields.length ? 'Check it' : "I've done this — check it") : 'Next'}</button>}
        </div>
      </div>
    )
  }

  // ── its name, and who reads it ──
  if (phase.at === 'name') {
    const both = (c.identity ?? []).includes('shared') && (c.identity ?? []).includes('person-key') && adapter.level === 'project'
    return (
      <div className="sa-stack sa-stack--3">
        {head}
        <h3 className="sa-flow__title">Name it</h3>
        <Field label="Name" help="How people and agents call it — SALES_DB, CRM. Keep it: what names it later finds it by this."><input id="cf-name" className="sa-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        {both && <Field label="Who it reads as" help={auth === 'per-user' ? 'Each person gives their own key: what they read is what their own account may read.' : 'Everyone reads with the account you gave.'}>
          <select id="cf-auth" className="sa-input" value={auth} onChange={(e) => setAuth(e.target.value as 'shared' | 'per-user')}><option value="shared">Everyone, with the account above</option><option value="per-user">Each person, with their own key</option></select></Field>}
        {personOnly && <p className="sa-muted">Each person connects their own {c.oauth ? `${c.oauth.provider === 'google' ? 'Google' : c.oauth.provider} account` : 'key'}: what they read is what it may read.</p>}
        <details><summary className="sa-muted">Describe what it holds (optional)</summary><textarea id="cf-desc" className="sa-input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Orders and customers since 2019, from the shop" /></details>
        {err && <Notice state="critical">{err}</Notice>}
        <div className="sa-row sa-row--tight">
          {before.length > 0 && <button className="sa-btn" onClick={() => setPhase({ at: 'steps', i: before.length - 1 })}>Back</button>}
          <button className="sa-btn sa-btn--primary" disabled={busy || !name.trim()} onClick={() => void create()}>{busy ? <span className="sa-spinner" /> : null}Connect it</button>
        </div>
      </div>
    )
  }

  if (phase.at === 'loading') return <div className="sa-stack sa-stack--3">{head}<p className="sa-muted"><span className="sa-spinner" /> Made — the engine is loading it…</p></div>

  // ── one's own: their account, or their key ──
  if (phase.at === 'person') return <div className="sa-stack sa-stack--3">{head}<Mine adapter={adapter} c={c} id={phase.id} step={person[0]} check={(s) => runCheck(s, phase.id)} proven={person[0] ? proven[person[0].id]?.a : undefined} onDone={() => setPhase({ at: 'see', id: phase.id })} /></div>

  // ── its data, seen ──
  return <div className="sa-stack sa-stack--3">{head}<See adapter={adapter} id={phase.id} name={name} onDone={() => adapter.onDone(phase.id, name)} onAnother={restart} /></div>
}

/** The organisation's app with a provider, set where the step stands (who may; else who to ask). */
function SetApp({ adapter, provider, callback, onSet }: { adapter: ConnectAdapter; provider: string; callback?: string; onSet: () => void }) {
  const [id, setId] = useState(''), [secret, setSecret] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false)
  const title = provider === 'google' ? 'Google' : provider
  if (!adapter.setApp) return <Notice state="attention">An organisation admin sets your organisation's {title} app (Organisation → Connectors → Sign-in apps). Ask one, then check again.</Notice>
  const save = async () => { setBusy(true); setErr(''); const r = await adapter.setApp!(provider, id.trim(), secret.trim()); setBusy(false); if ('error' in r) setErr(r.error); else onSet() }
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

/** One's own account (OAuth — a window to sign in, watched until it is done) or one's own key. */
function Mine({ adapter, c, id, step, check, proven, onDone }: { adapter: ConnectAdapter; c: FlowConnector; id: string; step?: FlowStep; check: (s: FlowStep) => Promise<boolean>; proven?: CheckAnswer; onDone: () => void }) {
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false), [vals, setVals] = useState<Record<string, string>>({})
  const title = c.oauth ? (c.oauth.provider === 'google' ? 'Google' : c.oauth.provider) : ''
  useEffect(() => {
    if (!c.oauth || !step) return
    const on = (e: MessageEvent) => { if ((e.data as any)?.t === 'oauth:done') void check(step).then((ok) => { if (ok) onDone() }) }
    window.addEventListener('message', on); return () => window.removeEventListener('message', on)
  }, [c, step])   // eslint-disable-line react-hooks/exhaustive-deps
  if (c.oauth && adapter.signIn && step) {
    const go = async () => { setErr(''); const r = await adapter.signIn!(id); if ('error' in r) { setErr(r.error); return } if (!window.open(r.url, 'sa-oauth', 'popup,width=520,height=700')) window.location.assign(r.url) }
    return (
      <div className="sa-stack sa-stack--3">
        <h3 className="sa-flow__title">{step.title}</h3>
        <Say text={step.say} values={{}} />
        {proven && <Answer a={proven} />}
        {err && <Notice state="critical">{err}</Notice>}
        <div className="sa-row sa-row--tight">
          <button className="sa-btn sa-btn--primary" onClick={() => void go()}><Icon icon={c.icon ?? 'lucide:log-in'} width={16} height={16} />Connect my {title} account</button>
          <button className="sa-btn" onClick={() => void check(step).then((ok) => { if (ok) onDone() })}>I've connected it — check</button>
        </div>
      </div>
    )
  }
  const save = async () => { setBusy(true); setErr(''); const r = await adapter.giveKey!(id, Object.fromEntries(Object.entries(vals).filter(([, v]) => v !== ''))); setBusy(false); if ('error' in r) setErr(r.error); else onDone() }
  return (
    <div className="sa-stack sa-stack--3">
      <h3 className="sa-flow__title">Your own key</h3>
      <p className="sa-say">Each person reads it with their own key. Give yours — usually only your user name and password; the rest is the source's own.</p>
      <ConnectorFields idPrefix="cf-mine" fields={c.fields.map((f) => ({ ...f, required: false }))} values={vals} onChange={setVals} />
      {err && <Notice state="critical">{err}</Notice>}
      <div className="sa-row sa-row--tight"><button className="sa-btn" onClick={onDone}>Later</button><button className="sa-btn sa-btn--primary" disabled={busy || !Object.values(vals).some(Boolean)} onClick={() => void save()}>{busy ? <span className="sa-spinner" /> : null}Keep it</button></div>
    </div>
  )
}

/** Its data, as the person asking sees it: what it offers, a click into the rows (a row that opens something, opened). */
function See({ adapter, id, name, onDone, onAnother }: { adapter: ConnectAdapter; id: string; name: string; onDone: () => void; onAnother: () => void }) {
  const [ents, setEnts] = useState<{ name: string; label?: string }[] | null>(null)
  const [trail, setTrail] = useState<{ entity: string; label: string }[]>([])
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { adapter.entities(id).then((e) => { setEnts(e); if (e[0]) setTrail([{ entity: e[0].name, label: e[0].label ?? e[0].name }]) }).catch((e) => setErr(String(e?.message ?? e))) }, [id])   // eslint-disable-line react-hooks/exhaustive-deps
  const at = trail.at(-1)
  useEffect(() => { if (!at) return; setRows(null); adapter.read(id, at.entity).then(setRows).catch((e) => { setErr(String(e?.message ?? e)); setRows([]) }) }, [at?.entity])   // eslint-disable-line react-hooks/exhaustive-deps
  const cols = rows?.length ? Object.keys(rows[0]).filter((k) => k !== '_open').slice(0, 7) : []
  const labelOf = (r: Record<string, unknown>) => String(r.name ?? r.title ?? r.sheet ?? Object.values(r).find((v) => typeof v === 'string') ?? 'it')
  const works = !!rows && !err
  return (
    <div className="sa-stack sa-stack--3">
      <h3 className="sa-flow__title">{works ? `${name} is connected — here is its data` : 'Its data'}</h3>
      {err && <Notice state="critical">It is made, but reading it did not work: {err}</Notice>}
      {ents && ents.length > 1 && <div className="sa-row sa-row--tight sa-row--wrap">{ents.slice(0, 30).map((e) => <button key={e.name} className={`sa-btn${trail[0]?.entity === e.name ? ' sa-btn--primary' : ''}`} onClick={() => setTrail([{ entity: e.name, label: e.label ?? e.name }])}>{e.label ?? e.name}</button>)}</div>}
      {trail.length > 1 && <nav className="sa-row sa-row--tight sa-row--wrap" aria-label="Where you are">{trail.map((t, i) => <span key={t.entity} className="sa-row sa-row--tight">{i ? '›' : ''}{i === trail.length - 1 ? <strong>{t.label}</strong> : <button className="sa-btn sa-btn--link" onClick={() => setTrail(trail.slice(0, i + 1))}>{t.label}</button>}</span>)}</nav>}
      {!ents && !err ? <p className="sa-muted"><span className="sa-spinner" /> Asking what it holds…</p> : ents && !ents.length ? <Empty icon="lucide:inbox">It answers, and holds nothing it lets this account read yet.</Empty>
        : <RecordList pageSize={10} rows={rows ? rows.map((r, i) => ({ ...r, __i: i })) : null} keyOf={(r: any) => String(r.__i)} empty="Nothing here." onRow={rows?.some((r) => r._open) ? (r: any) => { if (r._open) setTrail([...trail, { entity: String(r._open), label: labelOf(r) }]) } : undefined}
            columns={cols.map((k) => ({ key: k, label: k, render: (r: any) => (r[k] === null || r[k] === undefined ? '—' : typeof r[k] === 'object' ? JSON.stringify(r[k]).slice(0, 60) : String(r[k]).slice(0, 80)) }))} />}
      {works && <Status state="ok">Agents can ask it now; its index is being built.</Status>}
      <div className="sa-row sa-row--tight"><button className="sa-btn" onClick={onAnother}>Connect another</button><button className="sa-btn sa-btn--primary" onClick={onDone}>Open it</button></div>
    </div>
  )
}
