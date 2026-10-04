// AGENTS — the agents this person sees, and making a new one: a title, the domain of the knowledge graph it answers from,
// the programs it may run, who sees it (everyone, one of the person's groups, or just them) and where its STATE starts.
// It is made as a node of the composition graph (graph:agent), so it is owned, governed and versioned like any other.

import { useEffect, useState } from 'react'
import './session.css'

type Request = (payload: Record<string, unknown>) => Promise<any>
type Agent = { id: string; name: string; scope: string }

export default function Agents({ request, onOpen, scopes }: { request: Request; onOpen: (id: string) => void; scopes: string[] }) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [domains, setDomains] = useState<string[]>([])
  const [programs, setPrograms] = useState<{ name: string; published_at: string | null }[]>([])
  const [form, setForm] = useState({ name: '', title: '', domain: '', programs: [] as string[], scope: 'global' })
  const [err, setErr] = useState('')
  const [making, setMaking] = useState(false)
  const load = () => {
    request({ t: 'session:agents' }).then((r) => setAgents(r.agents ?? [])).catch(() => {})
    request({ t: 'graph:domains' }).then((r) => setDomains((r.domains ?? []).map((d: any) => d.name))).catch(() => {})
    request({ t: 'program:list' }).then((r) => setPrograms(Object.values(Object.fromEntries((r.programs ?? []).map((p: any) => [p.name, p]))) as any)).catch(() => {})
  }
  useEffect(load, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const make = async () => {
    setErr('')
    const name = form.name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
    const r = await request({ t: 'graph:agent', name, scope: form.scope, body: { title: form.title.trim(), domain: form.domain, programs: form.programs, ica: 'composer' }, reason: 'made in the user UI' })
    if (r.t !== 'graph:reply') { setErr(r.reason ?? 'The agent could not be made.'); return }
    setMaking(false); setForm({ name: '', title: '', domain: '', programs: [], scope: 'global' }); load()
  }

  return (
    <div className="sa-session">
      <header className="sa-session-head"><h1>Agents</h1><button type="button" className="sa-session-action" onClick={() => setMaking(!making)}>{making ? 'Cancel' : 'New agent'}</button></header>
      {err && <p className="sa-session-refused" role="alert">{err}</p>}
      {making && (
        <form onSubmit={(e) => { e.preventDefault(); void make() }} style={{ display: 'grid', gap: 10, maxWidth: 560, marginBottom: 24 }}>
          <label>Title <input id="ag-title" className="sa-session-action" style={{ width: '100%' }} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value, name: form.name || e.target.value })} placeholder="Unsettled trips" /></label>
          <label>Name (its id) <input id="ag-name" className="sa-session-action" style={{ width: '100%' }} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="unsettled-trips" /></label>
          <label>Answers from (domain) <select id="ag-domain" className="sa-session-action" value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })}><option value="" />{domains.map((d) => <option key={d}>{d}</option>)}</select></label>
          <fieldset style={{ border: 'none', padding: 0 }}><legend>Programs it may run</legend>
            {!programs.length && <span className="sa-session-empty">No programs yet.</span>}
            {programs.map((p) => <label key={p.name} style={{ display: 'block' }}><input type="checkbox" checked={form.programs.includes(p.name)} onChange={(e) => setForm({ ...form, programs: e.target.checked ? [...form.programs, p.name] : form.programs.filter((x) => x !== p.name) })} /> {p.name}{p.published_at ? '' : ' (draft)'}</label>)}
          </fieldset>
          <label>Who sees it <select id="ag-scope" className="sa-session-action" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
            <option value="global">Everyone in the project</option>
            {scopes.filter((x) => x.startsWith('group:')).map((g) => <option key={g} value={g}>The {g.slice(6)} group</option>)}
            {scopes.filter((x) => x.startsWith('user:')).map((u) => <option key={u} value={u}>Only me</option>)}
          </select></label>
          <div className="sa-session-actions"><button type="submit" className="sa-session-action" disabled={!form.title.trim() || !form.domain}>Make the agent</button></div>
        </form>
      )}
      {!agents.length && <p className="sa-session-empty">No agents you can see yet.</p>}
      {agents.map((a) => (
        <div key={a.id} className="sa-block" style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
          <strong style={{ flex: 1 }}>{a.name}</strong><span className="sa-session-empty">{a.scope === 'global' ? 'everyone' : a.scope}</span>
          <button type="button" className="sa-session-action" onClick={() => onOpen(a.id)}>Open</button>
        </div>
      ))}
    </div>
  )
}
