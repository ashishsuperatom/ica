// ── THE MODEL CATALOGUE — which models each provider may be asked for ───────────────────────────────────────
//
// Platform-wide and superadmin-only, like Credentials beside it: "opencode-go carries kimi-k3" is true for
// every project, so it is held once rather than copied into each one.
//
// WHAT THIS IS NOT. It never reaches a project or an engine. A box is given the DECISION its profile makes —
// one harness, one provider, one model per agent — not the options behind it. This screen exists so that the
// decision is made from a list rather than typed, because a model name typed into a running system is a
// failure that surfaces later, as an agent that will not start.
//
// Adding a model is an edit here. It used to be a rebuild of the engine image and a roll of every machine,
// which is the friction this whole configuration path exists to remove.
import { useCallback, useEffect, useState } from 'react'

type Api = (path: string, init?: RequestInit) => Promise<Response>

export function ModelCatalogue({ api }: { api: Api }) {
  const [models, setModels] = useState<Record<string, string[]> | null>(null)
  const [providers, setProviders] = useState<string[]>([])
  const [updated, setUpdated] = useState<{ by: string | null; at: number } | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const r = await api('/catalogue')
    if (!r.ok) { setMsg(`could not load: ${r.status}`); return }
    const d = await r.json() as any
    setProviders(d.providers ?? [])
    // No catalogue set yet is a real state, not an error: every provider simply starts with an empty list.
    setModels(d.models ?? Object.fromEntries((d.providers ?? []).map((p: string) => [p, []])))
    setUpdated(d.updatedAt ? { by: d.updatedBy, at: d.updatedAt } : null)
  }, [api])
  useEffect(() => { load() }, [load])

  const save = async () => {
    setBusy(true); setMsg('saving…')
    const r = await api('/catalogue', { method: 'PUT', body: JSON.stringify({ models }) })
    setBusy(false)
    if (!r.ok) { setMsg(`could not save: ${r.status} ${await r.text()}`); return }
    // Re-read rather than trust the write: what the next profile editor offers is whatever is STORED, so that
    // is what this screen should show.
    await load()
    setMsg('saved')
  }

  if (!models) return <div className="muted">{msg || 'loading…'}</div>

  const setList = (provider: string, text: string) =>
    setModels(m => ({ ...m!, [provider]: text.split(/[\n,]/).map(s => s.trim()).filter(Boolean) }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720 }}>
      {providers.map(p => (
        <div key={p} className="card" style={{ padding: 16 }}>
          <div className="between" style={{ alignItems: 'baseline' }}>
            <strong className="mono">{p}</strong>
            <span className="muted" style={{ fontSize: 12 }}>{(models[p] ?? []).length} model{(models[p] ?? []).length === 1 ? '' : 's'}</span>
          </div>
          <div className="muted" style={{ fontSize: 12.5, margin: '4px 0 8px' }}>One per line. These are what a project may choose from for this account.</div>
          <textarea value={(models[p] ?? []).join('\n')} onChange={e => setList(p, e.target.value)} rows={Math.max(3, (models[p] ?? []).length + 1)}
                    style={{ width: '100%', fontFamily: 'monospace', fontSize: 13, padding: 10, borderRadius: 8, resize: 'vertical' }} />
        </div>
      ))}
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <button className="btn" onClick={save} disabled={busy}>Save catalogue</button>
        <button className="btn ghost" onClick={() => { setMsg(''); load() }} disabled={busy}>Reload</button>
        <span className="muted" style={{ fontSize: 12.5 }}>{msg}</span>
        {updated && <span className="muted" style={{ fontSize: 12.5, marginLeft: 'auto' }}>
          last changed {new Date(updated.at).toLocaleString()}{updated.by ? ` by ${updated.by}` : ''}
        </span>}
      </div>
    </div>
  )
}

// ── WHAT EACH PROJECT IS ACTUALLY RUNNING ──────────────────────────────────────────────────────────────────
//
// Superadmin ASSIGNS a profile to a project. Whether a machine took it is a different fact, known only to that
// machine, reported to its own project's DO — so pushing a change to a dozen projects left nowhere to see
// which of them had applied it. This is that place.
//
// It shows the two versions side by side and never blends them: a project whose engine is asleep reads as
// "not connected", not as "applied". A row where saved and running disagree is the interesting row.
export function AppliedProfiles({ api }: { api: Api }) {
  const [rows, setRows] = useState<any[] | null>(null)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    setMsg('loading…')
    const r = await api('/profiles')
    if (!r.ok) { setMsg(`could not load: ${r.status}`); return }
    setRows(((await r.json()) as any).projects ?? [])
    setMsg('')
  }, [api])
  useEffect(() => { load() }, [load])

  if (!rows) return <div className="muted">{msg || 'loading…'}</div>
  if (rows.length === 0) return <div className="muted">No projects yet.</div>

  const AGENTS = ['analyst', 'connector', 'grounding', 'modeller', 'composer', 'narrator']
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <button className="btn ghost" onClick={load}>Refresh</button>
        <span className="muted" style={{ fontSize: 12.5 }}>{msg}</span>
      </div>
      {rows.map(r => {
        const live = r.running
        const agreed = live && r.savedVersion === live.version
        return (
          <div key={r.projectId} className="card" style={{ padding: 14 }}>
            <div className="between" style={{ alignItems: 'baseline' }}>
              <div>
                <strong>{r.project}</strong>
                <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>{r.org}</span>
              </div>
              <div className="row" style={{ gap: 10, fontSize: 12.5, alignItems: 'center' }}>
                <span className="muted">assigned</span><code className="mono">v{r.savedVersion ?? '—'}</code>
                <span className="muted">running</span>
                {live
                  ? <code className="mono" style={{ color: agreed ? 'var(--ok)' : 'var(--bad)' }}>v{live.version}</code>
                  : <span style={{ color: 'var(--muted)' }}>engine not connected</span>}
              </div>
            </div>
            {/* Only what the ENGINE reports — an assigned profile nothing has picked up is deliberately not
                drawn here, because a table that renders intentions as facts is the thing this screen exists
                to replace. */}
            {live?.agents && (
              <div style={{ marginTop: 10, fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap', color: 'var(--muted)' }}>
                {AGENTS.map(a => {
                  const x = live.agents[a]
                  return x ? `${a.padEnd(10)} ${x.harness} · ${x.provider} · ${x.model}\n` : null
                })}
              </div>
            )}
            {r.error && <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--bad)' }}>could not read: {r.error}</div>}
          </div>
        )
      })}
    </div>
  )
}
