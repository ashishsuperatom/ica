// ── Channel-agnostic messaging core ──────────────────────────────────────────
// A "channel" is a messaging surface (Teams, Slack, …). The core + the ProjectDO
// stay channel-agnostic: they only ever call a `ChannelAdapter`. Everything
// channel-specific (verify the inbound request, parse it, render the answer, send
// the reply) lives in one adapter file. Adding a channel = one new adapter.
//
// The whole design is PROJECT-SCOPED: the projectId is in the ingress URL
// (/api/messaging/<projectId>/<channel>/<hook>), so routing is stateless — no KV,
// no global DO — and the turn is owned by that project's DO (the WS hub). A reply
// is proactive: the inbound HTTP request is acked immediately; when the engine's
// answer arrives (a WS event at the DO), the DO calls sendReply with the stored
// conversation reference.

import type { Answer, Surface } from '../../protocol.js'

// A normalized inbound message (one user turn), channel-independent.
export interface InboundMessage {
  text: string
  userId: string                 // channel-native sender id (display/audit only)
  conversation: ConversationRef  // how to reply later
}

// Everything needed to send a reply back LATER (proactively). Opaque to the core
// and the DO — only the channel adapter interprets its fields. Stored in DO state
// for the duration of the turn.
export interface ConversationRef {
  channel: Surface
  conversationId: string
  serviceUrl?: string            // teams: Bot Framework service url
  tenantId?: string              // teams: Entra tenant (audit / per-tenant reply)
  botId?: string                 // the bot's own id in this conversation
  channelId?: string             // slack: channel id
  [k: string]: unknown
}

// Per-channel credentials for THIS project (per-project bot ⇒ per-project creds).
// Sourced from the ProjectDO's own state, set at onboarding — never global env.
export interface ChannelSecrets {
  appId?: string                 // teams: bot App (client) id · slack: —
  appPassword?: string           // teams: bot client secret
  tenantId?: string              // teams: single-tenant bot's tenant (optional)
  signingSecret?: string         // slack: request-signing secret
  botToken?: string              // slack: xoxb- token for chat.postMessage
  [k: string]: unknown
}

// The ONLY channel-specific surface area. Implementations are pure (fetch + crypto);
// no Node-only SDKs, so they run in a Cloudflare Worker / Durable Object.
export interface ChannelAdapter {
  readonly channel: Surface

  // Is this inbound HTTP request genuinely from the channel? (Teams: Bot Framework
  // JWT; Slack: signing-secret HMAC.) Reject forgeries before doing any work.
  verifyInbound(req: Request, secrets: ChannelSecrets): Promise<boolean>

  // Normalize the inbound request into a message + conversation ref. Return null
  // for events we don't answer (the bot's own echo, non-message events, etc.).
  parseInbound(req: Request): Promise<InboundMessage | null>

  // Render an engine Answer into this channel's native reply body.
  renderAnswer(answer: Answer, category?: string): unknown

  // Optional interim signal (typing indicator / progress). Return null to skip.
  renderStatus?(text: string): unknown

  // Send a reply to the channel using the stored conversation ref (proactive).
  sendReply(conv: ConversationRef, body: unknown, secrets: ChannelSecrets): Promise<void>
}
