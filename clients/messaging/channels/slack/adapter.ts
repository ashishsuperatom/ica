// ── Slack channel adapter — placeholder ───────────────────────────────────────
// Implements the same ChannelAdapter contract so the core/DO stay unchanged when
// Slack lands. Nothing wired yet — the shape shows exactly what to fill in.

import type { Answer } from '../../../protocol.js'
import type { ChannelAdapter, ChannelSecrets, ConversationRef, InboundMessage } from '../../core/channel.js'

export const slackAdapter: ChannelAdapter = {
  channel: 'slack',

  async verifyInbound(_req: Request, _secrets: ChannelSecrets): Promise<boolean> {
    // TODO: verify the Slack request signature — HMAC-SHA256 over
    // `v0:${timestamp}:${rawBody}` with the signing secret, compared to
    // X-Slack-Signature; reject stale timestamps.
    return false
  },

  async parseInbound(_req: Request): Promise<InboundMessage | null> {
    // TODO: handle the Events API — url_verification challenge, then message events;
    // ignore the bot's own messages. conversation = { channel:'slack', channelId, conversationId: channel, ... }.
    return null
  },

  renderAnswer(_answer: Answer, _category?: string): unknown {
    // TODO: render Block Kit blocks (prose section + fields + a table as text/section).
    return { text: 'not implemented' }
  },

  async sendReply(_conv: ConversationRef, _body: unknown, _secrets: ChannelSecrets): Promise<void> {
    // TODO: POST https://slack.com/api/chat.postMessage with the bot token + blocks.
    throw new Error('slack adapter not implemented')
  },
}
