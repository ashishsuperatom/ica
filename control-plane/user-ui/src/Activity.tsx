// ACTIVITY — what is running for this person in the background (program builds, session runs), and what ran in the last
// day: listed when opened, then kept current by the hub's live activity messages.

import { useEffect, useState } from 'react'
import './session.css'

type Row = { id: string; kind: string; title: string; state: string; progress?: string | null; detail?: string | null; updated_at?: string; updatedAt?: string }

export default function Activity({ request, subscribe }: { request: (p: Record<string, unknown>) => Promise<any>; subscribe: (fn: (m: any) => void) => () => void }) {
  const [rows, setRows] = useState<Row[]>([])
  useEffect(() => { request({ t: 'activity:list' }).then((r) => setRows(r.activities ?? [])).catch(() => {}) }, [request])
  useEffect(() => subscribe((m) => {
    if (m.t !== 'activity' || !m.activity?.id) return
    setRows((prev) => [m.activity, ...prev.filter((x) => x.id !== m.activity.id)].slice(0, 100))
  }), [subscribe])
  return (
    <div className="sa-session">
      <header className="sa-session-head"><h1>Activity</h1></header>
      {!rows.length && <p className="sa-session-empty">Nothing running, and nothing in the last day.</p>}
      {rows.map((a) => (
        <div key={a.id} className="sa-block" style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
          <span style={{ minWidth: 64, fontWeight: 600, color: a.state === 'failed' ? 'var(--th-alert)' : a.state === 'running' ? 'var(--th-primary)' : undefined }}>{a.state}</span>
          <span style={{ flex: 1 }}>{a.title}{a.progress || a.detail ? <span className="sa-session-empty"> — {a.progress ?? a.detail}</span> : null}</span>
          <span className="sa-session-empty">{String(a.updated_at ?? a.updatedAt ?? '').slice(11, 19)}</span>
        </div>
      ))}
    </div>
  )
}
