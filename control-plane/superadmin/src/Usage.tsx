// ── USAGE BY PERSON ─────────────────────────────────────────────────────────────────────────────────────────
// What each of the organisation's people used, across its projects, for a month: model calls, tokens (fresh input,
// output, prompt cache) and credits. 'unattributed' is work no turn named — the project's own (warm-up, a terminal
// session, a shared agent serving two people at once). An admin sees everyone; a member sees themselves.
import { useEffect, useMemo, useState } from 'react'

type Api = (path: string, init?: RequestInit) => Promise<Response>
type Totals = { calls: number; tokens_in: number; tokens_out: number; tokens_cache_read: number; tokens_cache_write: number; credits_micro: number; unpriced: number }
type Person = Totals & { person: string; projects: (Totals & { id: string; name: string })[] }

const cell: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid var(--line)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
const left: React.CSSProperties = { ...cell, textAlign: 'left' }
const head: React.CSSProperties = { ...cell, fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: .3 }
const n = (v: number) => v.toLocaleString()
const credits = (micro: number) => (micro / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })
const monthStart = (offset: number) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)).toISOString() }

export function UsagePanel({ api }: { api: Api }) {
  const [offset, setOffset] = useState(0)          // 0 = this month, -1 = last month, …
  const [people, setPeople] = useState<Person[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const since = monthStart(offset), until = monthStart(offset + 1)
  useEffect(() => {
    setPeople(null); setErr('')
    api(`/usage/people?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`)
      .then(async (r) => { if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json() })
      .then((d: any) => setPeople(Array.isArray(d?.people) ? d.people : []))
      .catch((e) => setErr(String(e?.message ?? e)))
  }, [api, since, until])
  const total = useMemo(() => (people ?? []).reduce((a, p) => a + p.credits_micro, 0), [people])
  const label = new Date(since).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })

  return (
    <section>
      <div className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 12 }}>
        <button className="btn ghost" onClick={() => setOffset(offset - 1)} aria-label="Previous month">‹</button>
        <strong style={{ minWidth: 140, textAlign: 'center' }}>{label}</strong>
        <button className="btn ghost" onClick={() => setOffset(offset + 1)} disabled={offset >= 0} aria-label="Next month">›</button>
        {people && <span className="muted" style={{ marginLeft: 'auto', fontSize: 13 }}>{credits(total)} credits · {people.length} {people.length === 1 ? 'person' : 'people'}</span>}
      </div>
      {err && <div className="empty">Could not load usage: {err}</div>}
      {!err && !people && <div className="muted">loading…</div>}
      {people && people.length === 0 && <div className="empty">No model use in {label}.</div>}
      {people && people.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr>
              <th style={{ ...head, textAlign: 'left' }}>person</th><th style={head}>calls</th><th style={head}>input</th>
              <th style={head}>output</th><th style={head}>cache read</th><th style={head}>cache write</th><th style={head}>credits</th>
            </tr></thead>
            <tbody>
              {people.flatMap((p) => {
                const isOpen = open === p.person
                const who = p.person === 'unattributed' ? 'Project work (no person)' : p.person.replace(/^email:/, '')
                return [
                  <tr key={p.person} onClick={() => setOpen(isOpen ? null : p.person)} style={{ cursor: 'pointer' }}>
                    <td style={{ ...left, fontWeight: 600, color: p.person === 'unattributed' ? 'var(--muted)' : undefined }}>{isOpen ? '▾' : '▸'} {who}</td>
                    <td style={cell}>{n(p.calls)}</td><td style={cell}>{n(p.tokens_in)}</td><td style={cell}>{n(p.tokens_out)}</td>
                    <td style={cell}>{n(p.tokens_cache_read)}</td><td style={cell}>{n(p.tokens_cache_write)}</td>
                    <td style={cell} title={p.unpriced ? `${p.unpriced} calls have no price yet` : undefined}>{credits(p.credits_micro)}{p.unpriced ? ' *' : ''}</td>
                  </tr>,
                  ...(isOpen ? p.projects.map((pr) => (
                    <tr key={`${p.person}/${pr.id}`} style={{ background: 'var(--soft, transparent)' }}>
                      <td style={{ ...left, paddingLeft: 30, color: 'var(--muted)' }}>{pr.name}</td>
                      <td style={cell}>{n(pr.calls)}</td><td style={cell}>{n(pr.tokens_in)}</td><td style={cell}>{n(pr.tokens_out)}</td>
                      <td style={cell}>{n(pr.tokens_cache_read)}</td><td style={cell}>{n(pr.tokens_cache_write)}</td><td style={cell}>{credits(pr.credits_micro)}</td>
                    </tr>)) : []),
                ]
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>* some calls have no price on the platform's list yet; their tokens are counted, their credits are not.</div>
    </section>
  )
}
