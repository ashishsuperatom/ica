// ── The intent graph's shapes (docs/intent-graph.md) ────────────────────────────────────────────────────────────────
// An intent node is one kind of thing people ask for: its intent in words (never a schema), the knowledge it links to (a
// domain, or a concept — atomic or composite — of the composition graph, by name: linked, never copied), and the agent
// that answers at it when it is not the composer. Its id is `<cluster>-<unique>`: the cluster names the Durable Object
// that keeps it with its neighbours (IntentDO), so the nodes of one cluster are read together.

export interface IntentLink { kind: 'domain' | 'concept'; name: string }
export interface IntentNodeBody {
  title: string
  /** What is asked for, in words: what a later question must ask for completely to be answered here. */
  intent: string
  links: IntentLink[]
  /** The specialised agent that answers at this node (builder, connector, one the project made); none: the composer. */
  agent?: string | null
  /** Whatever else the agent that made it wrote about it — its own keys. */
  about?: Record<string, unknown>
}
export interface IntentNode extends IntentNodeBody {
  id: string
  cluster: string
  version: number
  /** Something it links to changed since it was last answered at: to be looked at again. */
  stale?: string | null
  /** Who made it: a person, or the agent that explored. */
  by: string
  at: string
  passages?: number
}
/** A way from one node to another, as people took it (used) or an agent offered it (proposed); per scope. */
export interface IntentEdge { from: string; to: string; scope: string; count: number; how: 'used' | 'proposed'; last: string }
/** One question answered at a node: the session's step it was. */
export interface IntentPassage { node: string; session: string; block: string | null; question: string; answer: string; who: string; at: string; how: 'followed' | 'made' | 'stayed'; from: string | null }

export const INTENT_ID = /^([a-z0-9][a-z0-9-]{0,39})-([a-z0-9]{6,16})$/
/** The cluster an intent node lives in, from its id. */
export const clusterOf = (id: string): string | null => INTENT_ID.exec(id)?.[1] ?? null
/** A cluster's name from what a node is mostly about (its first linked domain), else "general". */
export const clusterFor = (body: Pick<IntentNodeBody, 'links'>): string => {
  const d = body.links.find((l) => l.kind === 'domain')?.name ?? body.links[0]?.name ?? 'general'
  return d.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'general'
}
export const newIntentId = (cluster: string): string => `${cluster}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** What is wrong with a node's body, or null. */
export function checkIntentBody(b: unknown): string | null {
  const x = b as IntentNodeBody
  if (!x || typeof x !== 'object') return 'an intent node is an object'
  if (typeof x.title !== 'string' || !x.title.trim() || x.title.length > 160) return 'an intent node has a title (at most 160 characters)'
  if (typeof x.intent !== 'string' || !x.intent.trim() || x.intent.length > 4000) return 'an intent node says its intent in words (at most 4000 characters)'
  if (!Array.isArray(x.links)) return 'an intent node lists the knowledge it links to (links)'
  for (const l of x.links) if (!l || (l.kind !== 'domain' && l.kind !== 'concept') || typeof l.name !== 'string' || !l.name) return 'each link is { kind: "domain" | "concept", name }'
  if (x.agent != null && (typeof x.agent !== 'string' || !/^[a-z][a-z0-9-]{1,39}$/.test(x.agent))) return 'an agent is named in lower case (letters, digits, -)'
  if (x.about != null && (typeof x.about !== 'object' || Array.isArray(x.about))) return 'about is an object of the agent\'s own keys'
  return null
}

// ── Specialised agents of a session (docs/intent-graph.md) ──────────────────────────────────────────────────────────
// One of each per session, made only when a node needs it, and kept for the session: the same agent and folder every
// time the session reaches a node that uses it. Superatom gives every project the builder and the connector; a project's
// admins make others, each given to whoever holds what it needs.
export interface SessionAgentSpec {
  name: string
  title: string
  /** What it is for, said to the one choosing it (and to the model placing a question). */
  description: string
  /** Its role, given to it as its instructions. */
  instructions: string
  /** The capability a person needs to use it. */
  needs: string
  harness: 'claude-code' | 'codex'
  /** Made by Superatom (every project has it) or by the project. */
  builtin?: boolean
}
export const SESSION_AGENT_NAME = /^[a-z][a-z0-9-]{1,39}$/

/** The specialised agents Superatom gives every project (their instructions live with the engine). */
export const BUILTIN_SESSION_AGENTS: Omit<SessionAgentSpec, 'instructions'>[] = [
  { name: 'builder', title: 'Builder', description: 'Builds a program — a calculation, a report, a view or a dashboard — when the person asks for one to be made; never to answer a question.', needs: 'project.develop', harness: 'claude-code', builtin: true },
  { name: 'connector', title: 'Connector', description: 'Connects a new data source, or fixes or changes how one is connected, when the person asks for it.', needs: 'project.connectors', harness: 'claude-code', builtin: true },
]
