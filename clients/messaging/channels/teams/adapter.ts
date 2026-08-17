// ── Teams channel adapter ─────────────────────────────────────────────────────
// Pure fetch + Web Crypto (no botbuilder / Node) so it runs in a Worker / DO.
// Inbound: Microsoft Bot Framework POSTs an Activity to our ingress. Outbound: we
// POST a reply to the Bot Framework REST API using the stored conversation ref and
// an app token obtained via client-credentials.

import type { Answer } from '../../../protocol.js'
import type { ChannelAdapter, ChannelSecrets, ConversationRef, InboundMessage } from '../../core/channel.js'

const MAX_ROWS = 12

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
      return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s64), new TextEncoder().encode(`${h64}.${p64}`))
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

  renderAnswer(answer: Answer, category?: string): unknown {
    // A Bot Framework "message" activity carrying an Adaptive Card attachment.
    return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: adaptiveCard(answer, category) }] }
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

// ── Adaptive Card (same shape as the local scaffold's, but plain JSON) ──────────
function adaptiveCard(a: Answer, category?: string): unknown {
  const body: any[] = []
  const cat = category ?? a.category
  if (cat) body.push({ type: 'TextBlock', text: String(cat).replace(/_/g, ' ').toUpperCase(), weight: 'Bolder', size: 'Small', isSubtle: true, spacing: 'None' })
  if (a.answer) body.push({ type: 'TextBlock', text: a.answer, wrap: true, spacing: 'Small' })
  if (a.figures?.length) body.push({ type: 'FactSet', facts: a.figures.map((f) => ({ title: f.label, value: f.sub ? `${f.display}  (${f.sub})` : f.display })), spacing: 'Medium' })
  if (a.table?.columns?.length) {
    const cols = a.table.columns, rows = a.table.rows ?? []
    const shown = rows.slice(0, MAX_ROWS)
    body.push({
      type: 'Table', columns: cols.map((_, i) => ({ width: i === 0 ? 2 : 1 })), firstRowAsHeaders: true,
      rows: [row(cols.map(String), true), ...shown.map((r) => row(cols.map((_, i) => fmt(r[i]))))],
      spacing: 'Medium',
    })
    const total = typeof a.table.totalRows === 'number' ? a.table.totalRows : rows.length
    if (total > shown.length) body.push({ type: 'TextBlock', text: `Showing ${shown.length} of ${total} rows`, size: 'Small', isSubtle: true, spacing: 'Small' })
  }
  if (a.period) body.push({ type: 'TextBlock', text: a.period, size: 'Small', isSubtle: true, wrap: true, spacing: 'Small' })
  // msteams.width:'Full' makes the card use the FULL chat-pane width (default is ~half), so the table gets
  // room to breathe instead of wrapping every cell.
  return { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.5', msteams: { width: 'Full' }, body }
}

function row(cells: string[], header = false): unknown {
  return { type: 'TableRow', cells: cells.map((c) => ({ type: 'TableCell', items: [{ type: 'TextBlock', text: c, wrap: true, weight: header ? 'Bolder' : 'Default' }] })) }
}
function fmt(v: unknown): string { return v == null ? '' : typeof v === 'number' ? v.toLocaleString() : String(v) }

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
