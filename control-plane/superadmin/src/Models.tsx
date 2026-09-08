// ── THE AGENTS SCREEN — what every project runs, and what it may choose from ────────────────────────────────
//
// One screen with a direction of travel: read the fleet at a glance, spot the row that disagrees with itself,
// click through to the project that owns the decision. The catalogue underneath is the supply side — what the
// dropdowns on that project page will offer.
//
// TWO FACTS, NEVER BLENDED. `assigned` is what superadmin saved for a project; `running` is what that
// project's own engine reported. They differ whenever a box is asleep, unreachable, or still finishing a
// question, and a screen that showed one number would be lying half the time.
//
// The catalogue is PLATFORM-WIDE and never leaves the control plane: a box is given its decision — one
// harness, one provider, one model per agent — not the options behind it.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

type Api = (path: string, init?: RequestInit) => Promise<Response>
type Provider = { name: string; route: string; disabled: string | null }
type Row = {
  org: string; orgId: string; projectId: string; project: string
  savedVersion: number | null; updatedAt?: number
  running: { version: number; agents?: Record<string, { harness: string; provider: string; model: string }> } | null
  error?: string
}

const AGENTS = ['analyst', 'connector', 'grounding', 'modeller', 'composer', 'narrator']

const chip = (bg: string, fg: string): React.CSSProperties => ({
  padding: '2px 8px', borderRadius: 999, fontSize: 11.5, background: bg, color: fg, whiteSpace: 'nowrap',
})

export function AgentsScreen({ api }: { api: Api }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [models, setModels] = useState<Record<string, string[]> | null>(null)
  const [providers, setProviders] = useState<Provider[]>([])
  const [source, setSource] = useState<'stored' | 'default' | null>(null)
  const [updated, setUpdated] = useState<{ by: string | null; at: number } | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [pr, cat] = await Promise.all([api('/profiles'), api('/catalogue')])
    if (pr.ok) setRows(((await pr.json()) as any).projects ?? [])
    if (cat.ok) {
      const d = await cat.json() as any
      setProviders(d.providers ?? [])
      setModels(d.models ?? {})
      setSource(d.source ?? null)
      setUpdated(d.updatedAt ? { by: d.updatedBy, at: d.updatedAt } : null)
    }
  }, [api])
  useEffect(() => { load() }, [load])

  // WHICH MODELS ARE ACTUALLY IN USE, from what the engines report — so removing one from the catalogue can
  // show that it would strand a project rather than finding out later.
  const inUse = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const r of rows ?? []) {
      for (const a of Object.values(r.running?.agents ?? {})) {
        if (!m.has(a.provider)) m.set(a.provider, new Set())
        m.get(a.provider)!.add(a.model)
      }
    }
    return m
  }, [rows])

  const save = async () => {
    setBusy(true); setMsg('saving…')
    const r = await api('/catalogue', { method: 'PUT', body: JSON.stringify({ models }) })
    setBusy(false)
    if (!r.ok) { setMsg(`could not save: ${r.status} ${await r.text()}`); return }
    await load()          // re-read: what the project dropdowns offer is whatever is STORED
    setMsg('saved')
  }

  if (!rows || !models) return <div className="muted">loading…</div>

  const live = rows.filter(r => r.running)
  const drift = rows.filter(r => r.running && r.savedVersion != null && r.running.version !== r.savedVersion)
  const dark = rows.filter(r => !r.running)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>

      {/* WHERE TO LOOK FIRST. Three counts, and only the middle one is ever a problem. */}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={chip('var(--line)', 'inherit')}>{rows.length} project{rows.length === 1 ? '' : 's'}</span>
        <span style={chip('rgba(34,160,90,.14)', 'var(--ok)')}>{live.length} running</span>
        {drift.length > 0 && <span style={chip('rgba(200,60,60,.14)', 'var(--bad)')}>{drift.length} not picked up</span>}
        {dark.length > 0 && <span style={chip('var(--line)', 'var(--muted)')}>{dark.length} engine offline</span>}
        <button className="btn ghost" onClick={load} style={{ marginLeft: 'auto' }}>Refresh</button>
      </div>

      <section>
        <h3 style={{ margin: '0 0 2px' }}>Running now</h3>
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
          Assigned on each project’s own settings page; reported by that project’s engine. Open a project to change it.
        </div>
        {rows.length === 0 && <div className="empty">No projects yet.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map(r => {
            const agreed = r.running && r.running.version === r.savedVersion
            return (
              <div key={r.projectId} className="card" style={{ padding: 14 }}>
                <div className="between" style={{ alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                  <div>
                    <Link to={`/org/${r.orgId}/projects/${r.projectId}/settings`} style={{ fontWeight: 600, color: 'inherit' }}>
                      {r.project}
                    </Link>
                    <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>{r.org}</span>
                  </div>
                  <div className="row" style={{ gap: 8, alignItems: 'center', fontSize: 12.5 }}>
                    <span className="muted">assigned v{r.savedVersion ?? '—'}</span>
                    {r.running
                      ? <span style={agreed ? chip('rgba(34,160,90,.14)', 'var(--ok)') : chip('rgba(200,60,60,.14)', 'var(--bad)')}>
                          {agreed ? `running v${r.running.version}` : `running v${r.running.version} — not picked up`}
                        </span>
                      : <span style={chip('var(--line)', 'var(--muted)')}>engine offline</span>}
                    <Link to={`/org/${r.orgId}/projects/${r.projectId}/settings`} className="muted" style={{ fontSize: 12.5 }}>Configure →</Link>
                  </div>
                </div>
                {/* Only what the ENGINE reports. An assignment nothing has picked up is deliberately not drawn
                    as a table of agents — rendering intentions as facts is what this screen replaces. */}
                {r.running?.agents && (
                  <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 6 }}>
                    {AGENTS.map(a => {
                      const x = r.running!.agents![a]
                      return x ? (
                        <div key={a} style={{ fontSize: 12 }}>
                          <span className="muted">{a}</span><br />
                          <code className="mono" style={{ fontSize: 11.5 }}>{x.harness} · {x.provider} · {x.model}</code>
                        </div>
                      ) : null
                    })}
                  </div>
                )}
                {r.error && <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--bad)' }}>could not read: {r.error}</div>}
              </div>
            )
          })}
        </div>
      </section>

      <section>
        <div className="between" style={{ alignItems: 'baseline' }}>
          <h3 style={{ margin: '0 0 2px' }}>Catalogue</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            {source === 'default' ? 'showing the shipped default — nothing saved yet'
              : updated ? `saved ${new Date(updated.at).toLocaleString()}${updated.by ? ` by ${updated.by}` : ''}` : ''}
          </span>
        </div>
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
          What a project’s profile may choose from, per account. Adding one here makes it selectable everywhere —
          no engine rebuild. A model marked <span style={{ color: 'var(--ok)' }}>●</span> is in use by a project right now.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {providers.map(p => (
            <ProviderCard key={p.name} provider={p} models={models[p.name] ?? []} inUse={inUse.get(p.name) ?? new Set()}
                          onChange={list => setModels(m => ({ ...m!, [p.name]: list }))} />
          ))}
        </div>
        <div className="row" style={{ gap: 10, marginTop: 12, alignItems: 'center' }}>
          <button className="btn" onClick={save} disabled={busy}>Save catalogue</button>
          <button className="btn ghost" onClick={() => { setMsg(''); load() }} disabled={busy}>Discard changes</button>
          <span className="muted" style={{ fontSize: 12.5 }}>{msg}</span>
        </div>
      </section>
    </div>
  )
}

// One account's models, as removable chips plus a box to add one. A textarea of names was quicker to build and
// told you nothing: not which are in use, not which account this is, not whether it can be routed at all.
function ProviderCard({ provider, models, inUse, onChange }:
  { provider: Provider; models: string[]; inUse: Set<string>; onChange: (list: string[]) => void }) {
  const [adding, setAdding] = useState('')
  const add = () => {
    const v = adding.trim()
    if (!v || models.includes(v)) { setAdding(''); return }
    onChange([...models, v].sort())
    setAdding('')
  }
  return (
    <div className="card" style={{ padding: 14, opacity: provider.disabled ? .75 : 1 }}>
      <div className="between" style={{ alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
          <strong className="mono">{provider.name}</strong>
          <span style={chip('var(--line)', 'var(--muted)')}>{provider.route}</span>
          {provider.disabled && <span style={chip('rgba(200,60,60,.14)', 'var(--bad)')}>turned off at the proxy</span>}
        </div>
        <span className="muted" style={{ fontSize: 12 }}>{models.length} model{models.length === 1 ? '' : 's'}</span>
      </div>
      {provider.disabled &&
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {provider.disabled} — kept here so switching it back on needs no re-entry.
        </div>}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
        {models.map(m => {
          const used = inUse.has(m)
          return (
            <span key={m} className="row" style={{ gap: 6, padding: '3px 9px', border: '1px solid var(--line)', borderRadius: 999, fontSize: 12.5 }}>
              {used && <span style={{ color: 'var(--ok)' }} title="in use by a project right now">●</span>}
              <code className="mono" style={{ fontSize: 12 }}>{m}</code>
              <span onClick={() => onChange(models.filter(x => x !== m))} title={used ? 'in use — removing it strands a project' : 'remove'}
                    style={{ cursor: 'pointer', color: used ? 'var(--bad)' : 'var(--muted)' }}>×</span>
            </span>
          )
        })}
        {models.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>nothing catalogued — no project can pick this account yet</span>}
      </div>
      <input value={adding} onChange={e => setAdding(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add() }}
             onBlur={add} placeholder="add a model, then Enter"
             style={{ marginTop: 10, padding: '6px 10px', borderRadius: 8, fontSize: 13, width: 260 }} />
    </div>
  )
}
