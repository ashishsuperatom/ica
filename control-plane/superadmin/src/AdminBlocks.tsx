// THE ADMIN'S OWN BLOCKS — what needs a decision, and deciding it, the same way as everywhere: each item of Attention
// opens its step (an approval, a suggestion), with its context and its paths; what is decided is a receipt. Drawn only
// with the semantic components (@superatom/ui); no CSS of their own.

import { createContext, useContext, useEffect, useState } from 'react'
import { AttentionList, Receipt, ActionBar, Form, Field, Empty, Section, Status, notify, useThread, type Attention, type Registry } from '@superatom/ui'
import { useProjectHub } from './hub'

type Api = (path: string, init?: RequestInit) => Promise<Response>
export interface AdminEnv { api: Api; token: string | null; superadmin: boolean; openScreen: (path: string) => void }
export const AdminContext = createContext<AdminEnv | null>(null)
const useEnv = () => { const e = useContext(AdminContext); if (!e) throw new Error('admin blocks need their environment'); return e }

type Item = Attention & { kind: string; projectId?: string; session?: string; artifact?: string; suggestion?: number; name?: string; path?: string }

/** Attention: what awaits a decision in the scope — a project's, or the platform's. */
function AttentionBlock() {
  const env = useEnv()
  const { props, open } = useThread()
  const projectId = props.projectId ? String(props.projectId) : null
  const [items, setItems] = useState<Item[] | null>(null)
  useEffect(() => {
    let live = true
    void (async () => {
      const out: Item[] = []
      if (projectId) {
        const r = await env.api(`/projects/${projectId}/attention`).then((x) => x.ok ? x.json() : { items: [] }).catch(() => ({ items: [] }))
        for (const i of (r as any).items ?? []) out.push({ ...i, projectId, where: undefined })
      } else if (env.superadmin) {
        const c: any = await env.api('/credentials').then((x) => x.ok ? x.json() : null).catch(() => null)
        for (const e of c?.expiring ?? []) out.push({ id: `cred:${e.id}`, kind: 'credential', state: e.expiresAt && e.expiresAt < Date.now() ? 'critical' : 'attention', title: `Credential ${e.id} ${e.expiresAt && e.expiresAt < Date.now() ? 'has expired' : 'expires soon'}`, detail: e.provider, path: '/credentials', action: 'Open credentials' })
        const p: any = await env.api('/profiles').then((x) => x.ok ? x.json() : null).catch(() => null)
        for (const pr of p?.projects ?? []) if (!pr.running) out.push({ id: `offline:${pr.projectId}`, kind: 'engine', state: 'attention', title: `${pr.project}: its engine has not reported`, where: pr.org, path: `/o/${pr.orgId}/p/${pr.projectId}`, action: 'Open the project' })
      }
      if (live) setItems(out)
    })()
    return () => { live = false }
  }, [env, projectId])
  if (!items) return <Empty>Reading what needs a decision…</Empty>
  return (
    <AttentionList items={items} empty={projectId ? 'Nothing in this project needs a decision.' : 'Nothing on the platform needs a decision.'}
      onOpen={(i) => {
        if (i.kind === 'approval') open('approval', { projectId: i.projectId, session: i.session, artifact: i.artifact, title: i.title }, i.title)
        else if (i.kind === 'suggestion') open('suggestion', { projectId: i.projectId, id: i.suggestion, name: i.name, title: i.title, detail: i.detail }, i.title)
        else if (i.path) env.openScreen(i.path)
        else if (i.projectId) env.openScreen(`/pro/${i.projectId}`)
      }} />
  )
}

/** An approval: the decision as recorded — what, the options, why, what it rested on — then approve or reject. */
function ApprovalBlock() {
  const env = useEnv()
  const { props, update } = useThread()
  const hub = useProjectHub(String(props.projectId), env.token)
  const [art, setArt] = useState<any>(null)
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const decided = props.decided ? String(props.decided) : null
  useEffect(() => {
    if (hub.status !== 'live') return
    void hub.call({ t: 'artifact:get', session: props.session, id: props.artifact }).then((m) => setArt(m?.versions?.[m.versions.length - 1] ?? null)).catch((e) => setErr(String(e?.message ?? e)))
  }, [hub.status])   // eslint-disable-line react-hooks/exhaustive-deps
  const decide = async (status: 'approved' | 'rejected') => {
    setErr('')
    const m = await hub.call({ t: 'artifact:decide', session: props.session, id: props.artifact, status, note }).catch((e) => ({ reason: String(e?.message ?? e) }))
    if (m?.t !== 'artifact:decided') { setErr(m?.reason ?? 'It was not decided.'); return }
    update({ decided: status, note }); notify(status === 'approved' ? 'Approved' : 'Rejected', 'note')
  }
  if (!art) return err ? <Empty icon="lucide:triangle-alert">{err}</Empty> : <Empty>Reading the decision…</Empty>
  const b = art.body ?? {}
  return (<>
    <Receipt items={[
      ['Decision', b.decision ?? art.title], ['Why', b.reasoning ?? '—'],
      ['Options weighed', (b.options ?? []).map((o: any) => o.label).join(' · ') || '—'],
      ['Rested on', b.restsOn ? Object.entries(b.restsOn.world ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ') || 'the step it was made in' : '—'],
      ['Recorded by', String(art.by).replace(/^(email|user):/, '')], ['Status', <Status key="s" state={decided === 'approved' ? 'ok' : decided === 'rejected' ? 'critical' : 'attention'}>{decided ?? art.status}</Status>],
    ]} />
    <Form onSubmit={() => void decide('approved')} locked={!!decided} error={err}
      actions={<><button type="button" className="sa-btn" onClick={() => void decide('rejected')}>Reject</button><button className="sa-btn sa-btn--primary">Approve</button></>}>
      <Field label="Note (kept with the decision)"><textarea id="ap-note" className="sa-input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Form>
  </>)
}

/** A suggestion: a change to a node, or publishing one — approve or reject it (the owner or an admin decides). */
function SuggestionBlock() {
  const env = useEnv()
  const { props, update } = useThread()
  const hub = useProjectHub(String(props.projectId), env.token)
  const [err, setErr] = useState('')
  const decided = props.decided ? String(props.decided) : null
  const decide = async (verdict: 'approved' | 'rejected') => {
    setErr('')
    const m = await hub.call({ t: 'graph:decide', id: Number(props.id), verdict }).catch((e) => ({ reason: String(e?.message ?? e) }))
    if (m?.t !== 'graph:reply') { setErr(m?.reason ?? 'It was not decided.'); return }
    update({ decided: verdict }); notify(verdict === 'approved' ? 'Approved' : 'Rejected', 'note')
  }
  return (<>
    <Receipt items={[['Suggestion', String(props.title)], ['From', String(props.detail ?? '—')], ['Node', String(props.name)], ['Status', <Status key="s" state={decided === 'approved' ? 'ok' : decided === 'rejected' ? 'critical' : 'attention'}>{decided ?? 'awaiting a decision'}</Status>]]} />
    {err && <Empty icon="lucide:triangle-alert">{err}</Empty>}
    {!decided && <ActionBar>
      <button className="sa-btn" disabled={hub.status !== 'live'} onClick={() => void decide('rejected')}>Reject</button>
      <button className="sa-btn sa-btn--primary" disabled={hub.status !== 'live'} onClick={() => void decide('approved')}>Approve</button>
    </ActionBar>}
  </>)
}

/** A purpose: its places, each opening the console's screen for it in a new block. */
function PurposeBlock() {
  const env = useEnv()
  const { props } = useThread()
  const places = (props.places as { label: string; path: string; says: string }[]) ?? []
  return (
    <Section icon="lucide:compass" title={String(props.title)} subtitle={String(props.says ?? '')}>
      <div className="sa-sub-grid">
        {places.map((p) => <button key={p.path} className="sa-sub-card" onClick={() => env.openScreen(p.path)}><span className="sa-sub-card__title">{p.label}</span><span className="sa-sub-card__text">{p.says}</span></button>)}
      </div>
    </Section>
  )
}

export const ADMIN_OWN_BLOCKS: Registry = {
  attention: { label: 'Attention', icon: 'lucide:bell', accent: 'var(--warn)', title: (p) => (p.projectId ? 'What needs a decision in this project' : 'What needs a decision'), render: () => <AttentionBlock /> },
  approval: { label: 'Approval', icon: 'lucide:gavel', accent: 'var(--warn)', title: (p) => String(p.title ?? 'A decision to approve'), subtitle: (p) => (p.decided ? `Decided: ${String(p.decided)}` : 'Approve or reject; kept in the audit history'), render: () => <ApprovalBlock /> },
  suggestion: { label: 'Suggestion', icon: 'lucide:git-pull-request', accent: 'var(--warn)', title: (p) => String(p.title ?? 'A suggestion'), subtitle: (p) => (p.decided ? `Decided: ${String(p.decided)}` : 'The owner or an admin decides'), render: () => <SuggestionBlock /> },
  purpose: { label: 'Purpose', icon: 'lucide:compass', accent: 'var(--primary)', title: (p) => String(p.title), render: () => <PurposeBlock /> },
}
