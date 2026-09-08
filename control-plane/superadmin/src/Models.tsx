// ── THE AGENTS SCREEN ───────────────────────────────────────────────────────────────────────────────────────
//
// Two jobs, two tables, and they are genuinely different work:
//
//   PROJECTS   which brain each project runs, and whether the assignment has been picked up. The job is to
//              spot the row that disagrees with itself and get to the project that owns it.
//   CATALOGUE  what those projects may choose from. The job is bulk entry the first time, one addition when an
//              account gains a model, and a removal that can tell you whether anything is using it.
//
// Both are tables because both are scanned, not read. An earlier version made the catalogue a chip per model:
// tidy, and hostile to the only bulk operation it has — so entry is a paste box, as it was when this was a
// textarea, and the table is what you scan afterwards.
//
// TWO FACTS, NEVER BLENDED. `assigned` is what superadmin saved; `running` is what that project's own engine
// reported, with the time it said so. They differ whenever a box is asleep, unreachable, or mid-question.
//
// The catalogue is platform-wide and never leaves the control plane: a box is given its decision — one
// harness, one provider, one model per agent — not the options behind it.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

type Api = (path: string, init?: RequestInit) => Promise<Response>
type Provider = { name: string; route: string; disabled: string | null }
type AgentRow = { harness: string; provider: string; model: string }
type Row = {
  org: string; orgId: string; projectId: string; project: string
  savedVersion: number | null
  running: { version: number; at?: number; agents?: Record<string, AgentRow> } | null
  error?: string
}

const AGENTS = ['analyst', 'connector', 'grounding', 'modeller', 'composer', 'narrator']
const cell: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid var(--line)', textAlign: 'left', verticalAlign: 'top' }
const head: React.CSSProperties = { ...cell, fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: .3 }
const ago = (t?: number) => {
  if (!t) return ''
  const m = Math.round((Date.now() - t) / 60000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
}

export function AgentsScreen({ api }: { api: Api }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [models, setModels] = useState<Record<string, string[]> | null>(null)
  const [saved, setSaved] = useState<Record<string, string[]> | null>(null)   // to know what is unsaved
  const [providers, setProviders] = useState<Provider[]>([])
  const [source, setSource] = useState<'stored' | 'default' | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [pr, cat] = await Promise.all([api('/profiles'), api('/catalogue')])
    if (pr.ok) setRows(((await pr.json()) as any).projects ?? [])
    if (cat.ok) {
      const d = await cat.json() as any
      setProviders(d.providers ?? [])
      setModels(d.models ?? {}); setSaved(d.models ?? {})
      setSource(d.source ?? null)
    }
  }, [api])
  useEffect(() => { load() }, [load])

  // WHO IS USING WHAT, from what the engines report — so removing a model can say that it would strand a
  // project, rather than that turning up later as an agent which will not start.
  const usedBy = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const r of rows ?? [])
      for (const a of Object.values(r.running?.agents ?? {})) {
        const k = `${a.provider}/${a.model}`
        m.set(k, [...(m.get(k) ?? []), r.project])
      }
    return m
  }, [rows])

  const dirty = models && saved && JSON.stringify(models) !== JSON.stringify(saved)
  const save = async () => {
    setBusy(true); setMsg('saving…')
    const r = await api('/catalogue', { method: 'PUT', body: JSON.stringify({ models }) })
    setBusy(false)
    if (!r.ok) { setMsg(`could not save: ${r.status} ${await r.text()}`); return }
    await load()          // re-read: the project dropdowns offer whatever is STORED
    setMsg('saved')
  }

  if (!rows || !models) return <div className="muted">loading…</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
      <Projects rows={rows} onRefresh={load} />
      <Catalogue providers={providers} models={models} usedBy={usedBy} source={source} dirty={!!dirty} busy={busy} msg={msg}
                 onChange={setModels} onSave={save} onDiscard={() => { setMsg(''); load() }} />
    </div>
  )
}

// ── PROJECTS ────────────────────────────────────────────────────────────────────────────────────────────────
function Projects({ rows, onRefresh }: { rows: Row[]; onRefresh: () => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const drift = rows.filter(r => r.running && r.savedVersion != null && r.running.version !== r.savedVersion).length
  const dark = rows.filter(r => !r.running).length
  return (
    <section>
      <div className="between" style={{ alignItems: 'baseline' }}>
        <h3 style={{ margin: '0 0 2px' }}>Projects</h3>
        <div className="row" style={{ gap: 12, alignItems: 'center', fontSize: 12.5 }}>
          <span className="muted">
            {rows.length - dark} running{drift ? ` · ${drift} not picked up` : ''}{dark ? ` · ${dark} offline` : ''}
          </span>
          <button className="btn ghost" onClick={onRefresh}>Refresh</button>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
        Assigned on each project’s own settings page; reported by that project’s engine.
      </div>
      {rows.length === 0 ? <div className="empty">No projects yet.</div> : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr>
              <th style={head}>project</th><th style={head}>org</th><th style={head}>assigned</th>
              <th style={head}>running</th><th style={head}>composer</th><th style={head}></th>
            </tr></thead>
            <tbody>
              {rows.map(r => {
                const live = r.running
                const agreed = live && live.version === r.savedVersion
                const comp = live?.agents?.composer
                const isOpen = open === r.projectId
                return [
                  <tr key={r.projectId}>
                    <td style={cell}>
                      <span onClick={() => setOpen(isOpen ? null : r.projectId)} style={{ cursor: 'pointer', fontWeight: 600 }}>
                        {isOpen ? '▾' : '▸'} {r.project}
                      </span>
                    </td>
                    <td style={{ ...cell, color: 'var(--muted)' }}>{r.org}</td>
                    <td style={cell}><code className="mono">v{r.savedVersion ?? '—'}</code></td>
                    <td style={cell}>
                      {live
                        ? <span style={{ color: agreed ? 'var(--ok)' : 'var(--bad)' }}>
                            v{live.version}{agreed ? '' : ' — not picked up'}
                            <span className="muted" style={{ marginLeft: 6, fontSize: 11.5 }}>{ago(live.at)}</span>
                          </span>
                        : <span className="muted">engine offline</span>}
                    </td>
                    <td style={{ ...cell, fontFamily: 'monospace', fontSize: 11.5 }}>
                      {comp ? `${comp.harness} · ${comp.provider} · ${comp.model}` : <span className="muted">—</span>}
                    </td>
                    <td style={{ ...cell, textAlign: 'right' }}>
                      <Link to={`/org/${r.orgId}/projects/${r.projectId}/settings`} style={{ fontSize: 12.5 }}>Configure →</Link>
                    </td>
                  </tr>,
                  // Expanded: every agent, and ONLY what the engine reports — an assignment nothing has picked
                  // up is deliberately not drawn as a table of agents.
                  isOpen && live?.agents ? (
                    <tr key={r.projectId + ':open'}>
                      <td style={{ ...cell, background: 'var(--line)' }} colSpan={6}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 6 }}>
                          {AGENTS.map(a => {
                            const x = live.agents![a]
                            return x ? (
                              <div key={a} style={{ fontSize: 12 }}>
                                <span className="muted">{a}</span><br />
                                <code className="mono" style={{ fontSize: 11.5 }}>{x.harness} · {x.provider} · {x.model}</code>
                              </div>
                            ) : null
                          })}
                        </div>
                      </td>
                    </tr>
                  ) : null,
                  r.error ? (
                    <tr key={r.projectId + ':err'}><td style={{ ...cell, color: 'var(--bad)' }} colSpan={6}>could not read: {r.error}</td></tr>
                  ) : null,
                ]
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ── CATALOGUE ───────────────────────────────────────────────────────────────────────────────────────────────
function Catalogue({ providers, models, usedBy, source, dirty, busy, msg, onChange, onSave, onDiscard }: {
  providers: Provider[]; models: Record<string, string[]>; usedBy: Map<string, string[]>
  source: string | null; dirty: boolean; busy: boolean; msg: string
  onChange: (m: Record<string, string[]>) => void; onSave: () => void; onDiscard: () => void
}) {
  const [addTo, setAddTo] = useState<string>('')
  const [paste, setPaste] = useState('')
  const [q, setQ] = useState('')
  // TWO STEPS TO REMOVE, inline rather than a modal: the list is long, the rows are one click apart, and the
  // damage is silent — a model that vanishes from the catalogue leaves a project's saved choice pointing at
  // something the editor no longer offers. Asking costs one click; not asking costs a puzzled hour later.
  const [confirming, setConfirming] = useState<string | null>(null)

  // BULK, because that is the operation this screen actually has: the first time an account is set up, its
  // whole list arrives at once. One-at-a-time entry made the common case 24 separate actions.
  const addMany = () => {
    const names = paste.split(/[\n,]/).map(s => s.trim()).filter(Boolean)
    if (!addTo || names.length === 0) return
    onChange({ ...models, [addTo]: [...new Set([...(models[addTo] ?? []), ...names])].sort() })
    setPaste('')
  }
  const remove = (provider: string, model: string) =>
    onChange({ ...models, [provider]: (models[provider] ?? []).filter(m => m !== model) })

  // Matched on the ACCOUNT as well as the model, so "opencode" narrows to one account and "glm" to a family.
  const needle = q.trim().toLowerCase()
  const hit = (p: Provider, m: string) => !needle || m.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle)
  const flat = providers.flatMap(p => (models[p.name] ?? []).filter(m => hit(p, m)).map(m => ({ p, m })))
  const total = providers.reduce((n, p) => n + (models[p.name] ?? []).length, 0)
  return (
    <section>
      <div className="between" style={{ alignItems: 'baseline' }}>
        <h3 style={{ margin: '0 0 2px' }}>Catalogue</h3>
        <span className="muted" style={{ fontSize: 12 }}>
          {source === 'default' ? 'showing the shipped default — nothing saved yet' : ''}
        </span>
      </div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
        What a project’s profile may choose from, per account. Adding one makes it selectable everywhere, with no
        engine rebuild.
      </div>
      <div className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 8 }}>
        <input className="input" value={q} onChange={e => setQ(e.target.value)} placeholder="search models or accounts…"
               style={{ fontSize: 13, width: 260 }} />
        <span className="muted" style={{ fontSize: 12.5 }}>
          {needle ? `${flat.length} of ${total}` : `${total} model${total === 1 ? '' : 's'}`}
        </span>
        {needle && <button className="btn ghost" onClick={() => setQ('')}>Clear</button>}
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr>
            <th style={head}>account</th><th style={head}>route</th><th style={head}>model</th>
            <th style={head}>used by</th><th style={head}></th>
          </tr></thead>
          <tbody>
            {flat.map(({ p, m }) => {
              const users = usedBy.get(`${p.name}/${m}`) ?? []
              return (
                <tr key={`${p.name}/${m}`} style={{ opacity: p.disabled ? .6 : 1 }}>
                  <td style={{ ...cell, fontFamily: 'monospace', fontSize: 12 }}>{p.name}</td>
                  <td style={{ ...cell, color: 'var(--muted)', fontSize: 12 }}>
                    {p.route}{p.disabled ? ' · off' : ''}
                  </td>
                  <td style={{ ...cell, fontFamily: 'monospace', fontSize: 12 }}>{m}</td>
                  <td style={{ ...cell, fontSize: 12, color: users.length ? 'var(--ok)' : 'var(--muted)' }}>
                    {users.length ? users.join(', ') : '—'}
                  </td>
                  <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {confirming === `${p.name}/${m}`
                      ? <span className="row" style={{ gap: 8, justifyContent: 'flex-end', fontSize: 12 }}>
                          <span style={{ color: users.length ? 'var(--bad)' : 'var(--muted)' }}>
                            {users.length ? `used by ${users.join(', ')} — remove anyway?` : 'remove?'}
                          </span>
                          <span onClick={() => { remove(p.name, m); setConfirming(null) }}
                                style={{ cursor: 'pointer', color: 'var(--bad)', fontWeight: 600 }}>remove</span>
                          <span onClick={() => setConfirming(null)} style={{ cursor: 'pointer', color: 'var(--muted)' }}>cancel</span>
                        </span>
                      : <span onClick={() => setConfirming(`${p.name}/${m}`)} title="remove"
                              style={{ cursor: 'pointer', color: users.length ? 'var(--bad)' : 'var(--muted)' }}>×</span>}
                  </td>
                </tr>
              )
            })}
            {needle && flat.length === 0 && (
              <tr><td style={{ ...cell, color: 'var(--muted)' }} colSpan={5}>nothing matches “{q}”.</td></tr>
            )}
            {/* An account with nothing catalogued still gets a row: knowing it EXISTS and cannot be chosen yet
                is the thing you came to find out. Hidden while searching — it is not a match. */}
            {!needle && providers.filter(p => (models[p.name] ?? []).length === 0).map(p => (
              <tr key={p.name} style={{ opacity: .6 }}>
                <td style={{ ...cell, fontFamily: 'monospace', fontSize: 12 }}>{p.name}</td>
                <td style={{ ...cell, color: 'var(--muted)', fontSize: 12 }}>{p.route}{p.disabled ? ' · off' : ''}</td>
                <td style={{ ...cell, color: 'var(--muted)', fontSize: 12 }} colSpan={3}>
                  nothing catalogued — no project can choose this account
                  {p.disabled ? ` · ${p.disabled}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ padding: 14, marginTop: 12 }}>
        <strong style={{ fontSize: 13 }}>Add models</strong>
        <div className="muted" style={{ fontSize: 12.5, margin: '4px 0 8px' }}>One per line, or comma separated. Duplicates are ignored.</div>
        <div className="row" style={{ gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <select className="input" value={addTo} onChange={e => setAddTo(e.target.value)} style={{ fontSize: 13 }}>
            <option value="">choose an account…</option>
            {providers.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
          <textarea className="input" value={paste} onChange={e => setPaste(e.target.value)} rows={3} placeholder={'deepseek-v4-flash\nglm-5.3'}
                    style={{ flex: 1, minWidth: 260, fontFamily: 'monospace', fontSize: 13, resize: 'vertical' }} />
          <button className="btn ghost" onClick={addMany} disabled={!addTo || !paste.trim()}>Add</button>
        </div>
      </div>

      <div className="row" style={{ gap: 10, marginTop: 12, alignItems: 'center' }}>
        <button className="btn" onClick={onSave} disabled={busy || !dirty}>Save catalogue</button>
        <button className="btn ghost" onClick={onDiscard} disabled={busy || !dirty}>Discard changes</button>
        <span className="muted" style={{ fontSize: 12.5 }}>{dirty ? 'unsaved changes' : msg}</span>
      </div>
    </section>
  )
}
