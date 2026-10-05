// AN ORGANISATION'S BILLING, in the console: who it is billed as (name, email, address, tax number), how it pays, and
// its credits. Card details are never held by Superatom — the payment provider keeps them. Drawn only with the semantic
// components (@superatom/ui).

import { useCallback, useEffect, useState } from 'react'
import { Section, Form, Field, Notice, Receipt, Figures, Kpi, Status } from '@superatom/ui'

type Api = (path: string, init?: RequestInit) => Promise<Response>
type Details = { name?: string; email?: string; line1?: string; line2?: string; city?: string; region?: string; postcode?: string; country?: string; taxId?: string }
const credits = (micro?: number) => (micro === undefined ? '—' : (micro / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 }))

export function BillingPanel({ api }: { api: Api }) {
  const [d, setD] = useState<Details>({})
  const [saved, setSaved] = useState<{ by?: string; at?: string } | null>(null)
  const [bal, setBal] = useState<{ plan: boolean; granted_micro: number; used_micro: number; balance_micro: number } | null>(null)
  const [err, setErr] = useState(''), [ok, setOk] = useState(false)
  const load = useCallback(() => {
    api('/billing').then((r) => (r.ok ? r.json() : null)).then((j: any) => { if (j?.details) { setD(j.details); setSaved({ by: j.by, at: j.at }) } }).catch(() => {})
    api('/credits').then((r) => (r.ok ? r.json() : null)).then((j: any) => j && setBal(j)).catch(() => {})
  }, [api])
  useEffect(load, [load])
  const save = async () => {
    setOk(false)
    const r = await api('/billing', { method: 'PUT', body: JSON.stringify(d) })
    const j: any = await r.json().catch(() => ({}))
    if (!r.ok) { setErr(j.error ?? `Not saved (${r.status})`); return }
    setErr(''); setOk(true); setSaved({ by: j.by, at: j.at })
  }
  const f = (k: keyof Details) => ({ id: `bill-${k}`, className: 'sa-input', value: d[k] ?? '', onChange: (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value }) })
  return (
    <div className="sa-stack sa-stack--4">
      <Figures>
        <Kpi label="Credits left" value={bal ? (bal.plan ? credits(bal.balance_micro) : 'No limit') : '—'} accent="series-1" />
        <Kpi label="Granted" value={credits(bal?.granted_micro)} accent="series-2" />
        <Kpi label="Used" value={credits(bal?.used_micro)} accent="series-3" />
      </Figures>
      <Section icon="lucide:credit-card" title="How it pays">
        <div className="sa-section__body">
          <Notice>Card payments are being set up with the payment provider; until then Superatom grants the organisation its credits. Card details will be held by the provider, never by Superatom.</Notice>
        </div>
      </Section>
      <Section icon="lucide:receipt" title="Billed as" subtitle={saved?.at ? `Last changed ${new Date(saved.at).toLocaleDateString()} by ${saved.by}` : 'Who invoices are made out to'}>
        <Form onSubmit={() => void save()} error={err} actions={<>{ok && <Status state="ok">Saved</Status>}<button className="sa-btn sa-btn--primary">Save</button></>}>
          <Field label="Name"><input {...f('name')} placeholder="Acme Limited" /></Field>
          <Field label="Billing email"><input {...f('email')} type="email" placeholder="accounts@acme.com" /></Field>
          <Field label="Address"><input {...f('line1')} placeholder="1 Main Street" /></Field>
          <Field label="Address, second line"><input {...f('line2')} /></Field>
          <Field label="City"><input {...f('city')} /></Field>
          <Field label="Region or state"><input {...f('region')} /></Field>
          <Field label="Postcode"><input {...f('postcode')} /></Field>
          <Field label="Country"><input {...f('country')} placeholder="New Zealand" /></Field>
          <Field label="Tax number (GST, VAT…)"><input {...f('taxId')} /></Field>
        </Form>
      </Section>
      {bal && !bal.plan && <Receipt items={[['Plan', 'No credit limit is set for this organisation']]} />}
    </div>
  )
}
