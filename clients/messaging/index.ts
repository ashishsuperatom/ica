// The messaging layer's public surface: the channel registry + the core contracts.
// The worker ingress and the ProjectDO import ONLY from here, so they stay
// channel-agnostic — they look an adapter up by name and call the interface.

import type { Surface } from '../protocol.js'
import type { ChannelAdapter } from './core/channel.js'
import { teamsAdapter } from './channels/teams/adapter.js'
import { slackAdapter } from './channels/slack/adapter.js'

export * from './core/channel.js'

// name → adapter. Add a channel here and nothing else in the core/DO changes.
const ADAPTERS: Record<string, ChannelAdapter> = {
  teams: teamsAdapter,
  slack: slackAdapter,
}

/** Look up a channel adapter by its URL segment. Returns null for an unknown channel. */
export function channelAdapter(channel: string): ChannelAdapter | null {
  return ADAPTERS[channel] ?? null
}

/** The channels currently registered (for validation / listing). */
export function knownChannels(): Surface[] {
  return Object.keys(ADAPTERS) as Surface[]
}
