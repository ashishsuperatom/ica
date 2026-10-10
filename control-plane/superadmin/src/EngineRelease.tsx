// Which release of the engine a project runs (docs/deploying-the-engine.md): what is chosen, what the engine reports it
// runs, how the last switch went — and the releases there are, any of which can be chosen here. The box's updater does
// the switch (within a minute, rolled back if the new engine does not come up); this page only chooses and shows.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Section, RecordList, Notice, Status, Code, Receipt } from '@superatom/ui'

type Api = (p: string, i?: RequestInit) => Promise<Response>
interface Release { tag: string; digest: string; at: string }
interface Last { state: 'switching' | 'switched' | 'rolled-back' | 'refused'; tag: string | null; to: string; at: string; seconds?: number; step?: string; reason?: string; fix?: string; logTail?: string }
interface Running { image: string | null; build: string; digest: string | null; last: Last | null }
interface State { desired: { digest: string; tag: string | null; setBy: string | null; setAt: number } | null; running: Running | null; online: boolean; releases: Release[]; problem?: string }

const short = (d?: string | null) => (d ? d.replace('sha256:', '').slice(0, 12) : '—')
const when = (t?: string | number) => (t ? new Date(t).toLocaleString() : '')

export function EngineReleasePanel({ api, projectId }: { api: Api; projectId: string }) {
  const [s, setS] = useState<State | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const load = useCallback(() => {
    api(`/projects/${projectId}/engine-release`).then(async (r) => {
      if (!r.ok) { setErr(`The engine release could not be read (${r.status}).`); return }
      setErr(''); setS(await r.json() as State)
    }).catch(() => setErr('The engine release could not be read.'))
  }, [api, projectId])
  useEffect(() => load(), [load])
  // While a switch is under way — chosen differs from running, or the updater says it is switching — look again often.
  const switching = !!s?.desired && (s.running?.digest !== s.desired.digest || s.running?.last?.state === 'switching')
  useEffect(() => { if (!switching) return; const t = setInterval(load, 5000); return () => clearInterval(t) }, [switching, load])

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

  const nameOf = (digest?: string | null) => (digest ? s?.releases.filter((x) => x.digest === digest && !['dev', 'prod'].includes(x.tag)).map((x) => x.tag)[0] ?? short(digest) : '—')
  const last = s?.running?.last ?? null
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
          ['Running', s.online ? <span className="sa-row sa-row--tight sa-row--wrap"><Status state={runningState}>{nameOf(s.running?.digest)}</Status><span className="sa-muted">build {String(s.running?.build ?? '—').slice(0, 8)}</span>{switching && <span className="sa-muted">switching…</span>}</span>
            : <Status state="attention">no engine connected</Status>],
          ...(last ? [['Last switch', <span className="sa-row sa-row--tight sa-row--wrap">
            <Status state={last.state === 'switched' ? 'ok' : last.state === 'switching' ? 'attention' : 'critical'}>{last.state}</Status>
            <span>{last.tag ?? short(last.to)}</span><span className="sa-muted">{when(last.at)}{last.seconds !== undefined ? ` · ${last.seconds}s` : ''}</span>
          </span>] as [string, ReactNode]] : []),
        ]} />}
        {last && last.state !== 'switched' && last.state !== 'switching' && (
          <Notice state="critical">
            <div className="sa-stack">
              <span>{last.step ? `At ${last.step}: ` : ''}{last.reason}</span>
              {last.fix && <span className="sa-muted">{last.fix}</span>}
              {last.logTail && <details><summary>The new engine's last log lines</summary><pre className="sa-code-block">{last.logTail}</pre></details>}
            </div>
          </Notice>
        )}
      </div>
      <RecordList rows={s ? s.releases : null} search={(r) => r.tag} searchLabel="Find a release…" pageSize={10} keyOf={(r) => r.tag} columns={[
        { key: 'tag', label: 'Release', render: (r) => <Code>{r.tag}</Code> },
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
