// HOW CONVERSATIONS WORK in a project, set by the people who run it: whether going back to an earlier step and taking
// another path keeps both paths (a branch bar between them) or simply continues from there (what was below no longer
// shown — the default, simplest to follow). Drawn only with the semantic components (@superatom/ui).

import { useCallback, useEffect, useState } from 'react'
import { Section, Notice } from '@superatom/ui'

type Api = (path: string, init?: RequestInit) => Promise<Response>

export function ConversationSettings({ api, projectId }: { api: Api; projectId: string }) {
  const [branches, setBranches] = useState<boolean | null>(null)
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const load = useCallback(() => {
    api(`/projects/${projectId}/conversation-settings`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { branches?: boolean }) => { setBranches(j.branches === true); setErr('') })
      .catch((e) => { console.warn('[conversations] settings not read', e); setErr('The setting could not be read.') })
  }, [api, projectId])
  useEffect(load, [load])
  const save = async (on: boolean) => {
    setSaving(true)
    const r = await api(`/projects/${projectId}/conversation-settings`, { method: 'PUT', body: JSON.stringify({ branches: on }) })
    setSaving(false)
    if (!r.ok) { setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Not saved (${r.status})`); return }
    setBranches(on); setErr('')
  }
  return (
    <Section icon="lucide:git-branch" title="Conversations" subtitle="When someone goes back to an earlier step and takes another path">
      <div className="sa-section__body sa-stack">
        {err && <Notice state="critical">{err} <button className="sa-btn sa-btn--link" onClick={load}>Try again</button></Notice>}
        <label className="sa-row sa-row--tight">
          <input type="checkbox" checked={branches === true} disabled={branches === null || saving} onChange={(e) => void save(e.target.checked)} />
          <span>Keep both paths, with a bar to switch between them</span>
        </label>
        <p className="sa-muted">Off: the conversation continues from that step and what was below it is no longer shown — simplest to follow. Changes reach open tabs at once.</p>
      </div>
    </Section>
  )
}
