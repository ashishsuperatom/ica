// What an agent key may do, by scope: the messages each scope lets through the hub to the engine. One table, read by
// the hub (which enforces it) and the admin console (which offers it). A message no scope names is refused.

/** Messages the hub answers itself, from the platform's own records (no engine needed). */
export const HUB_MESSAGES = ['session:list', 'session:read', 'program:list', 'program:publish', 'activity:list'] as const
/** Messages every agent key may send, whatever its scopes: its own activities. */
export const ALWAYS_ALLOWED = ['activity:list'] as const

export const AGENT_SCOPES = {
  /** Agents and their sessions: list agents, open a session, send intents, move between blocks, read it — and read
   *  their own sessions back from the platform. */
  sessions: ['session:agents', 'session:open', 'session:intent', 'session:goto', 'session:get', 'session:file', 'session:list', 'session:read'],
  /** Ask a question in words, and stop it. */
  ask: ['analyse', 'turn:stop'],
  /** The composition graph: read it, make and change your own concepts and domains, suggest and decide changes. */
  /** Programs: build one from its source (the engine builds and uploads it), list them, publish one it built. */
  programs: ['program:build', 'program:list', 'program:publish'],
  graph: ['graph:domains', 'graph:names', 'graph:show', 'graph:history', 'graph:compose', 'graph:suggestions', 'graph:concept', 'graph:domain', 'graph:agent', 'graph:join', 'graph:leave', 'graph:suggest', 'graph:decide'],
} as const

export type AgentScope = keyof typeof AGENT_SCOPES
export const isAgentScope = (s: unknown): s is AgentScope => typeof s === 'string' && s in AGENT_SCOPES

/** Does a key with these scopes allow this message? */
export function scopeAllows(scopes: readonly string[], t: string): boolean {
  if ((ALWAYS_ALLOWED as readonly string[]).includes(t)) return true
  return scopes.some((s) => isAgentScope(s) && (AGENT_SCOPES[s] as readonly string[]).includes(t))
}
