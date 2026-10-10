// A project's channels: a chat surface (Teams…) connected to it, with the steps to set one up.
import { useState, useEffect } from 'react'
import { Section as SectionCard, Notice, Code, Receipt, Form, Field, Status, Empty, dateTime, Icon } from '@superatom/ui'
import '@superatom/ui/design.css'

// The Teams setup steps, each a title and what to do.
export const TEAMS_GUIDE: [string, React.ReactNode][] = [
  ['1 · Create the bot', <>Azure Portal → create an <em>Azure Bot</em> resource. For “Type of App”, <em>Multi-tenant</em> is simplest.</>],
  ['2 · Enable the Teams channel', <>On the Azure Bot → <em>Channels</em> → select <em>Microsoft Teams</em> → agree &amp; apply. Without this, Teams can’t reach the bot.</>],
  ['3 · Set the messaging endpoint', <>Copy the endpoint shown below → Azure Bot → <em>Configuration</em> → <em>Messaging endpoint</em> → Save.</>],
  ['4 · App ID', <>Azure Bot → <em>Configuration</em> → <em>Microsoft App ID</em> (the app registration’s <em>Application (client) ID</em>).</>],
  ['5 · Client secret', <>Azure Portal → <em>App registrations</em> → your bot’s app → <em>Certificates &amp; secrets</em> → <em>New client secret</em> → copy the <strong>Value</strong> immediately (shown only once — the “Secret ID” is <em>not</em> it).</>],
  ['6 · Tenant ID', <>Azure Portal → <em>Microsoft Entra ID</em> → <em>Overview</em> → <em>Tenant ID</em> (needed for single-tenant apps).</>],
  ['7 · Connect here', <>Paste the three values below → <em>Connect Teams</em>. This stores the credentials so the engine can answer — it does <em>not</em> yet put the bot in Teams.</>],
  ['8 · Build the Teams app package', <>One per project — don’t reuse another project’s. A <em>.zip</em> of <em>manifest.json</em> + two icons (<em>color</em> 192×192, <em>outline</em> 32×32), all at the zip root. In manifest.json: set <em>bots[0].botId</em> (and <em>webApplicationInfo.id</em> if present) to <strong>this</strong> bot’s App ID, give it a <strong>new unique</strong> <em>id</em> (a fresh GUID — the app’s own id, not the bot’s), and a distinct <em>name</em>. (Prefer a UI? <em>dev.teams.microsoft.com → Apps → Import app</em> lets you edit + publish instead.)</>],
  ['9 · Upload it to your org', <>Teams → <em>Apps</em> → <em>Manage your apps</em> → <em>Upload an app</em> → <em>“Upload an app to your org’s app catalog”</em> → pick the .zip. (Admins can also use <em>Teams admin center → Manage apps → Upload</em>.)</>],
  ['10 · Find it in Teams', <>Teams → <em>Apps</em> → <em>Built for your org</em> → your app → <em>Add</em>. Org apps can take a while (up to ~24h) to appear — give it time and refresh.</>],
  ['11 · Start chatting', <>Open a 1:1 chat with the bot and message it (e.g. “how many customers do we have?”), or add it to a channel and <em>@mention</em> it. It answers for <em>this</em> project only.</>],
]

// Channels: connect a chat surface (Teams, Slack, …) to this project. It mints a scoped service
// token + stores the channel's bot credentials in the project's ChannelDO — all via the admin
// session (no manual token). Per-project, per-channel; nothing here touches other projects.
export function ChannelsPanel({ projectId, api }: { projectId: string; api: (path: string, init?: RequestInit) => Promise<Response> }) {
  const endpoint = `https://superatom.site/api/messaging/${projectId}/teams/messages`
  const [appId, setAppId] = useState(''); const [secret, setSecret] = useState(''); const [tenantId, setTenantId] = useState('')
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [showGuide, setShowGuide] = useState(false)
  const [status, setStatus] = useState<{ connected?: boolean; appId?: string; tenantId?: string; hasSecret?: boolean; configuredAt?: number } | null>(null)
  const refreshStatus = () => api(`/messaging/${projectId}/teams/status`).then(r => (r.ok ? r.json() : null)).then(d => setStatus(d?.channels?.teams ?? null)).catch(() => {})
  useEffect(() => { refreshStatus() }, [projectId])   // show "connected" without ever re-exposing the secret
  async function connect() {
    setBusy(true); setMsg(null)
    try {
      // 1) mint a scoped service token for this project's teams channel
      const st = await api(`/projects/${projectId}/service-token`, { method: 'POST', body: JSON.stringify({ channel: 'teams' }) })
      if (!st.ok) throw new Error(`service-token failed (${st.status})`)
      const { token: serviceToken } = await st.json()
      // 2) store token + bot secrets in the ChannelDO
      const r = await api(`/messaging/${projectId}/teams/config`, { method: 'POST', body: JSON.stringify({
        serviceToken, secrets: { teams: { appId: appId.trim(), appPassword: secret.trim(), tenantId: tenantId.trim() } },
      }) })
      if (!r.ok) throw new Error(`config failed (${r.status})`)
      setMsg({ ok: true, text: 'Saved. If the bot isn’t in Teams yet, publish the app to your org — see the setup guide.' })
      setSecret(''); refreshStatus()
    } catch (err: any) { setMsg({ ok: false, text: String(err?.message ?? err) }) } finally { setBusy(false) }
  }
  return (
    <>
      <SectionCard icon="lucide:message-square" title="Microsoft Teams" subtitle="Each channel joins the engine as a scoped bot, routed to this project only"
        actions={<button type="button" className="sa-btn sa-btn--link" onClick={() => setShowGuide(v => !v)}>
          <Icon icon={showGuide ? 'lucide:x' : 'lucide:book-open'} className="sa-btn__icon" />{showGuide ? 'Hide setup guide' : 'Setup guide'}</button>}>
        {status?.connected && <>
          <Receipt items={[
            ['Status', <Status state="ok">Connected</Status>],
            ['App ID', <Code>{status.appId}</Code>],
            ['Tenant', <Code>{status.tenantId}</Code>],
            ['Client secret', status.hasSecret ? 'set' : '—'],
            ...(status.configuredAt ? [['Configured', dateTime(status.configuredAt)] as [string, React.ReactNode]] : []),
          ]} />
          <div className="sa-section__body"><Notice>The secret is stored, never shown. Re-enter the fields below only to update it.</Notice></div>
        </>}
        {showGuide && <Receipt items={TEAMS_GUIDE} />}
        <Form onSubmit={() => void connect()} error={msg && !msg.ok ? msg.text : undefined}
          actions={<button className="sa-btn sa-btn--primary" disabled={busy}>{busy ? 'Connecting…' : 'Connect Teams'}</button>}>
          <Field label="Messaging endpoint" help="Paste into Azure Bot → Configuration. First time? Open the setup guide.">
            <input className="sa-input" readOnly value={endpoint} onFocus={e => e.currentTarget.select()} />
          </Field>
          <Field label="App ID"><input className="sa-input" value={appId} onChange={e => setAppId(e.target.value)} required placeholder="b153838f-…" /></Field>
          <Field label="Client secret"><input className="sa-input" value={secret} onChange={e => setSecret(e.target.value)} required type="password" placeholder="secret value" /></Field>
          <Field label="Tenant ID"><input className="sa-input" value={tenantId} onChange={e => setTenantId(e.target.value)} required placeholder="b9bd0c3d-…" /></Field>
        </Form>
        {msg?.ok && <div className="sa-section__body"><Notice state="ok">{msg.text}</Notice></div>}
      </SectionCard>
      <SectionCard icon="lucide:hash" title="Slack">
        <Empty icon="lucide:clock">Coming soon — the same flow, one adapter away.</Empty>
      </SectionCard>
    </>
  )
}
