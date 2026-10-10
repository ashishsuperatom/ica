// Which release of the Superatom Engine a project runs (docs/deploying-the-engine.md): what is chosen, what the engine
// reports it runs, the switch step by step — and the releases there are, any of which can be chosen here. The box's Engine
// Updater does the switch and reports every step to the platform as it happens; this page shows the platform's record
// (whole after a reload) and each step pushed over the project's socket.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Section, RecordList, Notice, Status, Code, Receipt } from '@superatom/ui'

type Api = (p: string, i?: RequestInit) => Promise<Response>
interface Release { tag: string; digest: string; at: string }
interface Last { state: 'switching' | 'switched' | 'rolled-back' | 'refused'; tag: string | null; to: string; at: string; seconds?: number; step?: string; reason?: string; fix?: string; logTail?: string }
interface Running { image: string | null; build: string; digest: string | null; last: Last | null }
interface Switch { id: string; to: string; tag: string | null; from: string | null; startedAt: string; endedAt?: string; state: 'switching' | 'switched' | 'rolled-back' | 'refused'; steps: { step: string; at: string; note?: string }[]; reason?: string; fix?: string; logTail?: string }
interface State { desired: { digest: string; tag: string | null; setBy: string | null; setAt: number } | null; running: Running | null; online: boolean; switch: Switch | null; releases: Release[]; problem?: string }
interface Hubish { subscribe: (fn: (m: { t?: string; switch?: Switch }) => void) => () => void }

const STEP: Record<string, string> = {
  started: 'Pulling the new image', pulled: 'Image pulled', stopped: 'Previous engine stopped', 'db-copied': 'Database copied aside',
  'started-new': 'New engine started', waiting: 'Waiting for it to reach the platform', switched: 'Running the new release',
  'rolled-back': 'Went back to the previous release', refused: 'Not switched',
}
const ago = (from: string, to?: string) => { const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000)); return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s` }

const short = (d?: string | null) => (d ? d.replace('sha256:', '').slice(0, 12) : '—')
const when = (t?: string | number) => (t ? new Date(t).toLocaleString() : '')

export function EngineReleasePanel({ api, projectId, hub }: { api: Api; projectId: string; hub?: Hubish }) {
  const [s, setS] = useState<State | null>(null)
  const [, tickClock] = useState(0)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const load = useCallback(() => {
    api(`/projects/${projectId}/engine-release`).then(async (r) => {
      if (!r.ok) { setErr(`The engine release could not be read (${r.status}).`); return }
      setErr(''); setS(await r.json() as State)
    }).catch(() => setErr('The engine release could not be read.'))
  }, [api, projectId])
  useEffect(() => load(), [load])
  // EACH STEP AS IT HAPPENS, pushed over the project's socket; at the end, everything read again (what runs changed).
  useEffect(() => hub?.subscribe((m) => {
    if (m?.t !== 'engine:switch' || !m.switch) return
    const sw = m.switch
    setS((prev) => (prev ? { ...prev, switch: sw } : prev))
    if (sw.state !== 'switching') load()
  }), [hub, load])
  const sw = s?.switch ?? null
  const switching = sw?.state === 'switching'
  // While it switches: a clock for the elapsed time, and the record read again now and then (a step pushed while this page
  // was away is never missed).
  useEffect(() => { if (!switching) return; const t = setInterval(() => tickClock((n) => n + 1), 1000); const p = setInterval(load, 15000); return () => { clearInterval(t); clearInterval(p) } }, [switching, load])

  const choose = async (rel: Release) => {
    if (!window.confirm(`Run ${rel.tag} on this project?\n\nThe engine restarts on it within a minute (questions wait meanwhile). If it does not come up, the box goes back to the release it runs now.`)) return
    setBusy(rel.tag)
    try {
      const r = await api(`/projects/${projectId}/engine-release`, { method: 'PUT', body: JSON.stringify({ tag: rel.tag }) })
      const d = await r.json().catch(() => ({})) as { error?: string; delivered?: boolean }
      if (!r.ok) setErr(d.error ?? `It could not be chosen (${r.status}).`)
      else { setErr(''); if (!d.delivered) setErr('Chosen — the engine is not connected now; it switches when it comes back.') }
      load()
    } finally { setBusy('') }
  }

  // A BUILD is listed once, by its own name (dev-<date>-<commit>, never moving). A channel (dev, prod) is a moving label
  // pointing at one of them: shown as a badge on that build, never as a release of its own.
  const isChannel = (tag: string) => !/-\d{8}-[0-9a-f]+$/.test(tag)
  const builds = s ? s.releases.filter((x) => !isChannel(x.tag)) : null
  const channelsOf = (digest: string) => (s?.releases ?? []).filter((x) => isChannel(x.tag) && x.digest === digest).map((x) => x.tag)
  const nameOf = (digest?: string | null) => (digest ? s?.releases.filter((x) => x.digest === digest && !['dev', 'prod'].includes(x.tag)).map((x) => x.tag)[0] ?? short(digest) : '—')
  const runningState = !s?.online ? 'attention' : !s?.desired || s.running?.digest === s.desired.digest ? 'ok' : 'attention'
  return (
    <Section icon="lucide:package" title="Engine release" subtitle="Which build of the engine this project runs. The box switches within a minute and goes back if the new one does not come up."
      footer={<button type="button" className="sa-btn" onClick={load}>Refresh</button>}>
      <div className="sa-section__body sa-stack">
        {err && <Notice state="critical">{err}</Notice>}
        {s?.problem && <Notice state="attention">{s.problem}</Notice>}
        {s && <Receipt items={[
          ['Chosen', s.desired ? <span className="sa-row sa-row--tight sa-row--wrap"><Code>{s.desired.tag ?? short(s.desired.digest)}</Code><span className="sa-muted">by {s.desired.setBy ?? '—'}, {when(s.desired.setAt)}</span></span>
            : <span className="sa-muted">none — a new box starts on the newest dev build</span>],
          ['Running', s.online ? <span className="sa-row sa-row--tight sa-row--wrap"><Status state={runningState}>{nameOf(s.running?.digest)}</Status><span className="sa-muted">build {String(s.running?.build ?? '—').slice(0, 8)}</span></span>
            : <Status state="attention">no engine connected</Status>],
          ...(sw ? [[switching ? 'Switching' : 'Last switch', <span className="sa-row sa-row--tight sa-row--wrap">
            <Status state={sw.state === 'switched' ? 'ok' : switching ? 'attention' : 'critical'}>{switching ? 'in progress' : sw.state}</Status>
            <span>to {sw.tag ?? short(sw.to)}</span>
            <span className="sa-muted">started {when(sw.startedAt)} · {switching ? `${ago(sw.startedAt)} so far` : `took ${ago(sw.startedAt, sw.endedAt)}`}</span>
          </span>] as [string, ReactNode]] : []),
        ]} />}
        {sw && (
          <ol className="sa-stack" style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {sw.steps.map((x) => (
              <li key={x.step}><span>{STEP[x.step] ?? x.step}</span> <span className="sa-muted">— {new Date(x.at).toLocaleTimeString()} (+{ago(sw.startedAt, x.at)}){x.note && !STEP[x.step]?.includes(x.note) ? ` · ${x.note}` : ''}</span></li>
            ))}
            {switching && Date.now() - Date.parse(sw.steps.at(-1)?.at ?? sw.startedAt) > 5 * 60_000 && (
              <li><Status state="critical">no word from the box for {ago(sw.steps.at(-1)?.at ?? sw.startedAt)}</Status> <span className="sa-muted">— check the updater on the box: docker logs sa-engine-updater-{projectId}</span></li>
            )}
          </ol>
        )}
        {sw && (sw.state === 'rolled-back' || sw.state === 'refused') && (
          <Notice state="critical">
            <div className="sa-stack">
              <span>{sw.reason}</span>
              {sw.fix && <span className="sa-muted">{sw.fix}</span>}
              {sw.logTail && <details><summary>The new engine's last log lines</summary><pre className="sa-code-block">{sw.logTail}</pre></details>}
            </div>
          </Notice>
        )}
      </div>
      <RecordList rows={builds} search={(r) => `${r.tag} ${channelsOf(r.digest).join(' ')}`} searchLabel="Find a release…" pageSize={10} keyOf={(r) => r.tag} columns={[
        { key: 'tag', label: 'Release', render: (r) => <span className="sa-row sa-row--tight"><Code>{r.tag}</Code>{channelsOf(r.digest).map((c) => <span key={c} className="sa-chip">{c}</span>)}</span> },
        { key: 'at', label: 'Published', render: (r) => <span className="sa-muted">{when(r.at)}</span> },
        { key: 'digest', label: 'Image', render: (r) => <span className="sa-muted">{short(r.digest)}</span> },
        { key: 'now', label: '', render: (r) => <span className="sa-row sa-row--tight">
          {s?.running?.digest === r.digest && <Status state="ok">running</Status>}
          {s?.desired?.digest === r.digest && s?.running?.digest !== r.digest && <Status state="attention">chosen</Status>}
        </span> },
        { key: 'act', label: '', render: (r) => (s?.desired?.digest === r.digest ? null
          : <button type="button" className="sa-btn" disabled={!!busy} onClick={() => choose(r)}>{busy === r.tag ? 'Choosing…' : 'Run this'}</button>) },
      ]} />
    </Section>
  )
}
