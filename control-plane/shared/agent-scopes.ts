// What an agent key may do, by scope: the messages each scope lets through the hub to the engine. One table, read by
// the hub (which enforces it) and the admin console (which offers it). A message no scope names is refused.
// A key acts for its maker (shared/permissions.ts): a scope is given only by someone holding what it needs, and every
// message is also cut to what the maker holds now.

import { can, messageNeeds, type ProjectCapability } from './permissions.js'

/** Messages the hub answers itself, from the platform's own records (no engine needed). */
export const HUB_MESSAGES = ['session:list', 'session:read', 'program:list', 'program:publish', 'activity:list', 'decision:paths', 'decision:outcome', 'decision:states', 'decision:state', 'decision:change', 'decision:learn', 'artifact:record', 'artifact:decide', 'artifact:list', 'artifact:get', 'decision:register', 'warehouse:tables', 'warehouse:query', 'warehouse:explore', 'warehouse:queries', 'warehouse:queries:save', 'warehouse:queries:delete', 'warehouse:append', 'connector:catalog', 'connector:test', 'connector:introspect', 'connector:read', 'connector:act', 'connector:run', 'connector:calls',
  // The composition graph: held by the platform (superadmin/src/graph.ts), read and changed there.
  'graph:domains', 'graph:names', 'graph:show', 'graph:history', 'graph:compose', 'graph:suggestions', 'graph:concept', 'graph:domain', 'graph:agent', 'graph:join', 'graph:leave', 'graph:suggest', 'graph:decide', 'graph:publish', 'graph:versions', 'graph:version', 'graph:restore', 'graph:import', 'app:publish'] as const
/** Messages every agent key may send, whatever its scopes: its own activities. */
export const ALWAYS_ALLOWED = ['activity:list'] as const

export const AGENT_SCOPES = {
  /** Agents and their sessions: list agents, open a session, send intents, move between blocks, read it — and read
   *  their own sessions back from the platform. */
  sessions: ['session:agents', 'view:open', 'view:intent', 'session:keep', 'session:open', 'session:intent', 'session:goto', 'session:get', 'session:file', 'session:list', 'session:read', 'session:fork', 'session:start', 'session:attach'],
  /** Ask a question in words, and stop it. */
  ask: ['analyse', 'turn:stop'],
  /** Programs: build one from its source (the engine builds and uploads it), list them, publish one it built. */
  programs: ['program:build', 'program:list', 'program:publish'],
  /** The decision memory: the paths from a step and how a step turned out (with sessions), read the decision states. */
  decisions: ['decision:paths', 'decision:outcome', 'decision:states', 'decision:state', 'artifact:record', 'artifact:decide', 'artifact:list', 'artifact:get', 'decision:register'],
  /** The learning path: change decision states through their named operations. */
  learn: ['decision:states', 'decision:state', 'decision:change', 'decision:learn'],
  /** The organisation's warehouse, as far as this project was granted: its tables and columns, and SQL over them. */
  warehouse: ['warehouse:tables', 'warehouse:query', 'warehouse:explore', 'warehouse:queries', 'warehouse:queries:save', 'warehouse:queries:delete'],
  /** Append rows to the warehouse tables this project's grant makes writable. */
  'warehouse-write': ['warehouse:tables', 'warehouse:append'],
  /** The project's connections to other systems (connectors/): read what they offer, run actions (a change waits for a
   *  person), and code mode — a program over them in a sandbox. */
  connectors: ['connector:catalog', 'connector:test', 'connector:introspect', 'connector:read', 'connector:act', 'connector:run', 'connector:calls'],
  /** The composition graph: read it, make and change your own concepts and domains, suggest and decide changes. */
  /** Publishing: make concepts, domains, agents and programs seen by everyone (or a group), and decide others'
   *  suggestions — as someone who may publish. */
  publish: ['graph:publish', 'graph:decide', 'graph:import', 'program:publish'],
  /** The project's own application: publish a version of its source (the engine downloads it). */
  app: ['app:publish'],
  graph: ['graph:domains', 'graph:names', 'graph:show', 'graph:history', 'graph:compose', 'graph:suggestions', 'graph:concept', 'graph:domain', 'graph:agent', 'graph:join', 'graph:leave', 'graph:suggest', 'graph:decide', 'graph:publish', 'graph:versions', 'graph:version', 'graph:restore'],
} as const

export type AgentScope = keyof typeof AGENT_SCOPES
export const isAgentScope = (s: unknown): s is AgentScope => typeof s === 'string' && s in AGENT_SCOPES

/** What a scope gives: the capabilities its messages need. A maker must hold all of them to give it, and a key holds
 *  no more than its maker holds of them, now. */
export const scopeCapabilities = (scope: AgentScope): ProjectCapability[] => [...new Set([...(AGENT_SCOPES[scope] as readonly string[]).map(messageNeeds), ...(SCOPE_ALSO[scope] ?? [])])]
/** What a scope gives beyond its messages' needs: publishing is a standing, not a message. */
const SCOPE_ALSO: Partial<Record<AgentScope, ProjectCapability[]>> = { publish: ['project.publish'] }
/** The scopes a maker holding these capabilities may give. */
export const scopesGivable = (held: readonly string[]): AgentScope[] => (Object.keys(AGENT_SCOPES) as AgentScope[]).filter((s) => scopeCapabilities(s).every((c) => can(held, c)))
/** What a key holds: its maker's capabilities, cut to what its scopes give. */
export const keyCapabilities = (scopes: readonly string[], makerHolds: readonly string[]): ProjectCapability[] =>
  [...new Set(scopes.filter(isAgentScope).flatMap(scopeCapabilities))].filter((c) => makerHolds.includes(c))

/** May a key with these scopes, made by someone who now holds `makerHolds`, send this message? */
export function keyAllows(scopes: readonly string[], makerHolds: readonly string[], t: string): boolean {
  return scopeAllows(scopes, t) && can(makerHolds, messageNeeds(t))
}

/** Does a key with these scopes allow this message? */
export function scopeAllows(scopes: readonly string[], t: string): boolean {
  if ((ALWAYS_ALLOWED as readonly string[]).includes(t)) return true
  return scopes.some((s) => isAgentScope(s) && (AGENT_SCOPES[s] as readonly string[]).includes(t))
}
