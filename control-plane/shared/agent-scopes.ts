// What an agent key may do, by scope: the messages each scope lets through the hub to the engine. One table, read by
// the hub (which enforces it) and the admin console (which offers it). A message no scope names is refused.

export const AGENT_SCOPES = {
  /** Agents and their sessions: list agents, open a session, send intents, move between blocks, read it. */
  sessions: ['session:agents', 'session:open', 'session:intent', 'session:goto', 'session:get', 'session:file'],
  /** Ask a question in words, and stop it. */
  ask: ['analyse', 'turn:stop'],
} as const

export type AgentScope = keyof typeof AGENT_SCOPES
export const isAgentScope = (s: unknown): s is AgentScope => typeof s === 'string' && s in AGENT_SCOPES

/** Does a key with these scopes allow this message? */
export function scopeAllows(scopes: readonly string[], t: string): boolean {
  return scopes.some((s) => isAgentScope(s) && (AGENT_SCOPES[s] as readonly string[]).includes(t))
}
