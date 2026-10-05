// ── Groups, for one project ─────────────────────────────────────────────────────────────────────────────────────────
// Who is in which group (scope group:<name>): people by email, agent keys by id. A group decides what its members see
// (agents, programs, knowledge scoped to it), which data access policies apply to them, and can carry a credit budget.
// Drawn only with the semantic components (@superatom/ui); no CSS of its own.
import { useCallback, useEffect, useState } from 'react'
import { Section, Form, Field, RecordList, Notice, Empty, Code } from '@superatom/ui'

type Api = (p: string, i?: RequestInit) => Promise<Response>
type Group = { name: string; description: string | null; members: string[] }

export function GroupsPanel({ api, projectId }: { api: Api; projectId: string }) {
  const [groups, setGroups] = useState<Group[] | null>(null)
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
    <div className="sa-stack sa-stack--4">
      {err && <Notice state="critical">{err}</Notice>}
      <Section icon="lucide:users" title="Groups" subtitle="What members see, which data policies apply, and a credit budget">
        <Form onSubmit={() => { if (name.trim()) void create() }}
          actions={<button className="sa-btn sa-btn--primary" disabled={!name.trim()}>Create group</button>}>
          <Field label="Name" help="A group decides what its members see (agents, programs and knowledge scoped to it), which data access policies apply to them, and can carry a credit budget.">
            <input id="group-name" className="sa-input" placeholder="finance" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </Form>
      </Section>
      {!(groups ?? []).length && <Empty icon="lucide:users">No groups yet. Each group you create appears here with its members.</Empty>}
      {(groups ?? []).map((g) => (
        <Section key={g.name} icon="lucide:users-round" title={g.name} note={`${g.members.length} member${g.members.length === 1 ? '' : 's'}`}>
          <RecordList keyOf={(m) => m.id} rows={g.members.map((id) => ({ id }))} empty="No members yet."
            columns={[
              { key: 'id', label: 'Member', render: (m) => <Code>{m.id.replace(/^email:/, '')}</Code> },
              { key: 'remove', label: '', align: 'end', render: (m) => <button type="button" className="sa-btn sa-btn--link" onClick={() => void remove(g.name, m.id)}>Remove</button> },
            ]} />
          <Form onSubmit={() => { if ((member[g.name] ?? '').trim()) void add(g.name) }}
            actions={<button className="sa-btn sa-btn--primary" disabled={!(member[g.name] ?? '').trim()}>Add member</button>}>
            <Field label="Add a member" help="A person by email, or an agent key by its id.">
              <input id={`group-add-${g.name}`} className="sa-input" placeholder="a@company.com or agent:key_…" value={member[g.name] ?? ''} onChange={(e) => setMember({ ...member, [g.name]: e.target.value })} />
            </Field>
          </Form>
        </Section>
      ))}
    </div>
  )
}
