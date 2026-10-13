// A PROJECT'S DEVELOPMENT ENVIRONMENTS, in the console: everyone's (sacli dev — each seen only by its owner), whether it is
// in use, what it changes, when it was last used; an administrator can delete one (its builds are let go on the engine).
// Drawn only with the semantic components (@superatom/ui).

import { useCallback, useEffect, useState } from 'react'
import { Section, RecordList, Status, Notice, Code, day } from '@superatom/ui'

type Api = (path: string, init?: RequestInit) => Promise<Response>
interface DevEnv { id: string; name: string; owner: string; status: 'attached' | 'detached' | 'deleted'; names: string[]; created_at: string; last_used: string }

export function DevEnvironments({ api, projectId, canDelete }: { api: Api; projectId: string; canDelete: boolean }) {
  const [envs, setEnvs] = useState<DevEnv[] | null>(null)
  const [err, setErr] = useState('')
  const load = useCallback(() => {
    api(`/projects/${projectId}/dev-envs`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { envs?: DevEnv[] }) => { setEnvs(Array.isArray(j.envs) ? j.envs : []); setErr('') })
      .catch((e) => { console.warn('[dev] environments not read', e); setErr('The environments could not be read.') })
  }, [api, projectId])
  useEffect(load, [load])
  const remove = async (e: DevEnv) => {
    if (!window.confirm(`Delete ${e.owner}'s environment “${e.name}”? What it builds is let go; their clone is not touched.`)) return
    const r = await api(`/projects/${projectId}/dev-envs?id=${encodeURIComponent(e.id)}`, { method: 'DELETE' })
    if (!r.ok) { setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Not deleted (${r.status})`); return }
    load()
  }
  return (
    <Section icon="lucide:flask-conical" title="Development environments" subtitle="sacli dev: each person’s changes, tried on this project’s engine and seen only by them" note={envs ? `${envs.length}` : undefined}>
      {err && <div className="sa-section__body"><Notice state="critical">{err} <button className="sa-btn sa-btn--link" onClick={load}>Try again</button></Notice></div>}
      <RecordList rows={envs ?? []} loading={envs === null && !err} keyOf={(e) => e.id} empty="Nobody is developing in this project right now." columns={[
        { key: 'name', label: 'Environment', render: (e) => <Code>{e.name}</Code> },
        { key: 'owner', label: 'Owner' },
        { key: 'status', label: 'State', render: (e) => <Status state={e.status === 'attached' ? 'ok' : 'neutral'}>{e.status === 'attached' ? 'in use' : 'detached'}</Status> },
        { key: 'names', label: 'Changes', render: (e) => (e.names.length ? e.names.join(', ') : '—') },
        { key: 'last_used', label: 'Last used', render: (e) => day(e.last_used) },
        ...(canDelete ? [{ key: 'act', label: '', align: 'end' as const, render: (e: DevEnv) => <button className="sa-btn" onClick={() => void remove(e)}>Delete</button> }] : []),
      ]} />
    </Section>
  )
}
