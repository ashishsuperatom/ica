// Which engine the project uses (docs/platform-architecture.md, "Many engines, one selected"): every engine that has
// connected, the one the project uses, which are connected now — and choosing another. Nearly always there is one; a
// second is for trying something or recovering. The choice is only ever made here (or by sacli engine select): the
// platform never switches by itself, so when the selected engine is down the project waits for it, and this page says so.
import { useCallback, useEffect, useState } from 'react'
import { Section, RecordList, Notice, Status, Code, Icon, dateTime, useConfirm } from '@superatom/ui'

type Api = (p: string, i?: RequestInit) => Promise<Response>
interface Engine { id: string; host?: string; firstSeen: string; lastSeen: string; selected: boolean; connected: boolean }
interface View { selected: string | null; engines: Engine[] }

export function EnginesPanel({ api, projectId }: { api: Api; projectId: string }) {
  const [v, setV] = useState<View | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const load = useCallback(() => {
    api(`/projects/${projectId}/engines`).then(async (r) => {
      if (!r.ok) { setErr(`The engines could not be read (${r.status}).`); return }
      setErr(''); setV(await r.json() as View)
    }).catch(() => setErr('The engines could not be read.'))
  }, [api, projectId])
  useEffect(() => load(), [load])
  // Engines connect and go on their own: read again now and then while the page is open.
  useEffect(() => { const t = setInterval(load, 15_000); return () => clearInterval(t) }, [load])

  const [confirm, confirmDialog] = useConfirm()
  const act = async (e: Engine, what: 'select' | 'forget') => {
    const ok = await confirm(what === 'select'
      ? { title: `Use engine ${e.id}?`, body: `${e.connected ? 'It is connected now.' : 'It is not connected now — the project waits for it until it comes back.'} Every engine reconnects; the one used now becomes a standby. What only the old engine held (a session's last unsynced steps, its agents' working notes) stays there.`, confirm: 'Use this engine' }
      : { title: `Forget engine ${e.id}?`, body: 'It leaves this list. If it connects again it comes back, as a standby.', confirm: 'Forget' })
    if (!ok) return
    setBusy(e.id)
    try {
      const r = what === 'select'
        ? await api(`/projects/${projectId}/engines/selected`, { method: 'PUT', body: JSON.stringify({ id: e.id }) })
        : await api(`/projects/${projectId}/engines/${encodeURIComponent(e.id)}`, { method: 'DELETE' })
      const d = await r.json().catch(() => ({})) as View & { error?: string }
      if (!r.ok) setErr(d.error ?? `It could not be done (${r.status}).`)
      else { setErr(''); setV(d) }
    } finally { setBusy('') }
  }

  const selected = v?.engines.find((e) => e.selected) ?? null
  return (
    <div className="sa-stack sa-stack--4">
      {confirmDialog}
      <Section icon="lucide:server" title="Engines" subtitle="The project uses one engine; any other that connects waits as a standby until it is chosen here."
        actions={<button type="button" className="sa-btn" onClick={load}><Icon icon="lucide:refresh-cw" className="sa-btn__icon" />Refresh</button>}>
        {(err || (selected && !selected.connected)) && (
          <div className="sa-section__body sa-stack">
            {err && <Notice state="critical">{err}</Notice>}
            {selected && !selected.connected && <Notice state="attention">The engine the project uses is not connected, so the project answers nothing until it comes back — or choose another engine below.</Notice>}
          </div>
        )}
        <RecordList rows={v?.engines ?? null} empty="No engine has connected to this project yet." keyOf={(e) => e.id} columns={[
          { key: 'id', label: 'Engine', render: (e) => <Code>{e.id}</Code> },
          { key: 'host', label: 'Machine', render: (e) => <span>{e.host ?? '—'}</span> },
          { key: 'part', label: 'Part', render: (e) => e.selected ? <Status state="ok">Used</Status> : <Status state="neutral">Standby</Status> },
          { key: 'now', label: 'Now', render: (e) => e.connected ? <Status state="ok">Connected</Status> : <span className="sa-muted">Not connected</span> },
          { key: 'seen', label: 'Last seen', render: (e) => <span className="sa-num">{dateTime(e.lastSeen)}</span> },
          { key: 'act', label: '', align: 'end', render: (e) => e.selected ? null : (
            <span className="sa-row sa-row--tight">
              <button type="button" className="sa-btn" disabled={!!busy} onClick={() => act(e, 'select')}>
                <Icon icon="lucide:arrow-right-left" className="sa-btn__icon" /><span className="sa-btn__text">{busy === e.id ? 'Switching…' : 'Use this engine'}</span>
              </button>
              {!e.connected && <button type="button" className="sa-btn" disabled={!!busy} onClick={() => act(e, 'forget')}>
                <Icon icon="lucide:trash-2" className="sa-btn__icon" /><span className="sa-btn__text">Forget</span>
              </button>}
            </span>) },
        ]} />
      </Section>
    </div>
  )
}
