// ── CREDENTIALS ──────────────────────────────────────────────────────────────────────────────────────────
// Every key the coding agents use, and who may use it.
//
// THIS SCREEN NEVER SHOWS A CREDENTIAL. The API does not return values, so there is nothing here to leak: a
// screen that can render a key is a screen that can leak one over someone's shoulder, in a screenshot, or in a
// support call. What it shows is everything you need to decide something — which keys exist, whose they are,
// what is about to expire, and what has run out.
//
// The order of the page follows what an operator actually needs to know, worst first: what is expiring, then
// what is exhausted, then the rest.

import { useCallback, useEffect, useState } from 'react'

// The table markup used a class that was never defined anywhere, so it rendered with no borders, no padding
// and headers that did not line up with their columns. Styles live here, scoped to this screen, rather than in
// a shared sheet: this is the only table with these columns, and a shared rule is one another screen inherits
// by accident.
const CSS = `
.cred-tbl{width:100%;border-collapse:separate;border-spacing:0;font-size:13px}
.cred-tbl th{
  text-align:left;font-weight:600;font-size:11px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--sa-text-faint,#9a9285);padding:0 12px 8px;border-bottom:1px solid var(--sa-border,#e8e4de);white-space:nowrap}
.cred-tbl td{padding:11px 12px;border-bottom:1px solid var(--sa-border-soft,#f0ede8);vertical-align:top}
.cred-tbl tr:last-child td{border-bottom:none}
.cred-tbl tbody tr:hover{background:var(--sa-bg,#faf9f7)}
/* The id is the thing you scan for, so it leads and is monospaced; the note explains without competing. */
.cred-tbl .id{font-family:var(--sa-font-mono,ui-monospace,monospace);font-weight:600;white-space:nowrap}
.cred-tbl .note{font-size:12px;color:var(--sa-text-muted,#6b6560);margin-top:2px;max-width:280px}
.cred-tbl .sub{font-size:11px;color:var(--sa-text-faint,#9a9285);margin-top:2px;white-space:nowrap}
.cred-tbl td.acts{text-align:right;white-space:nowrap}
.cred-tbl td.acts .btn{margin-left:6px;padding:4px 10px;font-size:12px}
.cred-tbl .num{font-variant-numeric:tabular-nums}
.cred-row-off td{opacity:.5}
/* A state worth acting on should read as one; everything normal should stay quiet. */
.cred-tag{font-size:11px;font-weight:600;padding:2px 7px;border-radius:10px;white-space:nowrap}
.cred-ok{color:var(--sa-text-faint,#9a9285);font-weight:400}
.cred-warn{background:#fef3e2;color:#b45309}
.cred-bad{background:#fee;color:#b91c1c}
.cred-off{background:#f1f0ee;color:#6b6560}
`
let cssDone = false
function ensureCSS() {
  if (cssDone || typeof document === 'undefined') return
  cssDone = true
  const el = document.createElement('style'); el.textContent = CSS; document.head.appendChild(el)
}

interface Entry {
  id: string
  provider: string
  groups?: string[]
  note?: string
  addedAt?: string
  expiresInDays: number | null   // null = this kind of credential carries no expiry, not "unknown"
  expired: boolean
  exhausted: boolean
  spentUntil: number | null
  disabled?: boolean
  canAskUsage?: boolean
  usage?: {
    observedAt: number; percentUsed?: number; limit?: number; used?: number; remaining?: number
    unit?: string; resetsAt?: string; error?: string
    windows?: Record<string, { percent: number; resetsAt?: string }>
  } | null
}

interface Data {
  entries: Entry[]
  groups: Record<string, string>
  providers: string[]
  sealed: boolean
  expiring: { id: string; provider: string; inDays: number }[]
}

// useApi returns the raw Response — every screen parses it itself. Getting that wrong is what produced an
// empty credentials table and then a bare `{}`: a Response object stringifies to nothing, so the page reported
// "no credentials" about a vault that had three.
type Api = (path: string, init?: RequestInit) => Promise<Response>

/** Parse, and turn a failure into a message worth reading rather than a silent empty state. */
async function call(api: Api, path: string, init?: RequestInit): Promise<any> {
  const res = await api(path, init)
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { /* not JSON — the raw text is the message */ }
  if (!res.ok) throw new Error(body?.error ?? text?.slice(0, 200) ?? `HTTP ${res.status}`)
  return body
}

// The figure comes from the PROVIDER, not from anything we counted — so it is absolute, and a stale read is
// simply an older truth rather than a wrong one.
function usageCell(e: Entry) {
  if (!e?.canAskUsage) return <span className="cred-ok" title="this provider exposes no usage endpoint">—</span>
  const u = e.usage
  if (!u) return <span className="cred-ok">not checked</span>
  if (u.error) return <span className="cred-ok" title={u.error}>unavailable</span>
  const age = Math.round((Date.now() - u.observedAt) / 60000)
  const pct = typeof u.percentUsed === 'number' ? u.percentUsed : null
  const money = u.unit === 'usd' && typeof u.limit === 'number' ? `$${(u.used ?? 0).toFixed(2)} of $${u.limit}` : null
  const detail = u.windows
    ? Object.entries(u.windows).map(([k, w]) => `${k} ${w.percent}%`).join(' · ')
    : u.resetsAt ? `resets ${String(u.resetsAt).slice(0, 10)}` : ''
  return (
    <span title={`observed ${age}m ago${detail ? ' · ' + detail : ''}`}>
      <span className={pct !== null && pct >= 80 ? 'cred-tag cred-warn' : 'num'}>{money ?? (pct !== null ? `${pct}%` : '—')}</span>
      {detail && <div className="sub">{detail}</div>}
    </span>
  )
}

export function Credentials({ api }: { api: Api }) {
  ensureCSS()
  const [d, setD] = useState<Partial<Data> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setD(await call(api, '/credentials')); setErr(null) }
    catch (e: any) { setErr(String(e?.message ?? e)) }
  }, [api])
  useEffect(() => { load() }, [load])

  const act = async (path: string, init: RequestInit) => {
    setBusy(true)
    try { await call(api, path, init); await load(); setErr(null) }
    catch (e: any) { setErr(String(e?.message ?? e)) }
    finally { setBusy(false) }
  }

  const addEntry = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const groups = String(f.get('groups') || '').split(',').map(s => s.trim()).filter(Boolean)
    await act('/credentials/entry', {
      method: 'POST',
      body: JSON.stringify({
        id: f.get('id'), provider: f.get('provider'), value: f.get('value'),
        groups: groups.length ? groups : undefined, note: f.get('note') || undefined,
      }),
    })
    e.currentTarget.reset()
  }

  if (err && !d) return <div className="card"><b>Could not load credentials</b><div className="muted" style={{ marginTop: 6 }}>{err}</div></div>
  if (!d) return <div className="muted">Loading…</div>

  // Absent fields must not take the page down — but they must not be disguised as emptiness either. An API
  // that answered with an error or an older shape is a DIFFERENT fact from "there are no credentials", and
  // showing the second when the first is true is how someone concludes their vault is empty and re-adds keys
  // that were already there.
  if (!Array.isArray(d.entries)) {
    return (
      <div className="card" style={{ borderColor: '#b91c1c' }}>
        <b style={{ color: '#b91c1c' }}>Unexpected response</b>
        <div className="muted" style={{ marginTop: 6 }}>
          The API did not return a credential list. This is not the same as having none — nothing has been lost.
        </div>
        <pre className="mono" style={{ marginTop: 10, fontSize: 12, overflow: 'auto', maxHeight: 200 }}>
          {JSON.stringify(d, null, 2).slice(0, 1200)}
        </pre>
      </div>
    )
  }
  const entries = d.entries
  const groups = (d.groups && typeof d.groups === 'object') ? d.groups : {}
  const providers = Array.isArray(d.providers) ? d.providers : []
  const soon = Array.isArray(d.expiring) ? d.expiring : []

  return (
    <>
      {/* The warning goes first because it is the only thing here that is time-critical: a lapsed credential
          surfaces at the agent as something unrelated, which is expensive to diagnose. */}
      {soon.length > 0 && (
        <div className="card" style={{ borderColor: '#d97706', marginBottom: 16 }}>
          <b style={{ color: '#d97706' }}>Expiring soon</b>
          <ul style={{ margin: '8px 0 0 18px' }}>
            {soon.map(x => (
              <li key={x.id}>
                <code className="mono">{x.id}</code> ({x.provider}) — {x.inDays < 0 ? <b>expired</b> : <>in {x.inDays} day{x.inDays === 1 ? '' : 's'}</>}
                {x.provider === 'openai-codex' && <span className="muted"> · re-seed with <code className="mono">codex login</code></span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!d.sealed && (
        <div className="card" style={{ borderColor: '#b91c1c', marginBottom: 16 }}>
          <b style={{ color: '#b91c1c' }}>Not sealed</b>
          <div className="muted" style={{ marginTop: 6 }}>
            CREDENTIALS_MASTER_KEY is not set, so credentials are stored in the clear. Set it and re-save each entry.
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <b>Keys</b>
          <button className="btn ghost" disabled={busy} onClick={() => act('/credentials/refresh', { method: 'POST' })}>
            Refresh usage
          </button>
        </div>
        <div className="muted" style={{ margin: '4px 0 10px' }}>
          Values are never shown here and never returned by the API — only a box that proves which project it is
          ever receives one.
        </div>
        <table className="cred-tbl">
          <thead><tr>
            <th style={{ width: '30%' }}>Credential</th><th>Provider</th><th>Groups</th>
            <th>Used</th><th>Expires</th><th>State</th><th style={{ width: 170 }} />
          </tr></thead>
          <tbody>
            {entries.length === 0 && <tr><td colSpan={7} className="muted">
              Nothing in the vault yet. There is no fallback — a provider with no entry here simply fails, which
              is deliberate: borrowing an unrelated key is how one gets spent without anyone noticing.
            </td></tr>}
            {entries.map(e => (
              <tr key={e.id} style={e.disabled ? { opacity: 0.55 } : undefined}>
                <td><code className="mono">{e.id}</code>{e.note && <div className="muted" style={{ fontSize: 12 }}>{e.note}</div>}</td>
                <td>{e.provider}</td>
                <td>{e.groups?.length ? e.groups.join(', ') : <span className="muted">any</span>}</td>
                <td>{usageCell(e)}</td>
                <td className="num">
                  {e.expiresInDays === null
                    // Said explicitly: this kind of key HAS no expiry, which is different from not knowing.
                    ? <span className="cred-ok">none</span>
                    : e.expired ? <span className="cred-tag cred-bad">expired</span>
                    : e.expiresInDays <= 3 ? <span className="cred-tag cred-warn">{e.expiresInDays}d</span>
                    : <span>{e.expiresInDays}d</span>}
                </td>
                <td>
                  {e.disabled ? <span className="cred-tag cred-off" title="parked — kept, but never used">parked</span>
                    : e.exhausted ? <span className="cred-tag cred-warn">exhausted</span>
                    : <span className="cred-ok">ok</span>}
                </td>
                <td className="acts">
                  {e.exhausted && !e.disabled && <button className="btn ghost" disabled={busy}
                    onClick={() => act(`/credentials/revive/${encodeURIComponent(e.id)}`, { method: 'POST' })}>Revive</button>}
                  {/* Parking keeps the key and stops it being spent — the middle ground between using it and
                      having to enter it again later. */}
                  <button className="btn ghost" disabled={busy}
                    onClick={() => act(`/credentials/enable/${encodeURIComponent(e.id)}`, { method: 'POST', body: JSON.stringify({ enabled: !!e.disabled }) })}>
                    {e.disabled ? 'Enable' : 'Disable'}
                  </button>
                  <button className="btn ghost" disabled={busy}
                    onClick={() => confirm(`Remove ${e.id}? Any box using it falls back to the next candidate.`) &&
                      act(`/credentials/entry/${encodeURIComponent(e.id)}`, { method: 'DELETE' })}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <b>Add a key</b>
        <div className="muted" style={{ margin: '4px 0 10px' }}>
          Sealed on the way in. An expiry is read from the credential itself when it carries one (a JWT does),
          rather than typed — a date someone types is a date someone forgets.
        </div>
        <form onSubmit={addEntry} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input name="id" placeholder="id (codex2)" required className="input" style={{ width: 150 }} />
          <select name="provider" className="input" style={{ width: 170 }} required defaultValue="">
            <option value="" disabled>provider…</option>
            {providers.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <input name="groups" placeholder="groups (prod, test) — blank = any" className="input" style={{ width: 240 }} />
          <input name="note" placeholder="note" className="input" style={{ width: 200 }} />
          <input name="value" type="password" placeholder="the key" required className="input" style={{ flex: 1, minWidth: 240 }} />
          <button className="btn" disabled={busy}>Add</button>
        </form>
      </div>

      <div className="card">
        <b>Project groups</b>
        <div className="muted" style={{ margin: '4px 0 10px' }}>
          Which pool a project draws on. Unassigned projects are <code className="mono">default</code>, deliberately
          the least privileged — a project nobody has classified should not inherit production's quota.
        </div>
        <table className="cred-tbl">
          <thead><tr><th>Project</th><th>Group</th></tr></thead>
          <tbody>
            {Object.keys(groups).length === 0 && <tr><td colSpan={2} className="muted">None assigned — everything is <code className="mono">default</code>.</td></tr>}
            {Object.entries(groups).map(([pid, g]) => (
              <tr key={pid}><td><code className="mono">{pid}</code></td><td>{g}</td></tr>
            ))}
          </tbody>
        </table>
        <form className="row" style={{ gap: 8, marginTop: 10 }} onSubmit={async (ev) => {
          ev.preventDefault()
          const f = new FormData(ev.currentTarget)
          await act('/credentials/group', { method: 'POST', body: JSON.stringify({ projectId: f.get('projectId'), group: f.get('group') }) })
          ev.currentTarget.reset()
        }}>
          <input name="projectId" placeholder="project id" required className="input" style={{ flex: 1 }} />
          <input name="group" placeholder="group (prod)" required className="input" style={{ width: 160 }} />
          <button className="btn" disabled={busy}>Assign</button>
        </form>
      </div>

      {err && <div className="muted" style={{ color: '#b91c1c', marginTop: 12 }}>{err}</div>}
    </>
  )
}
