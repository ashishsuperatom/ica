// ── Teams channel adapter ─────────────────────────────────────────────────────
// Pure fetch + Web Crypto (no botbuilder / Node) so it runs in a Worker / DO.
// Inbound: Microsoft Bot Framework POSTs an Activity to our ingress. Outbound: we
// POST a reply to the Bot Framework REST API using the stored conversation ref and
// an app token obtained via client-credentials.

import { partsOf, type Answer } from '../../../protocol.js'
import type { ChannelAdapter, ChannelSecrets, ConversationRef, InboundMessage } from '../../core/channel.js'

const MAX_ROWS = 10

// Teams message markdown renders **bold** + bullet lists, but NOT GFM pipe tables (they come out as garbled
// "| --- |" text). Convert any table block into bullet lines: "- <first cell> — <col>: <val> · …".
function mdTablesToBullets(md: string): string {
  const lines = md.split('\n')
  const isRow = (s: string) => /^\s*\|.*\|\s*$/.test(s)
  const isSep = (s: string) => /^\s*\|[\s:|-]+\|\s*$/.test(s)
  const cells = (s: string) => s.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
  const out: string[] = []
  for (let i = 0; i < lines.length;) {
    if (isRow(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const header = cells(lines[i]); i += 2
      while (i < lines.length && isRow(lines[i])) {
        const c = cells(lines[i]); i++
        const rest = c.slice(1).map((v, k) => (v ? `${header[k + 1] ? header[k + 1] + ' ' : ''}${v}` : '')).filter(Boolean).join(' · ')
        out.push(`- ${c[0]}${rest ? ' — ' + rest : ''}`)
      }
    } else { out.push(lines[i]); i++ }
  }
  return out.join('\n')
}

export const teamsAdapter: ChannelAdapter = {
  channel: 'teams',

  async verifyInbound(authToken, secrets): Promise<boolean> {
    // Fully validate the Bot Framework JWT: RS256 signature against the BF JWKS, plus
    // issuer (the Bot Connector) and audience (== our bot App ID) and expiry. This is
    // what proves the request really came from Microsoft for THIS bot. (Emulator-issued
    // tokens use a different issuer and are intentionally not accepted here.)
    if (!authToken) return false
    try {
      const [h64, p64, s64] = authToken.split('.')
      if (!h64 || !p64 || !s64) return false
      const header = JSON.parse(b64urlStr(h64))
      const claims = JSON.parse(b64urlStr(p64))
      if (secrets.appId && claims.aud !== secrets.appId) return false
      if (claims.iss !== 'https://api.botframework.com') return false
      const now = Math.floor(Date.now() / 1000)
      if (typeof claims.exp === 'number' && claims.exp < now - 300) return false   // 5-min skew
      const jwk = await botFrameworkJwk(header.kid)
      if (!jwk) return false
      const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
      // `as BufferSource`: TS 5.7 made Uint8Array generic over its buffer, so the general type admits a
      // SharedArrayBuffer-backed view that WebCrypto will not take. These bytes are always plain.
      return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s64) as BufferSource, new TextEncoder().encode(`${h64}.${p64}`) as BufferSource)
    } catch { return false }
  },

  async parseInbound(req): Promise<InboundMessage | null> {
    const a = await req.json().catch(() => null) as any
    // Only real chat messages. Reactions (👍❤️) arrive as 'messageReaction' activities — dropped here. We take
    // ONLY the typed text; a quoted/replied message is a separate attachment we never read (keep it minimal).
    if (!a || a.type !== 'message') return null
    // Strip @-mention markup ("<at>Bot</at> question" → "question") so channels/group chats send a clean question.
    const text = (a.text ?? '').replace(/<at\b[^>]*>.*?<\/at>/gi, ' ').replace(/\s+/g, ' ').trim()
    if (!text) return null
    return {
      text,
      userId: a.from?.id ?? 'unknown',
      conversation: {
        channel: 'teams',
        conversationId: a.conversation?.id ?? '',
        serviceUrl: a.serviceUrl,
        tenantId: a.channelData?.tenant?.id ?? a.conversation?.tenantId,
        botId: a.recipient?.id,
      },
    }
  },

  renderAnswer(answer: Answer): unknown {
    // AS PLAIN AS POSSIBLE: an answer of words is a text message (Teams draws its markdown); one with tables is a card
    // of its words and small tables, in the order written.
    const parts = partsOf(answer)
    if (!parts.some((p) => 'card' in p)) return { type: 'message', textFormat: 'markdown', text: [periodLine(answer), answer.markdown && parts.map((p) => ('text' in p ? p.text : '')).join('\n\n')].filter(Boolean).join('\n\n') || 'No answer.' }
    return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: adaptiveCard(answer) }] }
  },

  renderReport(answer: Answer, report: { png: string; html: string }, category?: string): unknown {
    // ONE Adaptive Card with the image INSIDE it. msteams width:'Full' makes it render WIDE and clean on BOTH
    // Teams desktop and mobile — far better than a bare image attachment (which comes out small/narrow). The
    // image's selectAction (and the button) open the FULL HTML REPORT — tapping the card image takes you to the
    // real interactive report, which is more useful than a bigger static PNG. Answer.answer may be a string OR
    // a list → bullet lines.
    void category
    const body: any[] = []
    // its words (the cards are in the image)
    const takeaway = partsOf(answer).map((p) => ('text' in p ? p.text : '')).filter(Boolean).join('\n\n')
    if (takeaway) body.push({ type: 'TextBlock', text: takeaway, wrap: true, spacing: 'Small' })
    if (report.png) body.push({ type: 'Image', url: report.png, size: 'Stretch', altText: 'Answer report', spacing: 'Medium', ...(report.html ? { selectAction: { type: 'Action.OpenUrl', title: 'Open the full report', url: report.html } } : {}) })
    const card = { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.5', msteams: { width: 'Full' }, body, actions: report.html ? [{ type: 'Action.OpenUrl', title: 'View the full report', url: report.html }] : [] }
    return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] }
  },

  renderText(text: string): unknown {
    // Plain Bot Framework message. Teams renders **bold** + bullet lists but NOT markdown pipe tables, so we
    // convert any table to bullet lines HERE (programmatically) — the LLM just emits canonical markdown, unaware
    // of the channel.
    return { type: 'message', text: mdTablesToBullets(String(text)) }
  },

  renderStatus(_text: string): unknown {
    return { type: 'typing' }
  },

  async sendReply(conv: ConversationRef, body: unknown, secrets: ChannelSecrets): Promise<void> {
    if (!conv.serviceUrl || !conv.conversationId) throw new Error('teams: incomplete conversation ref')
    const token = await appToken(secrets)
    const url = `${conv.serviceUrl.replace(/\/$/, '')}/v3/conversations/${encodeURIComponent(conv.conversationId)}/activities`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`teams reply failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  },
}

// Client-credentials app token for the Bot Framework API, cached per (appId,tenant) until ~1min before
// expiry. The cache lives in the worker isolate, so repeated calls within a turn (typing pings + the final
// reply) reuse one token instead of hitting Azure each time.
const tokenCache = new Map<string, { token: string; exp: number }>()
async function appToken(s: ChannelSecrets): Promise<string> {
  if (!s.appId || !s.appPassword) throw new Error('teams: appId/appPassword not configured for this project')
  const tenant = s.tenantId || 'botframework.com'
  const key = `${s.appId}:${tenant}`
  const cached = tokenCache.get(key)
  if (cached && cached.exp > Date.now() + 60_000) return cached.token
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: s.appId,
      client_secret: s.appPassword,
      scope: 'https://api.botframework.com/.default',
    }),
  })
  if (!res.ok) throw new Error(`teams token failed (${res.status})`)
  const j = (await res.json()) as any
  tokenCache.set(key, { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 })
  return j.access_token as string
}

// ── Adaptive Card: the answer's words and its tables, in the order written ────────
const periodLine = (a: Answer) => (a.periods?.length ? `_${a.periods.map((p) => `${p.label}${p.detail ? ` — ${p.detail}` : ''}`).join(' · ')}_` : '')
function adaptiveCard(a: Answer): unknown {
  const body: any[] = []
  const when = periodLine(a)
  if (when) body.push({ type: 'TextBlock', text: when, size: 'Small', isSubtle: true, wrap: true, spacing: 'None' })
  for (const p of partsOf(a)) {
    if ('text' in p) { body.push({ type: 'TextBlock', text: p.text, wrap: true, spacing: 'Small' }); continue }
    if (!p.card) { body.push({ type: 'TextBlock', text: '_A table here could not be shown._', isSubtle: true, wrap: true, spacing: 'Small' }); continue }
    if (p.card.title) body.push({ type: 'TextBlock', text: p.card.title, weight: 'Bolder', size: 'Small', spacing: 'Medium', wrap: true })
    pushTable(body, p.card.columns.map((c) => c.label), p.card.text)
  }
  // msteams.width:'Full' makes the card use the FULL chat-pane width (default is ~half), so the table gets
  // room to breathe instead of wrapping every cell.
  return { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.5', msteams: { width: 'Full' }, body }
}

// One small table: its first rows as the web words them, and how many more there are.
function pushTable(body: any[], cols: string[], rows: string[][]): void {
  const shown = rows.slice(0, MAX_ROWS)
  body.push({
    type: 'Table', columns: cols.map((_, i) => ({ width: i === 0 ? 2 : 1 })), firstRowAsHeaders: true,
    rows: [row(cols.map(String), true), ...shown.map((r) => row(cols.map((_, i) => r[i] ?? '')))],
    spacing: 'Small',
  })
  if (rows.length > shown.length) body.push({ type: 'TextBlock', text: `Showing ${shown.length} of ${rows.length} rows`, size: 'Small', isSubtle: true, spacing: 'Small' })
}

function row(cells: string[], header = false): unknown {
  return { type: 'TableRow', cells: cells.map((c) => ({ type: 'TableCell', items: [{ type: 'TextBlock', text: c, wrap: true, weight: header ? 'Bolder' : 'Default' }] })) }
}

// ── Bot Framework JWKS (for inbound JWT validation) ───────────────────────────
// Cache the signing keys (refreshed daily). The OpenID config points at the JWKS uri.
let jwksCache: { exp: number; keys: any[] } = { exp: 0, keys: [] }
async function botFrameworkJwk(kid: string): Promise<any | null> {
  if (jwksCache.exp < Date.now()) {
    const cfg = await (await fetch('https://login.botframework.com/v1/.well-known/openidconfiguration')).json() as any
    const jwks = await (await fetch(cfg.jwks_uri)).json() as any
    jwksCache = { exp: Date.now() + 24 * 3600_000, keys: jwks.keys ?? [] }
  }
  return jwksCache.keys.find((k) => k.kid === kid) ?? null
}

function b64urlBytes(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='))
  const out = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}
function b64urlStr(s: string): string { return new TextDecoder().decode(b64urlBytes(s)) }
