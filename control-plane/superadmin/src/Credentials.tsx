// ── CREDENTIALS ──────────────────────────────────────────────────────────────────────────────────────────
// Every key the coding agents use, and who may use it.
//
// THIS SCREEN NEVER SHOWS A CREDENTIAL. The API does not return values, so there is nothing here to leak: a
// screen that can render a key is a screen that can leak one over someone's shoulder, in a screenshot, or in a
// support call. What it shows is everything you need to decide something — which keys exist, whose they are,
// what is about to expire, and what has run out.
//
// The order of the page follows what an operator actually needs to know, worst first: what is expiring, then
// what is exhausted, then the rest.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Code, Empty, Field, Form, Icon, Notice, RecordList, Section, Status, type Column } from '@superatom/ui'

interface Entry {
  id: string
  provider: string
  groups?: string[]
  note?: string
  addedAt?: string
  expiresInDays: number | null   // null = this kind of credential carries no expiry, not "unknown"
  expired: boolean
  exhausted: boolean
  spentUntil: number | null
  disabled?: boolean
  canAskUsage?: boolean
  usage?: {
    observedAt: number; percentUsed?: number; limit?: number; used?: number; remaining?: number
    unit?: string; resetsAt?: string; error?: string
    windows?: Record<string, { percent: number; resetsAt?: string }>
  } | null
}

interface Data {
  entries: Entry[]
  groups: Record<string, string>
  providers: string[]
  sealed: boolean
  expiring: { id: string; provider: string; inDays: number }[]
}

// useApi returns the raw Response — every screen parses it itself. Getting that wrong is what produced an
// empty credentials table and then a bare `{}`: a Response object stringifies to nothing, so the page reported
// "no credentials" about a vault that had three.
type Api = (path: string, init?: RequestInit) => Promise<Response>

/** Parse, and turn a failure into a message worth reading rather than a silent empty state. */
async function call(api: Api, path: string, init?: RequestInit): Promise<any> {
  const res = await api(path, init)
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { /* not JSON — the raw text is the message */ }
  if (!res.ok) throw new Error(body?.error ?? text?.slice(0, 200) ?? `HTTP ${res.status}`)
  return body
}

// The figure comes from the PROVIDER, not from anything we counted — so it is absolute, and a stale read is
// simply an older truth rather than a wrong one.
function usageCell(e: Entry) {
  if (!e?.canAskUsage) return <span className="sa-faint" title="this provider exposes no usage endpoint">—</span>
  const u = e.usage
  if (!u) return <span className="sa-faint">not checked</span>
  if (u.error) return <span className="sa-faint" title={u.error}>unavailable</span>
  const age = Math.round((Date.now() - u.observedAt) / 60000)
  const pct = typeof u.percentUsed === 'number' ? u.percentUsed : null
  const money = u.unit === 'usd' && typeof u.limit === 'number' ? `$${(u.used ?? 0).toFixed(2)} of $${u.limit}` : null
  const detail = u.windows
    ? Object.entries(u.windows).map(([k, w]) => `${k} ${w.percent}%`).join(' · ')
    : u.resetsAt ? `resets ${String(u.resetsAt).slice(0, 10)}` : ''
  const figure = money ?? (pct !== null ? `${pct}%` : '—')
  return (
    <span title={`observed ${age}m ago${detail ? ' · ' + detail : ''}`}>
      {pct !== null && pct >= 80 ? <Status state="attention">{figure}</Status> : figure}
      {detail && <div className="sa-note">{detail}</div>}
    </span>
  )
}

function expiryCell(e: Entry) {
  // Said explicitly: this kind of key HAS no expiry, which is different from not knowing.
  if (e.expiresInDays === null) return <span className="sa-faint">none</span>
  if (e.expired) return <Status state="critical">expired</Status>
  if (e.expiresInDays <= 3) return <Status state="attention">{e.expiresInDays}d</Status>
  return `${e.expiresInDays}d`
}

function stateCell(e: Entry) {
  if (e.disabled) return <span title="parked — kept, but never used"><Status state="neutral">parked</Status></span>
  if (e.exhausted) return <Status state="attention">exhausted</Status>
  return <Status state="ok">ok</Status>
}

export function Credentials({ api }: { api: Api }) {
  const [d, setD] = useState<Partial<Data> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The forms stay uncontrolled — a key's value is never held in React state — so each is read through one of
  // its inputs (`input.form`).
  const keyField = useRef<HTMLInputElement>(null)
  const groupField = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try { setD(await call(api, '/credentials')); setErr(null) }
    catch (e: any) { setErr(String(e?.message ?? e)) }
  }, [api])
  useEffect(() => { load() }, [load])

  const act = async (path: string, init: RequestInit) => {
    setBusy(true)
    try { await call(api, path, init); await load(); setErr(null) }
    catch (e: any) { setErr(String(e?.message ?? e)) }
    finally { setBusy(false) }
  }

  const addEntry = async () => {
    const form = keyField.current?.form
    if (!form) return
    const f = new FormData(form)
    const groups = String(f.get('groups') || '').split(',').map(s => s.trim()).filter(Boolean)
    await act('/credentials/entry', {
      method: 'POST',
      body: JSON.stringify({
        id: f.get('id'), provider: f.get('provider'), value: f.get('value'),
        groups: groups.length ? groups : undefined, note: f.get('note') || undefined,
      }),
    })
    form.reset()
  }

  const assignGroup = async () => {
    const form = groupField.current?.form
    if (!form) return
    const f = new FormData(form)
    await act('/credentials/group', { method: 'POST', body: JSON.stringify({ projectId: f.get('projectId'), group: f.get('group') }) })
    form.reset()
  }

  if (err && !d) return <Notice state="critical"><b>Could not load credentials.</b> {err}</Notice>
  if (!d) return <Empty>Loading credentials…</Empty>

  // Absent fields must not take the page down — but they must not be disguised as emptiness either. An API
  // that answered with an error or an older shape is a DIFFERENT fact from "there are no credentials", and
  // showing the second when the first is true is how someone concludes their vault is empty and re-adds keys
  // that were already there.
  if (!Array.isArray(d.entries)) {
    return (
      <Section icon="lucide:octagon-alert" accent="loss" title="Unexpected response" subtitle="Not the same as having no credentials — nothing has been lost">
        <div className="sa-section__body sa-stack sa-stack--3">
          <Notice state="critical">The API did not return a credential list.</Notice>
          <pre className="sa-code">{JSON.stringify(d, null, 2).slice(0, 1200)}</pre>
        </div>
      </Section>
    )
  }
  const entries = d.entries
  const groups = (d.groups && typeof d.groups === 'object') ? d.groups : {}
  const providers = Array.isArray(d.providers) ? d.providers : []
  const soon = Array.isArray(d.expiring) ? d.expiring : []

  const columns: Column<Entry>[] = [
    { key: 'id', label: 'Credential', wrap: true, render: e => <>
      <Code>{e.id}</Code>
      {e.note && <div className="sa-note">{e.note}</div>}
    </> },
    { key: 'provider', label: 'Provider' },
    { key: 'groups', label: 'Groups', render: e => e.groups?.length ? e.groups.join(', ') : <span className="sa-faint">any</span> },
    { key: 'used', label: 'Used', align: 'end', render: usageCell },
    { key: 'expires', label: 'Expires', align: 'end', render: expiryCell },
    { key: 'state', label: 'State', render: stateCell },
    { key: 'acts', label: '', align: 'end', render: e => (
      <span className="sa-row sa-row--tight">
        {e.exhausted && !e.disabled && <button className="sa-btn" disabled={busy}
          onClick={() => act(`/credentials/revive/${encodeURIComponent(e.id)}`, { method: 'POST' })}>Revive</button>}
        {/* Parking keeps the key and stops it being spent — the middle ground between using it and having to
            enter it again later. */}
        <button className="sa-btn sa-btn--link" disabled={busy}
          onClick={() => act(`/credentials/enable/${encodeURIComponent(e.id)}`, { method: 'POST', body: JSON.stringify({ enabled: !!e.disabled }) })}>
          {e.disabled ? 'Enable' : 'Disable'}
        </button>
        <button className="sa-btn sa-btn--link" disabled={busy}
          onClick={() => confirm(`Remove ${e.id}? Any box using it falls back to the next candidate.`) &&
            act(`/credentials/entry/${encodeURIComponent(e.id)}`, { method: 'DELETE' })}>Remove</button>
      </span>
    ) },
  ]
  const groupRows = Object.entries(groups).map(([projectId, group]) => ({ projectId, group }))

  return (
    <div className="sa-stack sa-stack--4">
      {/* The warning goes first because it is the only thing here that is time-critical: a lapsed credential
          surfaces at the agent as something unrelated, which is expensive to diagnose. */}
      {soon.length > 0 && (
        <Notice state={soon.some(x => x.inDays < 0) ? 'critical' : 'attention'}>
          <div className="sa-stack sa-stack--3">
            <b>Expiring soon</b>
            {soon.map(x => (
              <div key={x.id}>
                <Code>{x.id}</Code> ({x.provider}) — {x.inDays < 0 ? <b>expired</b> : <>in {x.inDays} day{x.inDays === 1 ? '' : 's'}</>}
                {x.provider === 'openai-codex' && <> · re-seed with <Code>codex login</Code></>}
              </div>
            ))}
          </div>
        </Notice>
      )}

      {!d.sealed && (
        <Notice state="critical">
          <b>Not sealed.</b> CREDENTIALS_MASTER_KEY is not set, so credentials are stored in the clear. Set it and re-save each entry.
        </Notice>
      )}

      {err && <Notice state="critical">{err}</Notice>}

      <Section icon="lucide:key-round" title="Keys" subtitle="Values are never shown or returned — only a box that proves which project it is ever receives one"
        note={`${entries.length} ${entries.length === 1 ? 'key' : 'keys'}`}
        actions={<button className="sa-btn" disabled={busy} onClick={() => act('/credentials/refresh', { method: 'POST' })}>
          <Icon icon="lucide:refresh-cw" className="sa-btn__icon" />Refresh usage
        </button>}>
        <RecordList columns={columns} rows={entries} keyOf={e => e.id}
          empty="Nothing in the vault yet. There is no fallback — a provider with no entry here simply fails, which is deliberate: borrowing an unrelated key is how one gets spent without anyone noticing." />
      </Section>

      <Section icon="lucide:plus" title="Add a key" subtitle="Sealed on the way in; an expiry is read from the key itself when it carries one (a JWT does)">
        <Form onSubmit={() => void addEntry()} actions={<button className="sa-btn sa-btn--primary" disabled={busy}>Add key</button>}>
          <Field label="Id"><input ref={keyField} name="id" placeholder="codex2" required className="sa-input" /></Field>
          <Field label="Provider">
            <select name="provider" className="sa-input" required defaultValue="">
              <option value="" disabled>Choose a provider…</option>
              {providers.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Groups" help="Comma separated (prod, test). Blank means any group."><input name="groups" placeholder="prod, test" className="sa-input" /></Field>
          <Field label="Note"><input name="note" className="sa-input" /></Field>
          <Field label="Key"><input name="value" type="password" required className="sa-input" /></Field>
        </Form>
      </Section>

      <Section icon="lucide:users" title="Project groups"
        subtitle={<>Which pool a project draws on. Unassigned projects are <Code>default</Code>, the least privileged — a project nobody has classified should not inherit production’s quota</>}>
        <RecordList columns={[{ key: 'projectId', label: 'Project', render: r => <Code>{r.projectId}</Code> }, { key: 'group', label: 'Group' }]}
          rows={groupRows} keyOf={r => r.projectId} empty={<>None assigned — everything is <Code>default</Code>.</>} />
        <Form onSubmit={() => void assignGroup()} actions={<button className="sa-btn" disabled={busy}>Assign</button>}>
          <Field label="Project id"><input ref={groupField} name="projectId" required className="sa-input" /></Field>
          <Field label="Group"><input name="group" placeholder="prod" required className="sa-input" /></Field>
        </Form>
      </Section>
    </div>
  )
}
