// CONNECTORS AND CONNECTIONS in the console (docs/connectors-plan.md 7c) — one file for every journey, each screen
// reading the platform's routes and showing an action only to who may do it (else disabled, saying what it needs):
//   ProjectConnectorsPanel   a project: what can be connected (Superatom's, the organisation's — every version, its
//                            manifest and code), and how to build one (the Connector agent, or sacli on a laptop)
//   ProjectConnectionsPanel  a project: its connections — add one from a connector's form, open one: its version (update,
//                            roll back, move), its settings, shared or each person's own key, test, restart, remove, events
//   OrgConnectorsPanel       an organisation: its registry — where each runs, block / unblock, approve, the approval setting
//   PlatformConnectorsPage   Superatom: its connectors and their builds; each organisation's registry at a glance
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Section, RecordList, Notice, Status, Code, Toolbar, Receipt, Form, Field, ConnectorFields, CopyButton, Dialog, ActionBar, PageHeader, Figures, Kpi, Icon, ConnectFlow, dateTime, useConfirm, type FormField, type StatusState, type ConnectAdapter } from '@superatom/ui'
import { WORKLOAD_KINDS } from '../../../vm/packages/platform-types/src/workloads.js'
import { NAMES } from './places'
import { Shell, useAuth, useApi } from './console'

type Api = (p: string, i?: RequestInit) => Promise<Response>
interface Manifest { id: string; title: string; icon?: string; kind?: string; dialect?: string; description?: string; levels?: string[]; identity?: string[]; fields?: FormField[]; actions?: { name: string; label?: string; effect?: string }[] }
interface Version { connector: string; hash: string; manifest: Manifest; bytes: number; status: 'ready' | 'proposed'; published_by: string; from_project: string; published_at: string; approved_by: string | null; blocked_at: string | null; blocked_by: string | null }
interface OrgConnector { id: string; title: string; made_by: string; from_project: string; created_at: string; blocked_at: string | null; blocked_by: string | null; versions: Version[]; current: Version | null }
interface Catalogued { id: string; title: string; kind: string; dialect?: string; description: string; levels: string[]; identity?: string[]; oauth?: { provider: string; scopes: string[] }; fields: FormField[]; version?: string; icon?: string; builtin?: boolean; org?: { madeBy: string; fromProject: string; blocked: boolean } }
interface Used { id: string; name: string; connector: string; bridge: string | null; previous_bridge: string | null; auth: string | null }
interface Registry { superatom: Catalogued[]; organisation: OrgConnector[]; approval: boolean; connections: Used[]; note?: string }
interface Conn { id: string; name: string; connector: string; level: string; settings: Record<string, unknown>; kind?: string; dialect?: string; description?: string; auth?: string; created_by?: string; created_at?: string; bridge?: string | null; previous_bridge?: string | null; state?: string; runnable?: boolean; note?: string }
interface Workload { kind: string; id: string; state: string; newer?: string; canRollBack?: boolean; error: { what: string; detail?: string } | null; restarts: number; version: string | null }
interface WEvent { seq: number; at: number; what: string; by: string | null; detail: string | null }

const short = (h?: string | null) => (h ? h.slice(0, 12) : '—')
const readJson = async (r: Response) => { const j = await r.json().catch(() => ({})) as any; if (!r.ok) throw new Error(j.error ?? `the platform answered ${r.status}`); return j }
const kindIcon = (kind?: string) => (kind === 'sql' ? 'solar:database-linear' : kind === 'documents' ? 'solar:documents-linear' : 'solar:global-linear')
const iconOf = (m?: { icon?: string; kind?: string }) => m?.icon ?? kindIcon(m?.kind)
const projectName = (id: string, here?: string) => (id === here ? 'this project' : NAMES.get(id) ?? `project ${id.slice(0, 8)}`)
const signIn = (identity?: string[]) => (identity ?? ['shared']).map((i) => (i === 'shared' ? 'one shared account' : i === 'person-key' ? "each person's own key" : i === 'person-oauth' ? 'each person signs in (OAuth)' : i)).join(' or ')
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
/** What a button needs and the person lacks — said on the button (disabled), never hidden behind an error after. */
const lacking = (caps: string[] | null, need: string) => (caps && !caps.includes(need) ? `needs ${need}` : null)
const capsOf = (api: Api, path: string) => api(path).then((r) => (r.ok ? r.json() : null)).then((d: any) => (d?.capabilities ?? []) as string[]).catch(() => [] as string[])

function Gate({ caps, need, children }: { caps: string[] | null; need: string; children: (disabled: boolean, title?: string) => ReactNode }) {
  const no = lacking(caps, need)
  return <>{children(!!no, no ?? undefined)}</>
}

/** A version's code, read only — what will run on the engine. */
function CodeDialog({ api, projectId, id, hash, onClose }: { api: Api; projectId: string; id: string; hash: string; onClose: () => void }) {
  const [code, setCode] = useState<string | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { api(`/projects/${projectId}/connectors/${id}/code/${hash}`).then(readJson).then((d) => setCode(d.code ?? '')).catch((e) => setErr(e.message)) }, [api, projectId, id, hash])
  return (
    <Dialog wide title={`${id} · ${short(hash)}`} onClose={onClose} actions={<>{code && <CopyButton text={code} label="Copy the code" />}<button className="sa-btn sa-btn--primary" onClick={onClose}>Close</button></>}>
      {err ? <Notice state="critical">{err}</Notice> : code === null ? <p className="sa-muted"><span className="sa-spinner" /> Reading its code…</p>
        : <><p className="sa-muted">What runs on the engine, as built ({kb(code.length)}). Read only: a change is a new version, published.</p>
          <pre className="sa-code" style={{ whiteSpace: 'pre', overflow: 'auto', maxHeight: '60vh' }}>{code}</pre></>}
    </Dialog>
  )
}

/** What a connector is, as a person reads its manifest: what it reaches, how people sign in, the form it asks, its actions. */
function ManifestReceipt({ m, extra = [] }: { m: Manifest; extra?: [string, ReactNode][] }) {
  return <Receipt items={[
    ['Reaches', m.description ?? '—'],
    ['Kind', [m.kind === 'api' || m.kind === 'rest' ? 'an API' : m.kind === 'documents' ? 'a document store' : 'a SQL database', m.dialect && m.dialect !== 'api' ? `(${m.dialect})` : ''].filter(Boolean).join(' ')],
    ['People sign in with', signIn(m.identity)],
    ['Its form', (m.fields ?? []).length ? (m.fields ?? []).map((f) => `${f.label}${f.type === 'secret' ? ' (secret)' : ''}${f.required ? '' : ' (optional)'}`).join(' · ') : 'nothing asked'],
    ...((m.actions ?? []).length ? [['Its actions', (m.actions ?? []).map((a) => `${a.label ?? a.name}${a.effect && a.effect !== 'read' ? ` (${a.effect === 'irreversible' ? 'cannot be undone' : 'changes'})` : ''}`).join(' · ')] as [string, ReactNode]] : []),
    ...extra,
  ]} />
}

// ── 1. A project's connectors: what can be connected here, and building one ────────────────────────────────────────
export function ProjectConnectorsPanel({ api, projectId }: { api: Api; projectId: string }) {
  const nav = useNavigate()
  const [reg, setReg] = useState<Registry | null>(null)
  const [caps, setCaps] = useState<string[] | null>(null)
  const [err, setErr] = useState('')
  const [focus, setFocus] = useState<string | null>(null)
  const [code, setCode] = useState<{ id: string; hash: string } | null>(null)
  const load = useCallback(() => api(`/projects/${projectId}/connectors/registry`).then(readJson).then((d) => { setReg(d); setErr('') }).catch((e) => setErr(`The connectors could not be read: ${e.message}`)), [api, projectId])
  useEffect(() => { void load(); void capsOf(api, `/projects/${projectId}/me`).then(setCaps) }, [load, api, projectId])
  const usedBy = (id: string) => (reg?.connections ?? []).filter((c) => c.connector === id)
  const mayRead = !!caps && (caps.includes('project.data') || caps.includes('project.connectors'))
  const org = reg?.organisation ?? []
  const ours = reg?.superatom ?? []
  const fo = org.find((c) => c.id === focus), fs = ours.find((c) => c.id === focus)
  const versionState = (c: OrgConnector): { s: StatusState; t: string } => c.blocked_at ? { s: 'critical', t: 'blocked' } : !c.current ? { s: 'attention', t: 'waiting for approval' } : c.versions.some((v) => v.status === 'proposed') ? { s: 'attention', t: `ready · ${c.versions.filter((v) => v.status === 'proposed').length} waiting` } : { s: 'ok', t: 'ready' }
  const lines = `sacli connectors init my-connector\ncd my-connector && pnpm install\nsacli connectors build .\nsacli connectors publish .`
  return (
    <div className="sa-stack sa-stack--4">
      {err && <Notice state="critical">{err}</Notice>}
      {reg?.note && <Notice state="attention">{reg.note}</Notice>}
      {code && <CodeDialog api={api} projectId={projectId} id={code.id} hash={code.hash} onClose={() => setCode(null)} />}

      <Section icon="solar:code-square-linear" title="Build a connector" subtitle="A connector reaches a system — a database, an API — and runs on the engine, one process per connection.">
        <div className="sa-section__body sa-stack">
          <div className="sa-sub-grid">
            <Gate caps={caps} need="project.connectors">{(off, why) => (
              <button type="button" className="sa-sub-card" disabled={off} title={why} onClick={() => nav('../agent', { relative: 'path' })}>
                <span className="sa-sub-card__title"><span className="sa-row sa-row--tight"><Icon icon="solar:link-round-linear" width={18} height={18} />Ask the Connector agent</span></span>
                <span className="sa-sub-card__text">Say what to connect and give it the credentials; it writes the connector, tests it against the source, and publishes it when it works.{why ? ` (${why})` : ''}</span>
              </button>)}</Gate>
            <div className="sa-sub-card">
              <span className="sa-sub-card__title"><span className="sa-row sa-row--tight"><Icon icon="solar:laptop-linear" width={18} height={18} />On your laptop, with sacli</span></span>
              <span className="sa-sub-card__text">A folder of its own: a manifest (its form, how people sign in) and the code. Built exactly as the platform builds it; published from this project.</span>
              <pre className="sa-code" style={{ whiteSpace: 'pre-wrap' }}>{lines}</pre>
              <ActionBar><CopyButton text={lines} label="Copy" /></ActionBar>
            </div>
          </div>
          <p className="sa-muted">A published version is usable here at once and offered to the organisation's other projects. A connection stays on the version it runs until someone updates it, so a new version changes nothing by itself.{reg?.approval ? ' This organisation asks for approval: a new version waits for an organisation admin.' : ''}</p>
        </div>
      </Section>

      <Section icon="solar:buildings-2-linear" title="The organisation's connectors" subtitle="Published from its projects — choose one for its versions, its form and its code" note={reg ? `${org.length}` : undefined}>
        <RecordList search pageSize={15} rows={reg ? org : null} keyOf={(c) => c.id} onRow={(c) => setFocus(c.id)} empty="None yet — build one above." columns={[
          { key: 'title', label: 'Connector', render: (c) => <span className="sa-row sa-row--tight"><Icon icon={iconOf(c.current?.manifest ?? c.versions[0]?.manifest)} width={18} height={18} /><strong>{c.title}</strong> <span className="sa-muted">{c.id}</span></span> },
          { key: 'state', label: 'State', render: (c) => { const v = versionState(c); return <Status state={v.s}>{v.t}</Status> } },
          { key: 'version', label: 'Current version', render: (c) => c.current ? <span title={c.current.hash}><Code>{short(c.current.hash)}</Code> <span className="sa-muted">{dateTime(c.current.published_at)}</span></span> : '—' },
          { key: 'from', label: 'Made by', render: (c) => <span>{c.made_by} <span className="sa-muted">in {projectName(c.from_project, projectId)}</span></span> },
          { key: 'used', label: 'Used here', align: 'end', render: (c) => usedBy(c.id).length || '—' },
        ]} />
      </Section>

      <Section icon="solar:star-linear" title="Superatom's connectors" subtitle="Built in, kept current by Superatom" note={reg ? `${ours.length}` : undefined}>
        <RecordList search pageSize={15} rows={reg ? ours : null} keyOf={(c) => c.id} onRow={(c) => setFocus(c.id)} columns={[
          { key: 'title', label: 'Connector', render: (c) => <span className="sa-row sa-row--tight"><Icon icon={iconOf(c)} width={18} height={18} /><strong>{c.title}</strong> <span className="sa-muted">{c.id}</span></span> },
          { key: 'kind', label: 'Kind', render: (c) => c.dialect && c.dialect !== 'api' ? c.dialect : c.kind },
          { key: 'version', label: 'Version', render: (c) => <Code>{short(c.version)}</Code> },
          { key: 'used', label: 'Used here', align: 'end', render: (c) => usedBy(c.id).length || '—' },
        ]} />
      </Section>

      {fo && (
        <Section icon="solar:plug-circle-linear" title={fo.title} subtitle={`${fo.id} · made by ${fo.made_by} in ${projectName(fo.from_project, projectId)}, ${dateTime(fo.created_at)}`} actions={<button className="sa-btn" onClick={() => setFocus(null)}>Close</button>}>
          {fo.blocked_at && <Notice state="critical">Blocked by {fo.blocked_by} on {dateTime(fo.blocked_at)}: its connections are not run, and it is not offered. An organisation admin unblocks it.</Notice>}
          <ManifestReceipt m={(fo.current ?? fo.versions[0]).manifest} extra={[['Used here by', usedBy(fo.id).map((u) => `${u.name} (${short(u.bridge)})`).join(' · ') || 'no connection']]} />
          <RecordList rows={fo.versions} keyOf={(v) => v.hash} columns={[
            { key: 'hash', label: 'Version', render: (v) => <span title={v.hash}><Code>{short(v.hash)}</Code>{fo.current?.hash === v.hash ? <span className="sa-muted"> current</span> : null}</span> },
            { key: 'status', label: 'State', render: (v) => <Status state={v.blocked_at ? 'critical' : v.status === 'proposed' ? 'attention' : 'ok'}>{v.blocked_at ? 'blocked' : v.status === 'proposed' ? 'waiting for approval' : 'ready'}</Status> },
            { key: 'by', label: 'Published', render: (v) => <span>{v.published_by} <span className="sa-muted">{dateTime(v.published_at)} · {projectName(v.from_project, projectId)}</span></span> },
            { key: 'size', label: 'Size', align: 'end', render: (v) => kb(v.bytes) },
            { key: 'runs', label: 'Runs here', render: (v) => usedBy(fo.id).filter((u) => u.bridge === v.hash).map((u) => u.name).join(', ') || '—' },
            { key: 'code', label: '', align: 'end', render: (v) => <button className="sa-btn sa-btn--link" disabled={!mayRead} title={mayRead ? undefined : 'needs project.data or project.connectors'} onClick={(e) => { e.stopPropagation(); setCode({ id: fo.id, hash: v.hash }) }}>Its code</button> },
          ]} />
        </Section>
      )}
      {fs && (
        <Section icon="solar:plug-circle-linear" title={fs.title} subtitle={`${fs.id} · Superatom's`} actions={<button className="sa-btn" onClick={() => setFocus(null)}>Close</button>}>
          <ManifestReceipt m={fs as Manifest} extra={[['Version', <Code key="v">{short(fs.version)}</Code>], ['Used here by', usedBy(fs.id).map((u) => `${u.name} (${short(u.bridge)})`).join(' · ') || 'no connection']]} />
          {fs.version && <ActionBar><button className="sa-btn" disabled={!mayRead} title={mayRead ? undefined : 'needs project.data or project.connectors'} onClick={() => setCode({ id: fs.id, hash: fs.version! })}>Its code</button></ActionBar>}
        </Section>
      )}
    </div>
  )
}

// ── 2. A project's connections: add, open, change, every action ────────────────────────────────────────────────────
export function ProjectConnectionsPanel({ api, orgApi, projectId, hub }: { api: Api; orgApi?: Api; projectId: string; hub?: { subscribe: (fn: (m: { t?: string }) => void) => () => void; call?: (p: Record<string, unknown>) => Promise<any> } }) {
  const nav = useNavigate()
  const [conns, setConns] = useState<Conn[] | null>(null)
  const [catalogue, setCatalogue] = useState<Catalogued[]>([])
  const [reg, setReg] = useState<Registry | null>(null)
  const [work, setWork] = useState<Workload[]>([])
  const [caps, setCaps] = useState<string[] | null>(null)
  const [err, setErr] = useState('')
  const [focus, setFocus] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const base = `/projects/${projectId}`
  const load = useCallback(() => {
    void api(`${base}/connections`).then(readJson).then((d) => { setConns((d.connections ?? []).filter((c: Conn) => c.level === 'project')); setErr('') }).catch((e) => setErr(`The connections could not be read: ${e.message}`))
    void api(`${base}/connectors`).then(readJson).then((d) => setCatalogue(d.connectors ?? [])).catch(() => {})
    void api(`${base}/connectors/registry`).then(readJson).then(setReg).catch(() => {})
    void api(`${base}/workloads`).then(readJson).then((d) => setWork((d.workloads ?? []).filter((w: Workload) => w.kind === 'connection'))).catch(() => {})
  }, [api, base])
  useEffect(() => { load(); void capsOf(api, `${base}/me`).then(setCaps) }, [load, api, base])
  useEffect(() => hub?.subscribe((m) => { if (m?.t === 'workload:update') void api(`${base}/workloads`).then(readJson).then((d) => setWork((d.workloads ?? []).filter((w: Workload) => w.kind === 'connection'))).catch(() => {}) }), [hub, api, base])
  const titleOf = (id: string) => catalogue.find((c) => c.id === id)?.title ?? reg?.organisation.find((c) => c.id === id)?.title ?? reg?.superatom.find((c) => c.id === id)?.title ?? id
  const wOf = (name: string) => work.find((w) => w.id === name)
  const stateOf = (c: Conn): { s: StatusState; t: string } => {
    const w = wOf(c.name)
    if (/^not run/.test(c.state ?? '')) return { s: 'critical', t: 'blocked' }
    if (c.runnable) return { s: 'ok', t: 'ready' }
    if (w?.state === 'degraded' || c.state === 'not reachable') return { s: 'critical', t: 'not reachable' }
    if (w?.state === 'failed') return { s: 'critical', t: 'failed' }
    return { s: 'attention', t: c.state ?? 'not ready' }
  }
  const builtin = (c: Conn) => c.connector === 'sa-warehouse'
  const fc = conns?.find((c) => c.id === focus)
  return (
    <div className="sa-stack sa-stack--4">
      {err && <Notice state="critical">{err}</Notice>}
      <Toolbar end={<Gate caps={caps} need="project.data">{(off, why) => <button className="sa-btn sa-btn--primary" disabled={off} title={why} onClick={() => { setAdding(true); setFocus(null) }}><Icon icon="lucide:plus" className="sa-btn__icon" />Connect a source</button>}</Gate>}>
        <span className="sa-muted">How each source is reached: its connector and the version it runs, its settings and keys.</span>
      </Toolbar>

      {adding && <Section icon="lucide:plus" title="Connect a source" subtitle="A step at a time — each one checked before the next" actions={<button className="sa-btn" onClick={() => setAdding(false)}>Close</button>}>
        <div className="sa-section__body"><ConnectFlow adapter={connectAdapter({ api, orgApi, projectId, hub, level: 'project', onDone: (id) => { setAdding(false); load(); setFocus(id) }, onCustom: () => nav('../agent', { relative: 'path' }) })} /></div>
      </Section>}

      <Section icon="solar:link-round-linear" title="Connections" subtitle="Choose one to look into it and change it" note={conns ? `${conns.length}` : undefined}>
        <RecordList search pageSize={20} rows={conns} keyOf={(c) => c.id} onRow={(c) => { setFocus(c.id); setAdding(false) }} empty="No source yet — connect one." columns={[
          { key: 'name', label: 'Source', render: (c) => <span className="sa-row sa-row--tight"><Icon icon={iconOf(catalogue.find((k) => k.id === c.connector) ?? { kind: c.kind })} width={18} height={18} /><strong>{c.name}</strong></span> },
          { key: 'connector', label: 'Connector', render: (c) => <span>{titleOf(c.connector)}{reg?.organisation.some((o) => o.id === c.connector) ? <span className="sa-muted"> · the organisation's</span> : null}</span> },
          { key: 'version', label: 'Version', render: (c) => builtin(c) ? <span className="sa-muted">kept by the platform</span> : <span><Code>{short(c.bridge)}</Code>{wOf(c.name)?.newer ? <> <Status state="attention">newer: {wOf(c.name)!.newer}</Status></> : null}</span> },
          { key: 'auth', label: 'Reached with', render: (c) => (c.auth === 'per-user' ? "each person's own key" : 'one shared key') },
          { key: 'state', label: 'State', render: (c) => { const s = stateOf(c); return <Status state={s.s}>{s.t}</Status> } },
        ]} />
      </Section>

      {fc && <ConnectionDetail key={fc.id} api={api} projectId={projectId} conn={fc} caps={caps} catalogue={catalogue} reg={reg} workload={wOf(fc.name)} state={stateOf(fc)} builtin={builtin(fc)}
        onClose={() => setFocus(null)} onChanged={load} onRemoved={() => { setFocus(null); load() }} openIndex={() => nav('../sources', { relative: 'path' })} openRunning={() => nav('../running', { relative: 'path' })} />}
    </div>
  )
}

/** The doors the Connect flow (ConnectFlow, @superatom/ui) goes through, in the console: the platform's routes for the
 *  catalogue, each step's check and making it; the project's hub to read it as the one asking. */
export function connectAdapter(o: { api: Api; orgApi?: Api; projectId: string; hub?: { call?: (p: Record<string, unknown>) => Promise<any> }; level: 'project' | 'user'; onDone: (id: string, name: string) => void; onCustom?: () => void }): ConnectAdapter {
  const base = `/projects/${o.projectId}`
  const ask = async (p: Record<string, unknown>) => { if (!o.hub?.call) throw new Error('not connected to the project'); const r = await o.hub.call(p); if (r?.t === 'connector:refused') throw new Error(r.reason); return r?.result }
  const res = async (r: Response) => { const d: any = await r.json().catch(() => ({})); return r.ok ? d : { error: d.error ?? `the platform answered ${r.status}` } }
  return {
    level: o.level, keepKey: `connect-flow:${o.projectId}:${o.level}`,
    catalogue: async () => ((await o.api(`${base}/connectors`).then(readJson)).connectors ?? []).filter((c: any) => c.id !== 'code' && !c.builtin),
    check: (connector, step, values, connection) => o.api(`${base}/connections/check`, { method: 'POST', body: JSON.stringify({ connector, step, values, level: o.level, ...(connection ? { connection } : {}) }) }).then(res).then((d) => (d.error && d.ok === undefined ? { ok: false, said: 'It could not be checked.', error: d.error } : d)),
    create: async (connector, x) => { const d = await o.api(`${base}/connections`, { method: 'POST', body: JSON.stringify({ connector, name: x.name, level: o.level, values: x.values, auth: x.auth, ...(x.description ? { description: x.description } : {}) }) }).then(res); return d.error ? { error: d.error } : { id: d.connection.id } },
    ready: async (id) => { const c = ((await o.api(`${base}/connections`).then(readJson)).connections ?? []).find((x: any) => x.id === id); return { ready: !!c?.runnable, state: c?.state } },
    entities: async (id) => ((await ask({ t: 'connector:introspect', connection: id }))?.entities ?? []).map((e: any) => ({ name: e.name, label: e.label, description: e.description })),
    read: async (id, entity) => (await ask({ t: 'connector:read', connection: id, entity, limit: 20 }))?.rows ?? [],
    signIn: async (id) => { const d = await o.api(`${base}/connections/${id}/oauth/start`, { method: 'POST' }).then(res); return d.error ? { error: d.error } : { url: d.url } },
    giveKey: async (id, values) => { const d = await o.api(`${base}/connections/${id}/my-key`, { method: 'PUT', body: JSON.stringify({ values }) }).then(res); return d.error ? { error: d.error } : { ok: true } },
    ...(o.orgApi ? { setApp: async (provider: string, clientId: string, clientSecret: string) => { const d = await o.orgApi!(`/oauth-apps/${provider}`, { method: 'PUT', body: JSON.stringify({ clientId, clientSecret }) }).then(res); return d.error ? { error: d.error } : { ok: true as const } } } : {}),
    onDone: o.onDone, ...(o.onCustom ? { onCustom: o.onCustom } : {}),
  }
}

function ConnectionDetail({ api, projectId, conn: c, caps, catalogue, reg, workload: w, state, builtin, onClose, onChanged, onRemoved, openIndex, openRunning }: {
  api: Api; projectId: string; conn: Conn; caps: string[] | null; catalogue: Catalogued[]; reg: Registry | null; workload?: Workload; state: { s: StatusState; t: string }; builtin: boolean
  onClose: () => void; onChanged: () => void; onRemoved: () => void; openIndex: () => void; openRunning: () => void
}) {
  const [confirm, dialog] = useConfirm()
  const [said, setSaid] = useState<{ state: 'ok' | 'critical'; text: string } | null>(null)
  const [busy, setBusy] = useState('')
  const [editing, setEditing] = useState(false)
  const [moving, setMoving] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [events, setEvents] = useState<WEvent[] | null>(null)
  const base = `/projects/${projectId}`
  const loadEvents = useCallback(() => api(`${base}/workloads/connection/${encodeURIComponent(c.name)}`).then(readJson).then((d) => setEvents(d.events ?? [])).catch(() => setEvents([])), [api, base, c.name])
  useEffect(() => { void loadEvents() }, [loadEvents])
  const connector = catalogue.find((k) => k.id === c.connector) ?? reg?.superatom.find((k) => k.id === c.connector)
  const orgOne = reg?.organisation.find((o) => o.id === c.connector)
  const runs = orgOne?.versions.find((v) => v.hash === c.bridge)
  const actions = WORKLOAD_KINDS.connection.actions as Record<string, { label: string; needs: string; says: string }>
  const act = async (action: string) => {
    const a = actions[action]
    if (!await confirm({ title: `${a.label}: ${c.name}?`, body: `${a.says[0].toUpperCase()}${a.says.slice(1)}. It is recorded, with your name.`, confirm: a.label })) return
    setBusy(action); setSaid(null)
    try { const j = await api(`${base}/workloads/connection/${encodeURIComponent(c.name)}/act`, { method: 'POST', body: JSON.stringify({ action }) }).then(readJson); setSaid({ state: 'ok', text: j.note ?? 'Done.' }); onChanged(); void loadEvents() }
    catch (e: any) { setSaid({ state: 'critical', text: e.message }) } finally { setBusy('') }
  }
  const patch = async (body: Record<string, unknown>, done: string) => {
    setBusy('patch'); setSaid(null)
    try { await api(`${base}/connections/${c.id}`, { method: 'PATCH', body: JSON.stringify(body) }).then(readJson); setSaid({ state: 'ok', text: done }); onChanged(); void loadEvents(); return true }
    catch (e: any) { setSaid({ state: 'critical', text: e.message }); return false } finally { setBusy('') }
  }
  const switchAuth = async () => {
    const to = c.auth === 'per-user' ? 'shared' : 'per-user'
    if (!await confirm({ title: to === 'per-user' ? `Read ${c.name} with each person's own key?` : `Read ${c.name} with one shared key?`,
      body: to === 'per-user' ? 'From now on each person reads with their own key, and one who gave none is refused, told how to give it. The shared values stay for the platform\'s own work (its index).' : 'From now on everyone reads with the shared account, whatever their own key reaches.', confirm: 'Change it' })) return
    await patch({ auth: to }, to === 'per-user' ? "It reads with each person's own key from now on." : 'It reads with the shared key from now on.')
  }
  const btn = (action: string, extra?: { hidden?: boolean; primary?: boolean }) => {
    if (extra?.hidden) return null
    const a = actions[action], no = lacking(caps, a.needs)
    return <button key={action} className={`sa-btn${extra?.primary ? ' sa-btn--primary' : ''}`} disabled={!!busy || !!no} title={no ?? a.says} onClick={() => void act(action)}>{busy === action ? <span className="sa-spinner" /> : null}{a.label}</button>
  }
  const dataNo = lacking(caps, 'project.data'), codeNo = lacking(caps, 'project.connectors')
  const settings = Object.entries(c.settings ?? {})
  return (
    <Section icon={iconOf(connector ?? { kind: c.kind })} title={c.name} subtitle={`${connector?.title ?? c.connector}${orgOne ? " · the organisation's" : ''}`} actions={<button className="sa-btn" onClick={onClose}>Close</button>}>
      {dialog}
      <div className="sa-row sa-row--wrap" style={{ gap: 'var(--sp-2)' }}>
        <Status state={state.s}>{state.t}</Status>
        {w?.newer && <Status state="attention">a newer version: {w.newer}</Status>}
        <span className="sa-muted">{c.auth === 'per-user' ? "read with each person's own key" : 'read with one shared key'}</span>
        {!!w?.restarts && <span className="sa-muted">{w.restarts} restart{w.restarts === 1 ? '' : 's'}</span>}
      </div>
      {(w?.error || /^not run/.test(c.state ?? '')) && <Notice state="critical">{/^not run/.test(c.state ?? '') ? c.state : w?.error?.what}{w?.error?.detail ? <div><Code>{w.error.detail}</Code></div> : null}</Notice>}
      {builtin && <Notice state="neutral">The platform's own source, in every project: kept current by the platform, never changed or removed here.</Notice>}
      <Receipt items={[
        ['Connector', <span key="k">{connector?.title ?? c.connector} <span className="sa-muted">{c.connector}</span></span>],
        ['Runs version', builtin ? 'kept by the platform' : <span key="v" title={c.bridge ?? ''}><Code>{short(c.bridge)}</Code>{runs ? <span className="sa-muted"> published by {runs.published_by}, {dateTime(runs.published_at)}</span> : null}</span>],
        ...(c.previous_bridge ? [['Before that', <Code key="p">{short(c.previous_bridge)}</Code>] as [string, ReactNode]] : []),
        ['Reached with', c.auth !== 'per-user' ? 'one shared key, sealed — never shown' : connector?.oauth ? `each person's own ${connector.oauth.provider === 'google' ? 'Google' : connector.oauth.provider} account — they connect it in the app (Connections → this source → Connect my account)` : "each person's own key — they give it in the app (Connections → this source → Your key) or sacli datasources my-key"],
        ['Settings', settings.length ? settings.map(([k, v]) => `${k} ${String(v)}`).join(' · ') : '—'],
        ...(c.description ? [['Description', c.description] as [string, ReactNode]] : []),
        ['Made', `${c.created_by ?? '—'}${c.created_at ? `, ${dateTime(c.created_at)}` : ''}`],
      ]} />
      {!builtin && <Toolbar>
        {btn('test', { primary: true })}
        {btn('restart')}
        {btn('update', { hidden: !w?.newer })}
        {btn('rollback', { hidden: !w?.canRollBack && !c.previous_bridge })}
        {btn('publish', { hidden: c.connector !== 'code' })}
        <button className="sa-btn" disabled={!!dataNo || !!busy} title={dataNo ?? undefined} onClick={() => { setEditing((x) => !x); setMoving(false) }}>Change its settings</button>
        {(connector?.identity ?? []).includes('person-key') && (connector?.identity ?? []).includes('shared') && <button className="sa-btn" disabled={!!dataNo || !!busy} title={dataNo ?? undefined} onClick={() => void switchAuth()}>{c.auth === 'per-user' ? 'Use one shared key' : "Use each person's own key"}</button>}
        <button className="sa-btn" disabled={!!codeNo || !!busy} title={codeNo ?? 'Run another connector (its current version) — the code it runs now kept for a rollback'} onClick={() => { setMoving((x) => !x); setEditing(false) }}>Move to another connector</button>
        <button className="sa-btn sa-btn--ghost" onClick={openIndex}>Its index</button>
        <button className="sa-btn sa-btn--ghost" onClick={openRunning}>In Running</button>
        <button className="sa-btn sa-btn--danger" disabled={!!dataNo || !!busy} title={dataNo ?? undefined} onClick={() => setRemoving(true)}>Remove</button>
      </Toolbar>}
      {said && <Notice state={said.state}>{said.text}</Notice>}
      {editing && connector && <EditSettings conn={c} connector={connector} busy={busy === 'patch'} onCancel={() => setEditing(false)} onSave={async (body) => { if (await patch(body, 'Its settings are changed; the engine loads it again with them.')) setEditing(false) }} />}
      {moving && <MoveConnector conn={c} catalogue={catalogue} busy={busy === 'patch'} onCancel={() => setMoving(false)} onMove={async (to) => { if (await patch({ connector: to }, `It runs ${to} from now on; the code it ran is kept for a rollback.`)) setMoving(false) }} />}
      {removing && <RemoveConnection api={api} projectId={projectId} conn={c} onCancel={() => setRemoving(false)} onRemoved={onRemoved} />}
      <RecordList rows={events} keyOf={(e) => String(e.seq)} empty="Nothing happened to it yet." columns={[
        { key: 'what', label: 'What happened', render: (e) => <span>{e.what}{e.detail ? <span className="sa-muted"> — {e.detail}</span> : null}</span> },
        { key: 'by', label: 'By', render: (e) => e.by ?? '' },
        { key: 'at', label: 'When', align: 'end', render: (e) => dateTime(e.at) },
      ]} />
    </Section>
  )
}

function EditSettings({ conn: c, connector, busy, onCancel, onSave }: { conn: Conn; connector: Catalogued; busy: boolean; onCancel: () => void; onSave: (body: Record<string, unknown>) => void }) {
  const fields = connector.fields ?? []
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.filter((f) => f.type !== 'secret').map((f) => [f.name, c.settings?.[f.name] === undefined ? '' : String(c.settings[f.name])])))
  const [description, setDescription] = useState(c.description ?? '')
  const save = () => {
    // a secret left empty keeps the one kept; a setting emptied is cleared
    const given = Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== '' || fields.find((f) => f.name === k)?.type !== 'secret'))
    onSave({ values: given, ...(description !== (c.description ?? '') ? { description } : {}) })
  }
  return (
    <Form onSubmit={save} actions={<><button type="button" className="sa-btn" onClick={onCancel}>Cancel</button><button className="sa-btn sa-btn--primary" disabled={busy}>{busy ? <span className="sa-spinner" /> : null}Save</button></>}>
      {connector.id === 'code' ? <Notice state="neutral">A custom source's settings and secrets are given with sacli (datasources update) or to the Connector agent.</Notice>
        : <ConnectorFields idPrefix="edit" fields={fields} values={values} onChange={setValues} kept={fields.filter((f) => f.type === 'secret').map((f) => f.name)} />}
      <Field label="Description"><textarea id="edit-desc" className="sa-input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
    </Form>
  )
}

function MoveConnector({ conn: c, catalogue, busy, onCancel, onMove }: { conn: Conn; catalogue: Catalogued[]; busy: boolean; onCancel: () => void; onMove: (to: string) => void }) {
  const choices = catalogue.filter((k) => k.id !== c.connector && k.id !== 'code' && k.levels.includes('project'))
  const [to, setTo] = useState(choices.find((k) => k.kind === c.kind)?.id ?? choices[0]?.id ?? '')
  const target = choices.find((k) => k.id === to)
  return (
    <Form onSubmit={() => to && onMove(to)} actions={<><button type="button" className="sa-btn" onClick={onCancel}>Cancel</button><button className="sa-btn sa-btn--primary" disabled={busy || !to}>{busy ? <span className="sa-spinner" /> : null}Move it</button></>}>
      <Field label="Connector" help="It runs that connector's current version from now on, keeping the settings the new one asks for (a field it does not ask for is dropped). The code it runs now is kept: Roll back returns to it.">
        <select id="move-to" className="sa-input" value={to} onChange={(e) => setTo(e.target.value)}>{choices.map((k) => <option key={k.id} value={k.id}>{k.title} ({k.id}{k.org ? ", the organisation's" : ''})</option>)}</select>
      </Field>
      {target && <p className="sa-muted">{target.description}</p>}
    </Form>
  )
}

function RemoveConnection({ api, projectId, conn: c, onCancel, onRemoved }: { api: Api; projectId: string; conn: Conn; onCancel: () => void; onRemoved: () => void }) {
  const [typed, setTyped] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const remove = async () => { setBusy(true); try { await api(`/projects/${projectId}/connections/${c.id}`, { method: 'DELETE' }).then(readJson); onRemoved() } catch (e: any) { setErr(e.message) } finally { setBusy(false) } }
  return (
    <Dialog title={`Remove ${c.name}?`} onClose={onCancel} actions={<><button className="sa-btn" onClick={onCancel}>Cancel</button><button className="sa-btn sa-btn--danger" disabled={typed !== c.name || busy} onClick={() => void remove()}>{busy ? <span className="sa-spinner" /> : null}Remove it</button></>}>
      <p>The engine stops reading it now. Its index is kept, marked gone, and agents stop being offered its tables. What names it — programs, concepts — finds nothing there from now on.</p>
      <Field label={`Type ${c.name} to remove it`}><input id="remove-name" className="sa-input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus /></Field>
      {err && <Notice state="critical">{err}</Notice>}
    </Dialog>
  )
}

// ── 4. An organisation's connectors: the registry, where each runs, block, approve ─────────────────────────────────
interface Usage { project: string; name: string; connections: { name: string; connector: string; bridge: string | null; auth: string | null }[]; unreachable?: boolean }
export function OrgConnectorsPanel({ api }: { api: Api }) {
  const [list, setList] = useState<{ connectors: OrgConnector[]; approval: boolean } | null>(null)
  const [usage, setUsage] = useState<Usage[] | null>(null)
  const [caps, setCaps] = useState<string[] | null>(null)
  const [err, setErr] = useState('')
  const [said, setSaid] = useState<{ state: 'ok' | 'critical'; text: string } | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [confirm, dialog] = useConfirm()
  const load = useCallback(() => {
    void api('/connectors').then(readJson).then((d) => { setList(d); setErr('') }).catch((e) => setErr(`The registry could not be read: ${e.message}`))
    void api('/connectors/usage').then(readJson).then((d) => setUsage(d.usage ?? [])).catch(() => setUsage([]))
  }, [api])
  useEffect(() => { load(); void capsOf(api, '/me').then(setCaps) }, [load, api])
  const no = lacking(caps, 'org.connectors')
  const runsOf = (id: string) => (usage ?? []).flatMap((u) => u.connections.filter((c) => c.connector === id).map((c) => ({ ...c, project: u.project, projectName: u.name })))
  const projectNameOf = (id: string) => usage?.find((u) => u.project === id)?.name ?? NAMES.get(id) ?? `project ${id.slice(0, 8)}`
  const send = async (path: string, body: Record<string, unknown>, done: string, method = 'POST') => {
    setBusy(path + JSON.stringify(body)); setSaid(null)
    try { await api(path, { method, body: JSON.stringify(body) }).then(readJson); setSaid({ state: 'ok', text: done }); load() }
    catch (e: any) { setSaid({ state: 'critical', text: e.message }) } finally { setBusy('') }
  }
  const block = async (c: OrgConnector, hash?: string) => {
    const runs = runsOf(c.id).filter((r) => !hash || r.bridge === hash), projects = new Set(runs.map((r) => r.project)).size
    if (!await confirm({ title: hash ? `Block ${c.title} version ${short(hash)}?` : `Block ${c.title}?`, danger: true, confirm: 'Block it',
      body: `${runs.length ? `${runs.length} connection${runs.length === 1 ? '' : 's'} in ${projects} project${projects === 1 ? '' : 's'} stop${runs.length === 1 ? 's' : ''} now: ${runs.map((r) => `${r.name} (${r.projectName})`).join(', ')}.` : 'No connection runs it now.'} ${hash ? 'Nothing is moved onto another version by itself.' : 'It is not offered to connect, and nothing more is published to it.'} Unblocking runs them again.` })) return
    await send('/connectors/block', { id: c.id, ...(hash ? { hash } : {}) }, hash ? `Version ${short(hash)} is blocked: what ran it stopped.` : `${c.title} is blocked: its connections stopped.`)
  }
  const waiting = (list?.connectors ?? []).flatMap((c) => c.versions.filter((v) => v.status === 'proposed' && !v.blocked_at).map((v) => ({ c, v })))
  const fc = list?.connectors.find((c) => c.id === focus)
  const used = usage ? usage.reduce((n, u) => n + u.connections.filter((c) => list?.connectors.some((k) => k.id === c.connector)).length, 0) : null
  return (
    <div className="sa-stack sa-stack--4">
      {dialog}
      {err && <Notice state="critical">{err}</Notice>}
      {said && <Notice state={said.state}>{said.text}</Notice>}
      {usage?.some((u) => u.unreachable) && <Notice state="attention">Some projects did not answer: where it runs may be incomplete ({usage.filter((u) => u.unreachable).map((u) => u.name).join(', ')}).</Notice>}
      <Figures>
        <Kpi label="Connectors" value={list ? list.connectors.length : '—'} />
        <Kpi label="Connections running them" value={used ?? '—'} />
        <Kpi label="Waiting for approval" value={list ? waiting.length : '—'} />
        <Kpi label="Blocked" value={list ? list.connectors.filter((c) => c.blocked_at).length : '—'} />
      </Figures>

      <Section icon="solar:shield-check-linear" title="How new versions arrive" subtitle="Whoever may change a project's connectors publishes one; a connection moves to a new version only when someone updates it.">
        <div className="sa-section__body sa-stack">
          <label className="sa-row sa-row--tight" title={no ?? undefined}>
            <input type="checkbox" checked={!!list?.approval} disabled={!!no || !list || !!busy} onChange={(e) => void send('/connectors/settings', { approval: e.target.checked }, e.target.checked ? 'New versions wait for an admin from now on.' : 'New versions are ready at once from now on.', 'PUT')} />
            <span>New versions wait for an organisation admin's approval{no ? <span className="sa-muted"> ({no})</span> : null}</span>
          </label>
          <p className="sa-muted">Off: a version is usable as soon as it is published (connections still stay on theirs). On: it waits here until approved. Either way an admin can block a connector, or one version, at any time — what runs it stops at once.</p>
        </div>
      </Section>

      <SignInApps api={api} caps={caps} />

      {waiting.length > 0 && (
        <Section icon="solar:hourglass-linear" title="Waiting for approval" note={`${waiting.length}`}>
          <RecordList rows={waiting} keyOf={(x) => x.v.hash} columns={[
            { key: 'c', label: 'Connector', render: (x) => <strong>{x.c.title}</strong> },
            { key: 'v', label: 'Version', render: (x) => <Code>{short(x.v.hash)}</Code> },
            { key: 'by', label: 'Published', render: (x) => <span>{x.v.published_by} <span className="sa-muted">{dateTime(x.v.published_at)} · {projectNameOf(x.v.from_project)}</span></span> },
            { key: 'act', label: '', align: 'end', render: (x) => <span className="sa-row sa-row--tight">
              <button className="sa-btn sa-btn--primary" disabled={!!no || !!busy} title={no ?? undefined} onClick={() => void send('/connectors/approve', { id: x.c.id, hash: x.v.hash }, `${x.c.title} ${short(x.v.hash)} is approved: the current version, offered to every project.`)}>Approve</button>
              <button className="sa-btn" disabled={!!no || !!busy} title={no ?? undefined} onClick={() => void block(x.c, x.v.hash)}>Block</button></span> },
          ]} />
        </Section>
      )}

      <Section icon="solar:plug-circle-linear" title="The registry" subtitle="Every connector published from the organisation's projects — choose one for its versions and where it runs" note={list ? `${list.connectors.length}` : undefined}>
        <RecordList search pageSize={20} rows={list?.connectors ?? null} keyOf={(c) => c.id} onRow={(c) => setFocus(c.id)} empty="None yet. A project publishes one with the Connector agent or sacli connectors publish." columns={[
          { key: 'title', label: 'Connector', render: (c) => <span className="sa-row sa-row--tight"><Icon icon={iconOf(c.current?.manifest ?? c.versions[0]?.manifest)} width={18} height={18} /><strong>{c.title}</strong> <span className="sa-muted">{c.id}</span></span> },
          { key: 'state', label: 'State', render: (c) => <Status state={c.blocked_at ? 'critical' : !c.current ? 'attention' : 'ok'}>{c.blocked_at ? 'blocked' : !c.current ? 'nothing approved yet' : 'ready'}</Status> },
          { key: 'current', label: 'Current', render: (c) => c.current ? <span><Code>{short(c.current.hash)}</Code> <span className="sa-muted">{dateTime(c.current.published_at)}</span></span> : '—' },
          { key: 'versions', label: 'Versions', align: 'end', render: (c) => c.versions.length },
          { key: 'made', label: 'Made by', render: (c) => <span>{c.made_by} <span className="sa-muted">in {projectNameOf(c.from_project)}</span></span> },
          { key: 'runs', label: 'Runs in', render: (c) => { const r = runsOf(c.id); return usage ? (r.length ? `${r.length} connection${r.length === 1 ? '' : 's'}, ${new Set(r.map((x) => x.project)).size} project${new Set(r.map((x) => x.project)).size === 1 ? '' : 's'}` : 'nowhere') : '…' } },
        ]} />
      </Section>

      {fc && (
        <Section icon={iconOf(fc.current?.manifest ?? fc.versions[0]?.manifest)} title={fc.title} subtitle={`${fc.id} · made by ${fc.made_by} in ${projectNameOf(fc.from_project)}, ${dateTime(fc.created_at)}`}
          actions={<span className="sa-row sa-row--tight">
            {fc.blocked_at
              ? <button className="sa-btn sa-btn--primary" disabled={!!no || !!busy} title={no ?? undefined} onClick={() => void send('/connectors/block', { id: fc.id, unblock: true }, `${fc.title} is unblocked: its connections run again.`)}>Unblock</button>
              : <button className="sa-btn sa-btn--danger" disabled={!!no || !!busy} title={no ?? undefined} onClick={() => void block(fc)}>Block it</button>}
            <button className="sa-btn" onClick={() => setFocus(null)}>Close</button></span>}>
          {fc.blocked_at && <Notice state="critical">Blocked by {fc.blocked_by} on {dateTime(fc.blocked_at)}: its connections are not run, it is not offered, and nothing more is published to it.</Notice>}
          <ManifestReceipt m={(fc.current ?? fc.versions[0]).manifest} />
          <strong>Where it runs</strong>
          <RecordList rows={usage ? runsOf(fc.id) : null} keyOf={(r) => `${r.project}/${r.name}`} empty="No connection runs it." columns={[
            { key: 'p', label: 'Project', render: (r) => r.projectName },
            { key: 'n', label: 'Connection', render: (r) => <strong>{r.name}</strong> },
            { key: 'v', label: 'Version', render: (r) => <span><Code>{short(r.bridge)}</Code>{fc.current?.hash === r.bridge ? <span className="sa-muted"> current</span> : fc.versions.find((v) => v.hash === r.bridge)?.blocked_at ? <> <Status state="critical">blocked</Status></> : <span className="sa-muted"> older</span>}</span> },
            { key: 'a', label: 'Reached with', render: (r) => (r.auth === 'per-user' ? "each person's own key" : 'one shared key') },
          ]} />
          <strong>Versions</strong>
          <RecordList rows={fc.versions} keyOf={(v) => v.hash} columns={[
            { key: 'hash', label: 'Version', render: (v) => <span title={v.hash}><Code>{short(v.hash)}</Code>{fc.current?.hash === v.hash ? <span className="sa-muted"> current</span> : null}</span> },
            { key: 'state', label: 'State', render: (v) => <Status state={v.blocked_at ? 'critical' : v.status === 'proposed' ? 'attention' : 'ok'}>{v.blocked_at ? `blocked by ${v.blocked_by}` : v.status === 'proposed' ? 'waiting for approval' : v.approved_by ? `approved by ${v.approved_by}` : 'ready'}</Status> },
            { key: 'by', label: 'Published', render: (v) => <span>{v.published_by} <span className="sa-muted">{dateTime(v.published_at)} · {projectNameOf(v.from_project)}</span></span> },
            { key: 'size', label: 'Size', align: 'end', render: (v) => kb(v.bytes) },
            { key: 'runs', label: 'Runs', align: 'end', render: (v) => runsOf(fc.id).filter((r) => r.bridge === v.hash).length || '—' },
            { key: 'act', label: '', align: 'end', render: (v) => <span className="sa-row sa-row--tight">
              {v.status === 'proposed' && !v.blocked_at && <button className="sa-btn sa-btn--link" disabled={!!no || !!busy} title={no ?? undefined} onClick={() => void send('/connectors/approve', { id: fc.id, hash: v.hash }, `Version ${short(v.hash)} is approved.`)}>Approve</button>}
              {v.blocked_at
                ? <button className="sa-btn sa-btn--link" disabled={!!no || !!busy} title={no ?? undefined} onClick={() => void send('/connectors/block', { id: fc.id, hash: v.hash, unblock: true }, `Version ${short(v.hash)} is unblocked.`)}>Unblock</button>
                : <button className="sa-btn sa-btn--link" disabled={!!no || !!busy} title={no ?? undefined} onClick={() => void block(fc, v.hash)}>Block</button>}</span> },
          ]} />
          <p className="sa-muted">A version's code is read from a project that runs it (its Connectors page). Every change here is in the organisation's records.</p>
        </Section>
      )}
    </div>
  )
}

/** The organisation's own app with each sign-in provider (OAuth): what a connector that signs people in with their own
 *  account (Google Sheets…) needs. The secret is typed once, sealed, never shown again. */
function SignInApps({ api, caps }: { api: Api; caps: string[] | null }) {
  const [d, setD] = useState<{ apps: { provider: string; client_id: string; added_by: string; added_at: string }[]; providers: { id: string; title: string; console: string }[]; callback: string } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, dialog] = useConfirm()
  const load = useCallback(() => api('/oauth-apps').then(readJson).then(setD).catch((e) => setErr(e.message)), [api])
  useEffect(() => { void load() }, [load])
  const no = lacking(caps, 'org.connectors')
  const save = async (provider: string) => {
    setBusy(true); setErr('')
    try { await api(`/oauth-apps/${provider}`, { method: 'PUT', body: JSON.stringify({ clientId: clientId.trim(), clientSecret: secret.trim() }) }).then(readJson); setEditing(null); setSecret(''); void load() }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const remove = async (provider: string, title: string) => {
    if (!await confirm({ title: `Remove the ${title} app?`, danger: true, confirm: 'Remove it', body: `Nobody can connect a ${title} account until one is set again. Accounts already connected keep working until their sign-in has to be renewed.` })) return
    await api(`/oauth-apps/${provider}`, { method: 'DELETE' }).then(readJson).catch((e) => setErr(e.message)); void load()
  }
  return (
    <Section icon="solar:login-3-linear" title="Sign-in apps" subtitle="For connectors people sign in to with their own account (Google Sheets…): the organisation's own app with each provider">
      {dialog}
      <div className="sa-section__body sa-stack">
        {err && <Notice state="critical">{err}</Notice>}
        {d && <p className="sa-muted">Register an app with the provider (a web application), and give it this redirect address: <Code>{d.callback}</Code> <CopyButton text={d.callback} label="Copy" className="sa-btn sa-btn--link" /></p>}
        <RecordList rows={d ? d.providers : null} keyOf={(p) => p.id} columns={[
          { key: 'p', label: 'Provider', render: (p) => <strong>{p.title}</strong> },
          { key: 'c', label: 'Its app', render: (p) => { const a = d?.apps.find((x) => x.provider === p.id); return a ? <span><Code>{a.client_id}</Code> <span className="sa-muted">set by {a.added_by}, {dateTime(a.added_at)}</span></span> : <span className="sa-muted">none — nobody can connect a {p.title} account yet</span> } },
          { key: 'a', label: '', align: 'end', render: (p) => { const a = d?.apps.find((x) => x.provider === p.id); return <span className="sa-row sa-row--tight">
            <a className="sa-btn sa-btn--link" href={p.console} target="_blank" rel="noreferrer">Its console</a>
            <button className="sa-btn" disabled={!!no} title={no ?? undefined} onClick={() => { setEditing(p.id); setClientId(a?.client_id ?? ''); setSecret('') }}>{a ? 'Change' : 'Set it'}</button>
            {a && <button className="sa-btn sa-btn--link" disabled={!!no} title={no ?? undefined} onClick={() => void remove(p.id, p.title)}>Remove</button>}</span> } },
        ]} />
        {editing && (() => { const p = d?.providers.find((x) => x.id === editing); const had = d?.apps.some((x) => x.provider === editing); return (
          <Form onSubmit={() => void save(editing)} actions={<><button type="button" className="sa-btn" onClick={() => setEditing(null)}>Cancel</button><button className="sa-btn sa-btn--primary" disabled={busy || !clientId.trim() || (!had && !secret.trim())}>Keep it</button></>}>
            <Field label={`${p?.title ?? editing} client ID *`}><input id="oa-id" className="sa-input" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" /></Field>
            <Field label={`Client secret${had ? '' : ' *'}`} help={had ? 'One is kept — leave empty to keep it.' : 'Sealed once sent; never shown again.'}><input id="oa-secret" className="sa-input" type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={had ? '•••• kept' : ''} /></Field>
          </Form>) })()}
      </div>
    </Section>
  )
}

// ── 5. The platform: Superatom's connectors, and every organisation's registry at a glance ─────────────────────────
export function PlatformConnectorsPage() {
  const token = useAuth(); const api = useApi(token)
  const [ours, setOurs] = useState<Catalogued[] | null>(null)
  const [orgs, setOrgs] = useState<{ id: string; name: string; connectors: OrgConnector[] | null; approval?: boolean }[] | null>(null)
  useEffect(() => {
    if (!token) return
    void api('/platform/connectors').then(readJson).then((d) => { setOurs(d.superatom ?? []); setOrgs(d.organisations ?? []) }).catch(() => { setOurs([]); setOrgs([]) })
  }, [token, api])
  const all = (orgs ?? []).flatMap((o) => o.connectors ?? [])
  return (
    <Shell>
      <PageHeader title="Connectors" subtitle="Superatom's connectors and their builds; each organisation's own, at a glance." />
      <Figures>
        <Kpi label="Superatom's" value={ours ? ours.length : '—'} />
        <Kpi label="Organisations' own" value={orgs ? all.length : '—'} />
        <Kpi label="Blocked" value={orgs ? all.filter((c) => c.blocked_at).length : '—'} />
        <Kpi label="Waiting for approval" value={orgs ? all.reduce((n, c) => n + c.versions.filter((v) => v.status === 'proposed').length, 0) : '—'} />
      </Figures>
      <Section icon="solar:star-linear" title="Superatom's connectors" subtitle="Shipped with the platform; a new build reaches a connection when someone updates it" note={ours ? `${ours.length}` : undefined}>
        <RecordList search pageSize={20} rows={ours} keyOf={(c) => c.id} columns={[
          { key: 'title', label: 'Connector', render: (c) => <span className="sa-row sa-row--tight"><Icon icon={iconOf(c)} width={18} height={18} /><strong>{c.title}</strong> <span className="sa-muted">{c.id}</span></span> },
          { key: 'kind', label: 'Kind', render: (c) => c.dialect && c.dialect !== 'api' ? c.dialect : c.kind },
          { key: 'sign', label: 'People sign in with', render: (c) => signIn(c.identity) },
          { key: 'version', label: 'Build', render: (c) => <Code>{short(c.version)}</Code> },
        ]} />
      </Section>
      <Section icon="solar:buildings-2-linear" title="Organisations' connectors" note={orgs ? `${orgs.length}` : undefined}>
        <RecordList search pageSize={20} rows={orgs} keyOf={(o) => o.id} empty="No organisation yet." columns={[
          { key: 'name', label: 'Organisation', render: (o) => <strong>{o.name}</strong> },
          { key: 'n', label: 'Connectors', render: (o) => o.connectors === null ? <span className="sa-muted">did not answer</span> : o.connectors.map((c) => c.title).join(', ') || '—' },
          { key: 'b', label: 'Blocked', align: 'end', render: (o) => (o.connectors ?? []).filter((c) => c.blocked_at).length || '—' },
          { key: 'a', label: 'Approval', render: (o) => (o.approval ? 'asked' : 'not asked') },
        ]} />
      </Section>
    </Shell>
  )
}
