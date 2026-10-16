// HOW THE ORGANISATION READS TIME, MONEY AND WORDS, for one project (platform-types configuration.ts): language, number
// and date format, time zone, currency, the week's first day, the financial year. What is left unset reads neutrally —
// no place is assumed. Saved, it reaches the engine and every open page at once. Drawn only with the semantic components.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Section, Notice, Form, Field, Input, Select } from '@superatom/ui'
import type { Configuration as Config, ResolvedConfiguration } from '@superatom/platform-types'

type Api = (path: string, init?: RequestInit) => Promise<Response>
type View = { set: Config; resolved: ResolvedConfiguration; changed: { by: string; at: number } | null }

const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2000, i, 1)).toLocaleString('en', { month: 'long', timeZone: 'UTC' }))
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const listOf = (key: 'timeZone' | 'currency'): string[] => { try { return (Intl as any).supportedValuesOf(key) as string[] } catch { return [] } }

/** How an amount and a day read with these values — the configuration seen, not described. */
function preview(c: ResolvedConfiguration): string {
  try {
    const money = new Intl.NumberFormat(c.locale, { ...(c.currency ? { style: 'currency', currency: c.currency } : {}), notation: 'compact', maximumSignificantDigits: 3 }).format(5435000)
    const day = new Date().toLocaleString(c.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: c.timeZone })
    return `${money} · ${day}`
  } catch { return '' }
}

export function Configuration({ api, projectId }: { api: Api; projectId: string }) {
  const [view, setView] = useState<View | null>(null)
  const [draft, setDraft] = useState<Config>({})
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const load = useCallback(() => {
    api(`/projects/${projectId}/configuration`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: View) => { setView(j); setDraft(j.set ?? {}); setErr('') })
      .catch((e) => { console.warn('[configuration] not read', e); setErr('The configuration could not be read.') })
  }, [api, projectId])
  useEffect(load, [load])
  const zones = useMemo(() => listOf('timeZone').map((z) => ({ value: z, label: z })), [])
  const currencies = useMemo(() => listOf('currency').map((c) => ({ value: c, label: c })), [])
  const set = <K extends keyof Config>(k: K, v: Config[K] | undefined) => setDraft((d) => { const n = { ...d }; if (v === undefined || v === '') delete n[k]; else n[k] = v; return n })
  const ownMonths = !!draft.financialYear && 'months' in draft.financialYear
  const save = async () => {
    setSaving(true)
    const r = await api(`/projects/${projectId}/configuration`, { method: 'PUT', body: JSON.stringify({ configuration: draft }) })
    setSaving(false)
    if (!r.ok) { setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Not saved (${r.status})`); return }
    const j = await r.json() as View
    setView(j); setDraft(j.set ?? {}); setErr('')
  }
  const shown: ResolvedConfiguration | null = view ? { ...view.resolved, ...draft, currency: draft.currency ?? null, locale: draft.locale ?? draft.language ?? 'en', timeZone: draft.timeZone ?? 'UTC' } as ResolvedConfiguration : null
  return (
    <Section icon="lucide:globe" title="Configuration" subtitle="How this organisation reads time, money and words — what is not set reads plainly, no place assumed">
      <div className="sa-section__body sa-stack">
        {err && <Notice state="critical">{err}</Notice>}
        <Form onSubmit={() => void save()} locked={!view || saving} actions={<button type="submit" className="sa-btn sa-btn--primary">Save</button>}>
          <Field label="Language" help="A language tag, such as en or hi"><Input id="cfg-language" value={draft.language ?? ''} placeholder="en" onChange={(v) => set('language', v.trim() || undefined)} /></Field>
          <Field label="Number and date format" help="A locale, such as en-IN, en-NZ or de-DE"><Input id="cfg-locale" value={draft.locale ?? ''} placeholder="the language's own" onChange={(v) => set('locale', v.trim() || undefined)} /></Field>
          <Field label="Time zone"><Select label="Time zone" value={draft.timeZone ?? ''} emptyLabel="Not set (UTC)" options={zones} onChange={(v) => set('timeZone', v || undefined)} /></Field>
          <Field label="Currency"><Select label="Currency" value={draft.currency ?? ''} emptyLabel="Not set (plain numbers)" options={currencies} onChange={(v) => set('currency', v || undefined)} /></Field>
          <Field label="Week starts on"><Select label="Week starts on" value={draft.weekStart ? String(draft.weekStart) : ''} emptyLabel="Not set (Monday)" options={DAYS.map((d, i) => ({ value: String(i + 1), label: d }))} onChange={(v) => set('weekStart', v ? Number(v) : undefined)} /></Field>
          <Field label="Financial year starts in" help={ownMonths ? 'This project gives its financial months as their own dates — change them with sacli config' : undefined}>
            <Select label="Financial year starts in" value={!ownMonths && draft.financialYear && 'startMonth' in draft.financialYear ? String(draft.financialYear.startMonth) : ''} emptyLabel={ownMonths ? 'Its own months' : 'Not set (January)'}
              options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} disabled={ownMonths} onChange={(v) => set('financialYear', v ? { startMonth: Number(v) } : undefined)} />
          </Field>
        </Form>
        {shown && <p className="sa-muted">Reads as: {preview(shown)}{view?.changed ? ` · last changed by ${view.changed.by}` : ''}</p>}
      </div>
    </Section>
  )
}
