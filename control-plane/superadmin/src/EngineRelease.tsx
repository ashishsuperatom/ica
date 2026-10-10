// Which version of the Superatom Engine a project runs (docs/deploying-the-engine.md): what runs, what is chosen, the
// switch step by step — and the versions there are, any of which can be switched to here. The box's Engine Updater does
// the switch and reports every step to the platform as it happens; this page shows the platform's record (whole after a
// reload) and each step pushed over the project's socket. A version is named by when it was published — the name a person
// can read; its build name (dev-<date>-<commit>) is the detail.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Section, RecordList, Notice, Status, Code, Receipt, Icon } from '@superatom/ui'

type Api = (p: string, i?: RequestInit) => Promise<Response>
interface Release { tag: string; digest: string; at: string }
interface Running { image: string | null; build: string; digest: string | null }
interface Switch { id: string; to: string; tag: string | null; from: string | null; startedAt: string; endedAt?: string; state: 'switching' | 'switched' | 'rolled-back' | 'refused'; steps: { step: string; at: string; note?: string }[]; reason?: string; fix?: string; logTail?: string }
interface State { desired: { digest: string; tag: string | null; setBy: string | null; setAt: number } | null; running: Running | null; online: boolean; switch: Switch | null; releases: Release[]; problem?: string }
interface Hubish { subscribe: (fn: (m: { t?: string; switch?: Switch }) => void) => () => void }

/** The steps of a switch, in order, as a person reads them. */
const STEPS: [string, string][] = [
  ['started', 'Pull the new version'], ['pulled', 'Version downloaded'], ['stopped', 'Stop the running engine'],
  ['db-copied', 'Copy the database aside'], ['started-new', 'Start the new engine'], ['waiting', 'Wait for it to reach the platform'],
]
const END: Record<string, [string, string, string]> = {   // outcome → label, icon, colour
  switched: ['Running the new version', 'lucide:circle-check', 'var(--win-ink)'],
  'rolled-back': ['Went back to the previous version', 'lucide:circle-x', 'var(--loss-ink)'],
  refused: ['Not switched', 'lucide:circle-x', 'var(--loss-ink)'],
}
const isBuild = (tag: string) => /-\d{8}-[0-9a-f]+$/.test(tag)
export const published = (at?: string) => (at ? new Date(at).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')
const clock = (at: string) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const span = (from: string, to?: string) => { const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000)); return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s` }
const mark = (icon: string, colour: string, label: ReactNode, spin = false) => (
  <span className="sa-row sa-row--tight">{spin ? <span className="sa-spinner" style={{ color: colour }} /> : <Icon icon={icon} width={16} style={{ color: colour }} />}{label !== '' && <span>{label}</span>}</span>
)

export function EngineReleasePanel({ api, projectId, hub }: { api: Api; projectId: string; hub?: Hubish }) {
  const [s, setS] = useState<State | null>(null)
  const [, tickClock] = useState(0)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const load = useCallback(() => {
    api(`/projects/${projectId}/engine-release`).then(async (r) => {
      if (!r.ok) { setErr(`The engine version could not be read (${r.status}).`); return }
      setErr(''); setS(await r.json() as State)
    }).catch(() => setErr('The engine version could not be read.'))
  }, [api, projectId])
  useEffect(() => load(), [load])
  // EACH STEP AS IT HAPPENS, pushed over the project's socket; at the end, everything read again (what runs changed).
  useEffect(() => hub?.subscribe((m) => {
    if (m?.t !== 'engine:switch' || !m.switch) return
    const next = m.switch
    setS((prev) => (prev ? { ...prev, switch: next } : prev))
    if (next.state !== 'switching') load()
  }), [hub, load])
  const sw = s?.switch ?? null
  const switching = sw?.state === 'switching'
  // While it switches: a clock for the elapsed time, and the record read again now and then (a step pushed while this
  // page was away is never missed).
  useEffect(() => { if (!switching) return; const t = setInterval(() => tickClock((n) => n + 1), 1000); const p = setInterval(load, 15000); return () => { clearInterval(t); clearInterval(p) } }, [switching, load])

  const builds = s ? s.releases.filter((x) => isBuild(x.tag)) : null
  const buildOf = (digest?: string | null) => (digest ? s?.releases.find((x) => x.digest === digest && isBuild(x.tag)) : undefined)
  const channelsOf = (digest: string) => (s?.releases ?? []).filter((x) => !isBuild(x.tag) && x.digest === digest).map((x) => x.tag)
  const versionText = (digest?: string | null, tag?: string | null) => { const b = buildOf(digest); return b ? published(b.at) : tag ?? (digest ? digest.slice(7, 19) : '—') }

  const choose = async (rel: Release) => {
    if (!window.confirm(`Switch this project's engine to the version published ${published(rel.at)} (${rel.tag})?\n\nThe engine restarts on it in under a minute; people using the project see that it is updating. If it does not come up, the box goes back to the version it runs now.`)) return
    setBusy(rel.tag)
    try {
      const r = await api(`/projects/${projectId}/engine-release`, { method: 'PUT', body: JSON.stringify({ tag: rel.tag }) })
      const d = await r.json().catch(() => ({})) as { error?: string; delivered?: boolean }
      if (!r.ok) setErr(d.error ?? `It could not be switched (${r.status}).`)
      else setErr(d.delivered ? '' : 'Chosen — the engine is not connected now; it switches when it comes back.')
      load()
    } finally { setBusy('') }
  }

  // THE SWITCH AS A TABLE: every step in its place — done (with its time), under way, still to come — then the outcome.
  type StepRow = { key: string; label: string; icon: ReactNode; at: string; after: string; note: string }
  const stepRows: StepRow[] = sw ? (() => {
    const done = new Map(sw.steps.map((x) => [x.step, x]))
    const reached = STEPS.filter(([k]) => done.has(k)).length
    const rows: StepRow[] = STEPS.flatMap(([k, label], i): StepRow[] => {
      const d = done.get(k)
      if (d) {
        const active = switching && i === reached - 1
        return [{ key: k, label, icon: active ? mark('', 'var(--primary)', '', true) : mark('lucide:circle-check', 'var(--win-ink)', ''), at: clock(d.at), after: `+${span(sw.startedAt, d.at)}`, note: d.note && !label.toLowerCase().includes(d.note.toLowerCase()) ? d.note : '' }]
      }
      if (!switching) return []   // an ended switch shows only what happened
      return [{ key: k, label, icon: mark('lucide:circle-dashed', 'var(--faint)', ''), at: '', after: '', note: '' }]
    })
    const end = END[sw.state]
    if (end && sw.endedAt) rows.push({ key: 'end', label: end[0], icon: mark(end[1], end[2], ''), at: clock(sw.endedAt), after: `+${span(sw.startedAt, sw.endedAt)}`, note: done.get(sw.state)?.note ?? '' })
    return rows
  })() : []

  const runningDigest = s?.running?.digest ?? null
  const runningBuild = buildOf(runningDigest)
  return (
    <div className="sa-stack sa-stack--4">
      <Section icon="lucide:package" title="Engine version" subtitle="Which version of the engine this project runs. Switching takes under a minute; the box goes back if the new one does not come up."
        actions={<button type="button" className="sa-btn" onClick={load}><Icon icon="lucide:refresh-cw" className="sa-btn__icon" />Refresh</button>}>
        <div className="sa-section__body sa-stack">
          {err && <Notice state="critical">{err}</Notice>}
          {s?.problem && <Notice state="attention">{s.problem}</Notice>}
          {s && <Receipt items={[
            ['Running', s.online
              ? mark('lucide:circle-check', 'var(--win-ink)', <span className="sa-row sa-row--tight sa-row--wrap"><strong>{versionText(runningDigest)}</strong>{runningBuild && <Code>{runningBuild.tag}</Code>}</span>)
              : mark('lucide:plug-zap', 'var(--faint)', <span className="sa-muted">no engine connected — the version shows when it connects</span>)],
            ['Chosen', s.desired
              ? <span className="sa-row sa-row--tight sa-row--wrap"><span>{s.desired.digest === runningDigest ? 'the version running' : versionText(s.desired.digest, s.desired.tag)}</span><span className="sa-muted">by {s.desired.setBy ?? '—'}, {published(new Date(s.desired.setAt).toISOString())}</span></span>
              : <span className="sa-muted">none yet — a new box starts on the newest dev version</span>],
          ]} />}
        </div>
      </Section>

      {sw && (
        <Section icon={switching ? 'lucide:loader' : sw.state === 'switched' ? 'lucide:circle-check' : 'lucide:triangle-alert'}
          title={switching ? 'Switching now' : 'Last switch'}
          subtitle={`To the version published ${versionText(sw.to, sw.tag)} · started ${published(sw.startedAt)} · ${switching ? `${span(sw.startedAt)} so far` : `took ${span(sw.startedAt, sw.endedAt)}`}`}>
          <RecordList rows={stepRows} keyOf={(r) => r.key} columns={[
            { key: 'icon', label: '', render: (r) => r.icon },
            { key: 'label', label: 'Step', render: (r) => <span className={r.at ? '' : 'sa-muted'}>{r.label}</span> },
            { key: 'at', label: 'Time', render: (r) => <span className="sa-num">{r.at}</span> },
            { key: 'after', label: 'After', align: 'end', render: (r) => <span className="sa-num sa-muted">{r.after}</span> },
            { key: 'note', label: 'Detail', wrap: true, render: (r) => <span className="sa-muted">{r.note}</span> },
          ]} />
          {switching && Date.now() - Date.parse(sw.steps.at(-1)?.at ?? sw.startedAt) > 5 * 60_000 && (
            <div className="sa-section__body"><Notice state="critical">No word from the box for {span(sw.steps.at(-1)?.at ?? sw.startedAt)} — check its updater: <Code>docker logs sa-engine-updater-{projectId}</Code></Notice></div>
          )}
          {(sw.state === 'rolled-back' || sw.state === 'refused') && (
            <div className="sa-section__body">
              <Notice state="critical">
                <div className="sa-stack">
                  <span>{sw.reason}</span>
                  {sw.fix && <span className="sa-muted">{sw.fix}</span>}
                  {sw.logTail && <details><summary>The new engine's last log lines</summary><pre className="sa-code-block">{sw.logTail}</pre></details>}
                </div>
              </Notice>
            </div>
          )}
        </Section>
      )}

      <Section icon="lucide:history" title="Versions" subtitle="Every version published, newest first. Switching to an older one is how you go back.">
        <RecordList rows={builds} search={(r) => `${r.tag} ${published(r.at)} ${channelsOf(r.digest).join(' ')}`} searchLabel="Find a version…" pageSize={10} keyOf={(r) => r.tag} columns={[
          { key: 'at', label: 'Published', render: (r) => <strong className="sa-num">{published(r.at)}</strong> },
          { key: 'tag', label: 'Build', render: (r) => <span className="sa-row sa-row--tight"><Code>{r.tag}</Code>{channelsOf(r.digest).map((c) => <Status key={c} state="neutral">{c}</Status>)}</span> },
          { key: 'now', label: 'On this project', render: (r) => (
            switching && sw?.to === r.digest ? mark('', 'var(--primary)', 'Switching…', true)
            : r.digest === runningDigest ? mark('lucide:circle-check', 'var(--win-ink)', 'Running')
            : s?.desired?.digest === r.digest ? mark('lucide:clock', 'var(--warn-ink)', 'Chosen')
            : null) },
          { key: 'act', label: '', align: 'end', render: (r) => (r.digest === runningDigest || s?.desired?.digest === r.digest ? null
            : <button type="button" className="sa-btn" disabled={!!busy || switching} onClick={() => choose(r)}>
                <Icon icon="lucide:arrow-right-left" className="sa-btn__icon" /><span className="sa-btn__text">{busy === r.tag ? 'Switching…' : 'Switch to this'}</span>
              </button>) },
        ]} />
      </Section>
    </div>
  )
}
