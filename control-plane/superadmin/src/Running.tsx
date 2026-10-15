// RUNNING — everything the project's engine runs, how each stands, what happened to it, and what can be done to it
// (docs/platform-architecture.md "Workloads"). The list is the platform's record (GET /workloads), kept current by the
// project's socket (workload:update); choosing one focuses it: its state, what it runs, its last error, its actions (each
// said before it is done), its aspects (looked into on demand) and what happened to it. Below, what happened across
// everything, newest first, filtered by kind. Attention stays for what needs a person; this is where to look at all of it.
import { useCallback, useEffect, useState } from 'react'
import { Section, RecordList, Notice, Status, Code, Toolbar, Empty, dateTime, useConfirm, type StatusState } from '@superatom/ui'
import { WORKLOAD_KINDS } from '../../../vm/packages/platform-types/src/workloads.js'

type Api = (p: string, i?: RequestInit) => Promise<Response>
interface Hubish { subscribe: (fn: (m: { t?: string }) => void) => () => void }
interface Workload { kind: string; id: string; state: string; reported?: string; newer?: string; version: string | null; restarts: number; error: { what: string; detail?: string } | null; health: Record<string, unknown> | null; since: number; reportedAt: number; taken: boolean; label?: string }
interface Event { seq: number; kind: string; id: string; at: number; state: string | null; what: string; by: string | null; detail: string | null }
interface Detail { workload: Workload; events: Event[]; actions: Record<string, { label: string; says: string; needs: string }>; aspects: Record<string, { label: string; needs: string }> }

// Each kind's name, from the one place kinds are described (the platform's, the engine's and sacli's too).
const KINDS: Record<string, string> = Object.fromEntries(Object.entries(WORKLOAD_KINDS).map(([k, v]) => [k, v.label]))
const stateOf = (s: string): StatusState => (s === 'ready' ? 'ok' : s === 'failed' ? 'critical' : s === 'degraded' || s === 'unknown' ? 'attention' : s === 'starting' || s === 'pending' ? 'running' : 'neutral')
const ago = (ms: number) => { if (!ms) return '—'; const m = Math.round((Date.now() - ms) / 60_000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago` }
const keyOf = (w: { kind: string; id: string }) => `${w.kind}/${w.id}`

export function RunningPanel({ api, projectId, hub }: { api: Api; projectId: string; hub?: Hubish }) {
  const base = `/projects/${projectId}/workloads`
  const [list, setList] = useState<{ online: boolean; workloads: Workload[] } | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [events, setEvents] = useState<Event[] | null>(null)
  const [kind, setKind] = useState('')
  const [err, setErr] = useState('')
  const [said, setSaid] = useState<{ state: 'ok' | 'critical'; text: string } | null>(null)
  const [look, setLook] = useState<{ aspect: string; data: unknown } | null>(null)
  const [busy, setBusy] = useState('')
  const [confirm, confirmDialog] = useConfirm()

  const readJson = async (r: Response) => { const j = await r.json().catch(() => ({})) as any; if (!r.ok) throw new Error(j.error ?? `${r.status}`); return j }
  const loadList = useCallback(() => api(base).then(readJson).then((j) => { setErr(''); setList(j) }).catch((e) => setErr(`What runs could not be read: ${e.message}`)), [api, base])
  const loadEvents = useCallback(() => api(`${base}/events?limit=100${kind ? `&kind=${kind}` : ''}`).then(readJson).then((j) => setEvents(j.events)).catch(() => setEvents([])), [api, base, kind])
  const loadDetail = useCallback((k: string) => { const [kd, ...rest] = k.split('/'); return api(`${base}/${kd}/${encodeURIComponent(rest.join('/'))}`).then(readJson).then(setDetail).catch((e) => setErr(e.message)) }, [api, base])
  useEffect(() => { void loadList() }, [loadList])
  useEffect(() => { void loadEvents() }, [loadEvents])
  useEffect(() => { setLook(null); setSaid(null); if (focus) void loadDetail(focus); else setDetail(null) }, [focus, loadDetail])
  // LIVE: a change anywhere reads the list, the events and the one in focus again.
  useEffect(() => hub?.subscribe((m) => { if (m?.t !== 'workload:update') return; void loadList(); void loadEvents(); if (focus) void loadDetail(focus) }), [hub, loadList, loadEvents, loadDetail, focus])

  const act = async (action: string, a: { label: string; says: string }) => {
    if (!detail) return
    const w = detail.workload
    if (!await confirm({ title: `${a.label}: ${w.kind} ${w.id}?`, body: `${a.says[0].toUpperCase()}${a.says.slice(1)}. It is recorded, with your name.`, confirm: a.label })) return
    setBusy(action); setSaid(null)
    try {
      const j = await api(`${base}/${w.kind}/${encodeURIComponent(w.id)}/act`, { method: 'POST', body: JSON.stringify({ action }) }).then(async (r) => ({ ok: r.ok, ...(await r.json().catch(() => ({}))) as any }))
      setSaid(j.ok ? { state: 'ok', text: j.note ?? 'Done.' } : { state: 'critical', text: j.error ?? 'It was not done.' })
      void loadDetail(keyOf(w)); void loadEvents()
    } finally { setBusy('') }
  }
  const inspect = async (aspect: string) => {
    if (!detail) return
    const w = detail.workload
    setBusy(`look:${aspect}`)
    try {
      const j = await api(`${base}/${w.kind}/${encodeURIComponent(w.id)}/inspect/${aspect}`).then(readJson)
      setLook({ aspect, data: j.data })
    } catch (e: any) { setSaid({ state: 'critical', text: e.message }) } finally { setBusy('') }
  }

  const rows = (list?.workloads ?? []).filter((w) => !kind || w.kind === kind)
  const w = detail?.workload
  return (
    <>
      {confirmDialog}
      {err && <Notice state="critical">{err}</Notice>}
      {list && !list.online && <Notice state="attention">No engine is connected: each workload shows what it last said, as unknown.</Notice>}
      <Toolbar>
        <select className="sa-input" aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 'auto' }}>
          <option value="">Everything</option>
          {Object.entries(KINDS).map(([k, label]) => <option key={k} value={k}>{label}s</option>)}
        </select>
      </Toolbar>

      <Section icon="lucide:activity" title="What runs" subtitle="Everything the engine runs and how each stands — choose one to look into it" note={list ? `${rows.length}` : undefined}>
        <RecordList search pageSize={25} rows={list ? rows : null} keyOf={keyOf} onRow={(r) => setFocus(keyOf(r))} empty="Nothing runs yet." columns={[
          { key: 'name', label: 'Workload', render: (r) => <span><strong>{r.id}</strong> <span className="sa-muted">{KINDS[r.kind]?.toLowerCase() ?? r.kind}</span></span> },
          { key: 'state', label: 'State', render: (r) => <Status state={stateOf(r.state)}>{r.state === 'unknown' ? `unknown (${r.reported})` : r.state}</Status> },
          { key: 'version', label: 'Runs', render: (r) => <span className="sa-muted">{r.version ?? '—'}</span> },
          { key: 'note', label: 'Note', render: (r) => [r.error?.what, !r.taken && r.reportedAt ? 'changed — not yet taken' : '', r.newer ? `a newer version of its connector (${r.newer})` : '', r.restarts ? `${r.restarts} restart${r.restarts === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || '' },
          { key: 'since', label: 'Since', align: 'end', render: (r) => <span title={r.since ? dateTime(r.since) : undefined}>{ago(r.since)}</span> },
        ]} />
      </Section>

      {w && detail && (
        <Section icon="lucide:crosshair" title={`${KINDS[w.kind] ?? w.kind}: ${w.id}`} subtitle={w.version ? `Runs ${w.version}` : undefined}
          actions={<button className="sa-btn" onClick={() => setFocus(null)}>Close</button>}>
          <div className="sa-row sa-row--wrap" style={{ gap: 'var(--sp-2)' }}>
            <Status state={stateOf(w.state)}>{w.state === 'unknown' ? `unknown — last ${w.reported}` : w.state}</Status>
            {w.since > 0 && <span className="sa-muted">since {dateTime(w.since)}</span>}
            {!w.taken && w.reportedAt > 0 && <Status state="attention">changed — not yet taken</Status>}
            {w.newer && <Status state="attention">a newer version of its connector: {w.newer}</Status>}
            {w.restarts > 0 && <span className="sa-muted">{w.restarts} restart{w.restarts === 1 ? '' : 's'}</span>}
          </div>
          {w.error && <Notice state={w.state === 'failed' ? 'critical' : 'attention'}>{w.error.what}{w.error.detail && <div><Code>{w.error.detail}</Code></div>}</Notice>}
          {w.health && <p className="sa-muted">{Object.entries(w.health).map(([k, v]) => `${k} ${String(v)}`).join(' · ')}</p>}
          {(Object.keys(detail.actions).length > 0 || Object.keys(detail.aspects).length > 0) && (
            <Toolbar>
              {Object.entries(detail.actions).map(([k, a]) => <button key={k} className="sa-btn" disabled={!!busy} onClick={() => void act(k, a)}>{busy === k ? <span className="sa-spinner" /> : null}{a.label}</button>)}
              {Object.entries(detail.aspects).map(([k, a]) => <button key={k} className="sa-btn sa-btn--ghost" disabled={!!busy} onClick={() => void inspect(k)}>{busy === `look:${k}` ? <span className="sa-spinner" /> : null}Look at its {a.label.toLowerCase()}</button>)}
            </Toolbar>
          )}
          {said && <Notice state={said.state}>{said.text}</Notice>}
          {look && <div><p className="sa-muted">Its {look.aspect}, now:</p><pre className="sa-code" style={{ whiteSpace: 'pre-wrap', overflowX: 'auto' }}>{JSON.stringify(look.data, null, 2)}</pre></div>}
          <RecordList rows={detail.events} keyOf={(e) => String(e.seq)} empty="Nothing happened to it yet." columns={[
            { key: 'what', label: 'What happened', render: (e) => <span>{e.what}{e.detail ? <span className="sa-muted"> — {e.detail}</span> : null}</span> },
            { key: 'by', label: 'By', render: (e) => e.by ?? '' },
            { key: 'at', label: 'When', align: 'end', render: (e) => <span title={dateTime(e.at)}>{ago(e.at)}</span> },
          ]} />
        </Section>
      )}

      <Section icon="lucide:list" title="What happened" subtitle={`Across ${kind ? `${KINDS[kind].toLowerCase()}s` : 'everything'}, newest first`} note={events ? `${events.length}` : undefined}>
        {events && events.length === 0 ? <Empty icon="lucide:list">Nothing has happened yet.</Empty> : (
          <RecordList search pageSize={25} rows={events} keyOf={(e) => String(e.seq)} onRow={(e) => setFocus(keyOf(e))} columns={[
            { key: 'w', label: 'Workload', render: (e) => <span><strong>{e.id}</strong> <span className="sa-muted">{KINDS[e.kind]?.toLowerCase() ?? e.kind}</span></span> },
            { key: 'what', label: 'What happened', render: (e) => e.what },
            { key: 'by', label: 'By', render: (e) => e.by ?? '' },
            { key: 'at', label: 'When', align: 'end', render: (e) => <span title={dateTime(e.at)}>{ago(e.at)}</span> },
          ]} />
        )}
      </Section>
    </>
  )
}
