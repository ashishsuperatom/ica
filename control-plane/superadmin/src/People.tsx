// WHO MAY DO WHAT IN AN ORGANISATION, in the console ("Permissions — who may do what", docs/platform-architecture.md):
// its people and their roles, the roles themselves (owners define custom ones from the capabilities), what was changed,
// and organisation keys. The server decides (shared/permissions.ts); here only what the person may give is offered.
// Drawn only with the semantic components (@superatom/ui).

import { useCallback, useEffect, useState } from 'react'
import { Section, RecordList, Form, Field, Choices, Notice, Status, Code, Icon } from '@superatom/ui'
import { ORG_CAPABILITIES, ORG_KEY_SCOPES, PROJECT_CAPABILITIES, type OrgCapability, type ProjectCapability } from '../../shared/permissions'

type Api = (path: string, init?: RequestInit) => Promise<Response>
type Role = { id: string; name: string; capabilities: string[]; builtin: boolean }
type Person = { id: string; email: string; name: string; role: string; capabilities: string[]; created_at?: number }
type Key = { id: string; name: string; prefix: string; scopes: string[]; created_by: string; created_at: string; expires_at: string | null; revoked_at: string | null; last_used_at: string | null }
const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
const errorOf = async (r: Response) => ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Refused (${r.status})`

/** What the caller holds in this organisation. */
function useMine(api: Api) {
  const [caps, setCaps] = useState<string[] | null>(null)
  useEffect(() => { api('/me').then((r) => (r.ok ? r.json() : null)).then((d) => setCaps((d as { capabilities?: string[] } | null)?.capabilities ?? [])).catch(() => setCaps([])) }, [api])
  return caps
}

export function OrgPeoplePanel({ api }: { api: Api }) {
  const mine = useMine(api)
  const [people, setPeople] = useState<Person[] | null>(null)
  const [roles, setRoles] = useState<Role[] | null>(null)
  const [err, setErr] = useState('')
  const [adding, setAdding] = useState({ email: '', name: '', role: 'member' })
  const load = useCallback(() => {
    api('/users').then((r) => (r.ok ? r.json() : [])).then((d) => setPeople(Array.isArray(d) ? d : [])).catch(() => {})
    api('/roles').then((r) => (r.ok ? r.json() : { roles: [] })).then((d) => setRoles((d as { roles?: Role[] }).roles ?? [])).catch(() => {})
  }, [api])
  useEffect(load, [load])
  const held = mine ?? []
  // A role may be given only by someone holding all it holds (owners alone make owners).
  const givable = (r: Role) => r.capabilities.every((c) => held.includes(c))
  const roleName = (id: string) => (roles ?? []).find((r) => r.id === id)?.name ?? id
  const setRole = async (email: string, role: string) => {
    const r = await api('/users', { method: 'POST', body: JSON.stringify({ email, role }) })
    setErr(r.ok ? '' : await errorOf(r)); load()
  }
  const remove = async (email: string) => {
    const r = await api('/users', { method: 'DELETE', body: JSON.stringify({ email }) })
    setErr(r.ok ? '' : await errorOf(r)); load()
  }
  const add = async () => {
    const r = await api('/users', { method: 'POST', body: JSON.stringify(adding) })
    if (!r.ok) { setErr(await errorOf(r)); return }
    setErr(''); setAdding({ email: '', name: '', role: 'member' }); load()
  }
  const canPeople = held.includes('org.people')
  return (
    <div className="sa-stack sa-stack--4">
      {err && <Notice state="critical">{err}</Notice>}
      {canPeople && (
        <Section icon="lucide:user-plus" title="Add a person" subtitle="People are added to the organisation once, then given projects">
          <Form onSubmit={() => void add()} actions={<button className="sa-btn sa-btn--primary" disabled={!adding.email}>Add</button>}>
            <Field label="Email"><input id="person-email" className="sa-input" type="email" required value={adding.email} onChange={(e) => setAdding({ ...adding, email: e.target.value })} placeholder="name@company.com" /></Field>
            <Field label="Name"><input id="person-name" className="sa-input" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} /></Field>
            <Field label="Role" help={(roles ?? []).find((r) => r.id === adding.role)?.capabilities.map((c) => ORG_CAPABILITIES[c as OrgCapability] ?? c).join(' · ') || 'Works in the projects they are given; nothing organisation-wide.'}>
              <select id="person-role" className="sa-input" value={adding.role} onChange={(e) => setAdding({ ...adding, role: e.target.value })}>
                {(roles ?? []).filter(givable).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </Field>
          </Form>
        </Section>
      )}
      <Section icon="lucide:users" title="People" note={`${(people ?? []).length}`} subtitle="Their role in the organisation; owners and admins administer every project">
        <RecordList rows={people} keyOf={(p) => p.id} empty="No one yet."
          columns={[
            { key: 'email', label: 'Email', render: (p) => <span title={p.email}>{p.email}</span> },
            { key: 'name', label: 'Name', render: (p) => p.name || <span className="sa-muted">—</span> },
            { key: 'role', label: 'Role', render: (p) => canPeople && givable((roles ?? []).find((r) => r.id === p.role) ?? { id: p.role, name: p.role, capabilities: p.capabilities, builtin: false })
              ? <select id={`role-${p.id}`} className="sa-input sa-input--compact" value={p.role} onChange={(e) => void setRole(p.email, e.target.value)}>
                  {(roles ?? []).filter((r) => givable(r) || r.id === p.role).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              : <Status state={p.role === 'owner' ? 'ok' : p.role === 'admin' ? 'running' : 'neutral'}>{roleName(p.role)}</Status> },
            { key: 'can', label: 'May', wrap: true, render: (p) => <span className="sa-muted">{p.capabilities.length ? p.capabilities.join(', ') : 'their projects only'}</span> },
            { key: 'x', label: '', align: 'end', render: (p) => canPeople ? <button className="sa-btn sa-btn--link" onClick={() => void remove(p.email)}>Remove</button> : null },
          ]} />
      </Section>
      <RolesSection api={api} roles={roles} held={held} onChange={load} />
      {held.includes('org.audit') && <OrgRecord api={api} />}
    </div>
  )
}

/** The organisation's roles: built-in ones as they are, custom ones an owner defines from the capabilities. */
function RolesSection({ api, roles, held, onChange }: { api: Api; roles: Role[] | null; held: string[]; onChange: () => void }) {
  const [draft, setDraft] = useState<{ name: string; capabilities: string[] }>({ name: '', capabilities: [] })
  const [err, setErr] = useState('')
  const owner = held.includes('org.roles')
  const save = async () => {
    const r = await api('/roles', { method: 'POST', body: JSON.stringify(draft) })
    if (!r.ok) { setErr(await errorOf(r)); return }
    setErr(''); setDraft({ name: '', capabilities: [] }); onChange()
  }
  const drop = async (id: string) => { const r = await api('/roles', { method: 'DELETE', body: JSON.stringify({ id }) }); setErr(r.ok ? '' : await errorOf(r)); onChange() }
  return (
    <Section icon="lucide:shield" title="Roles" subtitle="What each role may do across the organisation; inside a project, its own roles apply">
      <RecordList rows={roles} keyOf={(r) => r.id}
        columns={[
          { key: 'name', label: 'Role', render: (r) => <strong>{r.name}</strong> },
          { key: 'kind', label: 'Kind', render: (r) => <span className="sa-muted">{r.builtin ? 'built in' : 'custom'}</span> },
          { key: 'caps', label: 'May', wrap: true, render: (r) => r.capabilities.length ? r.capabilities.map((c) => ORG_CAPABILITIES[c as OrgCapability] ?? c).join(' · ') : <span className="sa-muted">Works in the projects they are given</span> },
          { key: 'x', label: '', align: 'end', render: (r) => owner && !r.builtin ? <button className="sa-btn sa-btn--link" onClick={() => void drop(r.id)}>Remove</button> : null },
        ]} />
      {owner && (
        <Form onSubmit={() => void save()} error={err} actions={<button className="sa-btn sa-btn--primary" disabled={!draft.name.trim()}>Save the role</button>}>
          <Field label="A new role" help="For example a data engineer, who queries and writes the warehouse but administers nothing.">
            <input id="role-name" className="sa-input" placeholder="Data engineer" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Choices label="It may">
            {(Object.keys(ORG_CAPABILITIES) as OrgCapability[]).filter((c) => c !== 'org.roles').map((c) => (
              <label key={c}><input type="checkbox" id={`cap-${c}`} checked={draft.capabilities.includes(c)} onChange={(e) => setDraft({ ...draft, capabilities: e.target.checked ? [...draft.capabilities, c] : draft.capabilities.filter((x) => x !== c) })} />
                <span>{ORG_CAPABILITIES[c]} <span className="sa-muted">({c})</span></span></label>
            ))}
          </Choices>
        </Form>
      )}
    </Section>
  )
}

/** Who changed who may do what (people, roles, keys) — newest first. */
function OrgRecord({ api }: { api: Api }) {
  const [events, setEvents] = useState<{ seq: number; at: string; op: string; target: string; by: string; detail: string }[] | null>(null)
  useEffect(() => { api('/audit').then((r) => (r.ok ? r.json() : { events: [] })).then((d) => setEvents((d as any).events ?? [])).catch(() => {}) }, [api])
  const said: Record<string, string> = { 'person.add': 'added', 'person.role': 'role changed', 'person.remove': 'removed', 'role.set': 'role saved', 'role.remove': 'role removed', 'key.create': 'key made', 'key.revoke': 'key revoked' }
  return (
    <Section icon="lucide:history" title="What was changed" subtitle="People, roles and keys — newest first">
      <RecordList rows={events} keyOf={(e) => String(e.seq)} empty="Nothing yet."
        columns={[
          { key: 'at', label: 'When', render: (e) => <span title={new Date(e.at).toLocaleString()}>{day(e.at)}</span> },
          { key: 'op', label: 'What', render: (e) => said[e.op] ?? e.op },
          { key: 'target', label: 'Who or what', render: (e) => e.target },
          { key: 'detail', label: 'Detail', wrap: true, render: (e) => { try { const d = JSON.parse(e.detail || '{}'); return <span className="sa-muted">{d.from ? `${d.from} → ${d.to}` : d.role ?? (d.scopes ? d.scopes.join(', ') : d.name ?? '')}</span> } catch { return null } } },
          { key: 'by', label: 'By', render: (e) => e.by },
        ]} />
    </Section>
  )
}

/** Organisation keys: an agent working for the organisation (the warehouse), as its maker, within the scopes given. */
export function OrgKeysPanel({ api }: { api: Api }) {
  const mine = useMine(api)
  const [keys, setKeys] = useState<Key[] | null>(null)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>([])
  const [made, setMade] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const load = useCallback(() => { api('/keys').then((r) => (r.ok ? r.json() : { keys: [] })).then((d) => setKeys((d as { keys?: Key[] }).keys ?? [])).catch(() => {}) }, [api])
  const held = mine ?? []
  useEffect(() => { if (held.includes('org.keys')) load() }, [load, mine])   // eslint-disable-line react-hooks/exhaustive-deps
  if (!mine || !held.includes('org.keys')) return null
  const create = async () => {
    const r = await api('/keys', { method: 'POST', body: JSON.stringify({ name: name.trim(), scopes, expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString() }) })
    if (!r.ok) { setErr(await errorOf(r)); return }
    setErr(''); setMade(((await r.json()) as { key: string }).key); setName(''); setScopes([]); load()
  }
  const revoke = async (id: string) => { const r = await api(`/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }); setErr(r.ok ? '' : await errorOf(r)); load() }
  return (
    <Section icon="lucide:key-round" title="Organisation keys" subtitle="For an agent or script working with the warehouse: sacli warehouse …">
      {made && <Notice state="attention" action={<button className="sa-btn sa-btn--primary" onClick={() => { void navigator.clipboard.writeText(made); setMade(null) }}><Icon icon="lucide:copy" className="sa-btn__icon" />Copy and close</button>}>
        <div className="sa-stack"><strong>Copy the key now — it will not be shown again.</strong><Code>{made}</Code></div></Notice>}
      <Form onSubmit={() => void create()} error={err} actions={<button className="sa-btn sa-btn--primary" disabled={!name.trim() || !scopes.length}>Make key</button>}>
        <Field label="What it is for" help={<>Then: <Code>printf %s "$KEY" | sacli login --profile warehouse</Code>. It expires in a year; it holds no more than you hold, now.</>}>
          <input id="org-key-name" className="sa-input" placeholder="nightly loader" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Choices label="It may">
          {ORG_KEY_SCOPES.map((s) => (
            <label key={s} data-disabled={!held.includes(s)} title={held.includes(s) ? undefined : 'Your role does not hold this'}>
              <input type="checkbox" id={`org-key-${s}`} disabled={!held.includes(s)} checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} />
              <span>{ORG_CAPABILITIES[s]} <span className="sa-muted">({s})</span></span>
            </label>
          ))}
        </Choices>
      </Form>
      <RecordList rows={keys} keyOf={(k) => k.id} empty="No organisation keys yet."
        columns={[
          { key: 'name', label: 'Name', render: (k) => <strong>{k.name}</strong> },
          { key: 'scopes', label: 'May', render: (k) => k.scopes.join(', ') },
          { key: 'by', label: 'Made by', render: (k) => k.created_by },
          { key: 'made', label: 'Made', render: (k) => day(k.created_at) },
          { key: 'used', label: 'Last used', render: (k) => <span className="sa-muted">{day(k.last_used_at)}</span> },
          { key: 'state', label: '', render: (k) => k.revoked_at ? <Status state="critical">Revoked</Status> : <span className="sa-muted">until {day(k.expires_at)}</span> },
          { key: 'x', label: '', align: 'end', render: (k) => k.revoked_at ? null : <button className="sa-btn sa-btn--link" onClick={() => void revoke(k.id)}>Revoke</button> },
        ]} />
    </Section>
  )
}

// ── A project: who has access, as what — the project's roles, built-in and its own ──────────────────────────────────

type Access = { email: string; role_id: string; role_name?: string; source: string; capabilities: string[] }
const said = (c: string) => PROJECT_CAPABILITIES[c as ProjectCapability] ?? c

/** Who may work in a project and as what. People come from the organisation; here they get one of the project's roles. */
export function ProjectAccessPanel({ projectId, api, orgApi }: { projectId: string; api: Api; orgApi: Api | null }) {
  const [access, setAccess] = useState<Access[] | null>(null)
  const [roles, setRoles] = useState<Role[] | null>(null)
  const [people, setPeople] = useState<{ email: string; name?: string }[]>([])
  const [held, setHeld] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [pick, setPick] = useState({ email: '', roleId: 'member' })
  const load = useCallback(() => {
    api(`/projects/${projectId}/access`).then((r) => (r.ok ? r.json() : { access: [] })).then((d) => setAccess((d as any).access ?? [])).catch(() => {})
    api(`/projects/${projectId}/roles`).then((r) => (r.ok ? r.json() : { roles: [] })).then((d) => setRoles((d as any).roles ?? [])).catch(() => {})
    api(`/projects/${projectId}/me`).then((r) => (r.ok ? r.json() : null)).then((d) => setHeld((d as any)?.capabilities ?? [])).catch(() => {})
    orgApi?.('/users').then((r) => (r.ok ? r.json() : [])).then((d) => setPeople(Array.isArray(d) ? d : [])).catch(() => {})
  }, [api, orgApi, projectId])
  useEffect(load, [load])
  const givable = (r: Role) => r.capabilities.every((c) => held.includes(c))
  const assigned = new Set((access ?? []).map((a) => a.email.toLowerCase()))
  const available = people.filter((u) => !assigned.has(u.email.toLowerCase()))
  const email = available.some((u) => u.email === pick.email) ? pick.email : (available[0]?.email ?? '')
  const give = async (who: string, roleId: string) => {
    const r = await (orgApi ?? api)('/assignments', { method: 'POST', body: JSON.stringify({ projectId, email: who, roleId }) })
    setErr(r.ok ? '' : await errorOf(r)); load()
  }
  const take = async (who: string) => {
    const r = await (orgApi ?? api)('/assignments', { method: 'DELETE', body: JSON.stringify({ projectId, email: who }) })
    setErr(r.ok ? '' : await errorOf(r)); load()
  }
  const may = held.includes('project.people')
  const roleOf = (id: string) => (roles ?? []).find((r) => r.id === id)
  return (
    <div className="sa-stack sa-stack--4">
      {err && <Notice state="critical">{err}</Notice>}
      {may && (
        <Section icon="lucide:user-plus" title="Give access" subtitle="People come from the organisation; here they get a role in this project">
          <Form onSubmit={() => void give(email, pick.roleId)} actions={<button className="sa-btn sa-btn--primary" disabled={!email}>Give access</button>}>
            <Field label="Person">
              <select id="pa-person" className="sa-input" value={email} onChange={(e) => setPick({ ...pick, email: e.target.value })} disabled={!available.length}>
                {available.length ? available.map((u) => <option key={u.email} value={u.email}>{u.email}{u.name ? ` — ${u.name}` : ''}</option>) : <option value="">Everyone in the organisation has access already</option>}
              </select>
            </Field>
            <Field label="Role" help={roleOf(pick.roleId)?.capabilities.map(said).join(' · ')}>
              <select id="pa-role" className="sa-input" value={pick.roleId} onChange={(e) => setPick({ ...pick, roleId: e.target.value })}>
                {(roles ?? []).filter(givable).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </Field>
          </Form>
        </Section>
      )}
      <Section icon="lucide:users" title="Who has access" note={`${(access ?? []).length}`} subtitle="The organisation's owners and admins administer every project">
        <RecordList rows={access} keyOf={(a) => a.email} empty="Nobody has been given access yet."
          columns={[
            { key: 'email', label: 'Person', render: (a) => <span title={a.email}>{a.email}</span> },
            { key: 'role', label: 'Role', render: (a) => a.source === 'org-admin'
              ? <span className="sa-row sa-row--tight"><Status state="running">Admin</Status><span className="sa-muted">from the organisation</span></span>
              : may && givable(roleOf(a.role_id) ?? { id: a.role_id, name: a.role_id, capabilities: a.capabilities, builtin: false })
                ? <select id={`pa-${a.email}`} className="sa-input sa-input--compact" value={a.role_id} onChange={(e) => void give(a.email, e.target.value)}>{(roles ?? []).filter((r) => givable(r) || r.id === a.role_id).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
                : <Status state="neutral">{roleOf(a.role_id)?.name ?? a.role_id}</Status> },
            { key: 'how', label: 'Came in', render: (a) => <span className="sa-muted">{a.source === 'domain' ? 'by their email domain' : a.source === 'org-admin' ? 'organisation' : 'given'}</span> },
            { key: 'x', label: '', align: 'end', render: (a) => a.source === 'org-admin' || !may ? null : <button className="sa-btn sa-btn--link" onClick={() => void take(a.email)}>Remove</button> },
          ]} />
      </Section>
      <ProjectRoles projectId={projectId} api={api} roles={roles} held={held} onChange={load} />
    </div>
  )
}

/** The project's roles in plain words, and making one of its own (no more than the maker holds). */
function ProjectRoles({ projectId, api, roles, held, onChange }: { projectId: string; api: Api; roles: Role[] | null; held: string[]; onChange: () => void }) {
  const [draft, setDraft] = useState<{ name: string; capabilities: string[] }>({ name: '', capabilities: ['project.view'] })
  const [err, setErr] = useState('')
  const may = held.includes('project.people')
  const save = async () => {
    const r = await api(`/projects/${projectId}/roles`, { method: 'POST', body: JSON.stringify(draft) })
    if (!r.ok) { setErr(await errorOf(r)); return }
    setErr(''); setDraft({ name: '', capabilities: ['project.view'] }); onChange()
  }
  const drop = async (id: string) => { const r = await api(`/projects/${projectId}/roles`, { method: 'DELETE', body: JSON.stringify({ id }) }); setErr(r.ok ? '' : await errorOf(r)); onChange() }
  return (
    <Section icon="lucide:shield" title="Roles" subtitle="What each role may do in this project — the same person can hold a different role elsewhere">
      <RecordList rows={roles} keyOf={(r) => r.id}
        columns={[
          { key: 'name', label: 'Role', render: (r) => <strong>{r.name}</strong> },
          { key: 'kind', label: 'Kind', render: (r) => <span className="sa-muted">{r.builtin ? 'built in' : "this project's"}</span> },
          { key: 'caps', label: 'May', wrap: true, render: (r) => r.capabilities.map(said).join(' · ') },
          { key: 'x', label: '', align: 'end', render: (r) => may && !r.builtin ? <button className="sa-btn sa-btn--link" onClick={() => void drop(r.id)}>Remove</button> : null },
        ]} />
      {may && (
        <Form onSubmit={() => void save()} error={err} actions={<button className="sa-btn sa-btn--primary" disabled={!draft.name.trim()}>Save the role</button>}>
          <Field label="A role of this project's own" help="For example an analyst, who asks and reads the warehouse but approves nothing.">
            <input id="pr-name" className="sa-input" placeholder="Analyst" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Choices label="It may">
            {(Object.keys(PROJECT_CAPABILITIES) as ProjectCapability[]).map((c) => (
              <label key={c} data-disabled={!held.includes(c)} title={held.includes(c) ? undefined : 'You do not hold this, so you cannot give it'}>
                <input type="checkbox" id={`pcap-${c}`} disabled={!held.includes(c)} checked={draft.capabilities.includes(c)} onChange={(e) => setDraft({ ...draft, capabilities: e.target.checked ? [...draft.capabilities, c] : draft.capabilities.filter((x) => x !== c) })} />
                <span>{PROJECT_CAPABILITIES[c]} <span className="sa-muted">({c})</span></span>
              </label>
            ))}
          </Choices>
        </Form>
      )}
    </Section>
  )
}
