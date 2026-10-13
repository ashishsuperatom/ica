// WHETHER AN ORGANISATION'S ENGINES MAY RUN ON FLY, in the console: allowed or not, how many machines at most, and
// whether a new project gets one when it is made — set by the platform's administrators only (a machine there costs
// money); the organisation's own console shows it. Drawn only with the semantic components (@superatom/ui).

import { useCallback, useEffect, useState } from 'react'
import { Section, Form, Field, Notice, Receipt, Status, day } from '@superatom/ui'

type Api = (path: string, init?: RequestInit) => Promise<Response>
type Fly = { allowed: boolean; machines: number; onCreate: boolean; setBy: string | null; setAt: string | null; used: number; projects: string[] }

export function FlyAllowancePanel({ api, editable }: { api: Api; editable: boolean }) {
  const [fly, setFly] = useState<Fly | null>(null)
  const [draft, setDraft] = useState({ allowed: false, machines: '0', onCreate: false })
  const [err, setErr] = useState(''), [ok, setOk] = useState(false), [failed, setFailed] = useState(false)
  const load = useCallback(() => {
    setFailed(false)
    api('/fly').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: Fly) => { setFly(j); setDraft({ allowed: j.allowed, machines: String(j.machines), onCreate: j.onCreate }) })
      .catch((e) => { console.warn('[fly] allowance not read', e); setFailed(true) })
  }, [api])
  useEffect(load, [load])
  const save = async () => {
    setOk(false)
    const r = await api('/fly', { method: 'PUT', body: JSON.stringify({ allowed: draft.allowed, machines: Number(draft.machines), onCreate: draft.onCreate }) })
    const j: any = await r.json().catch(() => ({}))
    if (!r.ok) { setErr(j.error ?? `Not saved (${r.status})`); return }
    setErr(''); setOk(true); setFly(j)
  }
  const subtitle = fly?.setAt ? `Last changed ${day(fly.setAt)} by ${fly.setBy}` : 'Machines on Fly cost money: the platform decides'
  return (
    <Section icon="lucide:cloud" title="Engines on Fly" subtitle={subtitle}>
      {failed && <div className="sa-section__body"><Notice state="critical">Not read. <button className="sa-btn sa-btn--link" onClick={load}>Try again</button></Notice></div>}
      {fly && !editable && <Receipt items={[
        ['Allowed', fly.allowed ? 'Yes' : 'No'],
        ['Machines', fly.allowed ? `${fly.used} of ${fly.machines} in use` : '—'],
        ['New projects', fly.onCreate ? 'Get their engine on Fly when made' : 'Placed on Fly one by one'],
      ]} />}
      {fly && editable && (
        <Form onSubmit={() => void save()} error={err} actions={<>{ok && <Status state="ok">Saved</Status>}<button className="sa-btn sa-btn--primary">Save</button></>}>
          <Field label="Its engines may run on Fly">
            <select id="fly-allowed" className="sa-input" value={draft.allowed ? 'yes' : 'no'} onChange={(e) => setDraft({ ...draft, allowed: e.target.value === 'yes', onCreate: e.target.value === 'yes' && draft.onCreate })}>
              <option value="no">No</option><option value="yes">Yes</option>
            </select>
          </Field>
          <Field label={`Machines at most (${fly.used} in use now)`}><input id="fly-machines" className="sa-input" type="number" min={0} max={100} value={draft.machines} disabled={!draft.allowed} onChange={(e) => setDraft({ ...draft, machines: e.target.value })} /></Field>
          <Field label="A new project">
            <select id="fly-on-create" className="sa-input" value={draft.onCreate ? 'yes' : 'no'} disabled={!draft.allowed} onChange={(e) => setDraft({ ...draft, onCreate: e.target.value === 'yes' })}>
              <option value="no">Is placed on Fly by its administrator</option><option value="yes">Gets its engine on Fly when made</option>
            </select>
          </Field>
        </Form>
      )}
    </Section>
  )
}
