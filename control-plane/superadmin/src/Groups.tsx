// ── Groups, for one project ─────────────────────────────────────────────────────────────────────────────────────────
// Who is in which group (scope group:<name>): people by email, agent keys by id. A group decides what its members see
// (agents, programs, knowledge scoped to it), which data access policies apply to them, and can carry a credit budget.
import React, { useCallback, useEffect, useState } from 'react'

type Api = (p: string, i?: RequestInit) => Promise<Response>
type Group = { name: string; description: string | null; members: string[] }

export function GroupsPanel({ api, projectId }: { api: Api; projectId: string }) {
  const [groups, setGroups] = useState<Group[]>([])
  const [name, setName] = useState('')
  const [member, setMember] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')
  const base = `/projects/${projectId}/groups`
  const load = useCallback(() => { api(base).then((r) => (r.ok ? r.json() : { groups: [] })).then((d) => setGroups((d as { groups: Group[] }).groups)).catch(() => {}) }, [api, base])
  useEffect(load, [load])
  const say = async (r: Response) => { if (!r.ok) setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Refused (${r.status}).`); else setErr(''); return r.ok }
  const create = async () => { if (await say(await api(base, { method: 'POST', body: JSON.stringify({ name: name.trim() }) }))) { setName(''); load() } }
  const add = async (g: string) => {
    const raw = (member[g] ?? '').trim()
    const m = raw.includes('@') && !raw.startsWith('email:') ? `email:${raw}` : raw
    if (await say(await api(`${base}/${g}/members`, { method: 'POST', body: JSON.stringify({ member: m }) }))) { setMember({ ...member, [g]: '' }); load() }
  }
  const remove = async (g: string, m: string) => { if (await say(await api(`${base}/${g}/members?member=${encodeURIComponent(m)}`, { method: 'DELETE' }))) load() }
  return (
    <div className="card">
      <strong>Groups</strong>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 2, marginBottom: 10 }}>A group decides what its members see (agents, programs and knowledge scoped to it), which data access policies apply to them, and can carry a credit budget.</div>
      {err && <div className="muted" style={{ color: '#b3261e', fontSize: 12.5, marginBottom: 10 }}>{err}</div>}
      <div className="row" style={{ gap: 8, marginBottom: 14 }}>
        <input id="group-name" className="input" style={{ maxWidth: 220 }} placeholder="finance" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" onClick={create} disabled={!name.trim()}>Create group</button>
      </div>
      {!groups.length && <div className="muted" style={{ fontSize: 12.5 }}>No groups yet.</div>}
      {groups.map((g) => (
        <div key={g.name} style={{ border: '1px solid var(--hair, #e2e4e8)', borderRadius: 6, padding: 12, marginBottom: 10 }}>
          <strong>{g.name}</strong> <span className="muted" style={{ fontSize: 12 }}>{g.members.length} member{g.members.length === 1 ? '' : 's'}</span>
          <div style={{ margin: '6px 0' }}>{g.members.map((m) => <span key={m} className="mono" style={{ fontSize: 12, marginRight: 10 }}>{m.replace(/^email:/, '')} <a href="#" onClick={(e) => { e.preventDefault(); void remove(g.name, m) }}>×</a></span>)}</div>
          <div className="row" style={{ gap: 8 }}>
            <input id={`group-add-${g.name}`} className="input" style={{ maxWidth: 280 }} placeholder="a@company.com or agent:key_…" value={member[g.name] ?? ''} onChange={(e) => setMember({ ...member, [g.name]: e.target.value })} />
            <button className="btn" onClick={() => add(g.name)} disabled={!(member[g.name] ?? '').trim()}>Add</button>
          </div>
        </div>
      ))}
    </div>
  )
}
