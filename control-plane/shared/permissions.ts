// WHO MAY DO WHAT — the one place it is decided ("Permissions — who may do what", docs/platform-architecture.md).
//
// Three levels: the platform (its superadmin holds everything), the organisation (its people), the project (the
// organisation's people, given a project role). A role is a named set of capabilities; built-in roles are fixed, custom
// roles are made from the same capabilities. The Worker, the Durable Objects and the consoles all read this file:
//   - which capability each project route, organisation route and hub message needs (fail closed: unnamed → strongest)
//   - can(): does a set of capabilities hold one
//   - beyond(): what a role, a custom role or a key would give that its giver does not hold (no one gives more)

export const ORG_CAPABILITIES = {
  'org.people': 'Add and remove people, give them projects and roles',
  'org.roles': 'Define roles and make owners',
  'org.projects': 'Create, delete and restore projects',
  'org.billing': 'Credits, budgets and everyone\'s usage',
  'org.keys': 'Organisation keys',
  'org.audit': 'The organisation\'s records',
  'warehouse.manage': 'Make warehouse tables and grant them to projects',
  'warehouse.write': 'Append rows to any warehouse table',
  'warehouse.query': 'Read every warehouse table and the warehouse\'s record',
} as const

export const PROJECT_CAPABILITIES = {
  'project.view': 'Open the project, browse its agents and views',
  'project.ask': 'Ask in words, keep sessions, record decisions',
  'project.approve': 'Approve someone else\'s decision',
  'project.connect': 'Make one\'s own connections',
  'project.publish': 'Publish concepts and programs, change the decision memory',
  'project.data': 'Shared connections, data access policies, data sources',
  'project.people': 'Project roles, groups',
  'project.keys': 'Agent keys',
  'project.audit': 'The audit history, logs, everyone\'s usage and sessions',
  'project.manage': 'Engine, settings, dashboards, domains',
  'warehouse.use': 'Read what the project was granted of the warehouse',
  'warehouse.append': 'Append to the warehouse tables the project may write',
} as const

export type OrgCapability = keyof typeof ORG_CAPABILITIES
export type ProjectCapability = keyof typeof PROJECT_CAPABILITIES
export type Capability = OrgCapability | ProjectCapability
export type Level = 'org' | 'project'

const ORG_ALL = Object.keys(ORG_CAPABILITIES) as OrgCapability[]
const PROJECT_ALL = Object.keys(PROJECT_CAPABILITIES) as ProjectCapability[]
export const capabilitiesOf = (level: Level): readonly Capability[] => (level === 'org' ? ORG_ALL : PROJECT_ALL)
export const isCapability = (level: Level, c: unknown): c is Capability => typeof c === 'string' && (capabilitiesOf(level) as readonly string[]).includes(c)

export interface Role { id: string; name: string; capabilities: Capability[]; builtin: boolean }

/** The built-in roles. Their capabilities are these, always — a stored copy never overrides them. */
export const ORG_ROLES: Record<'owner' | 'admin' | 'member', Role> = {
  owner: { id: 'owner', name: 'Owner', capabilities: [...ORG_ALL], builtin: true },
  admin: { id: 'admin', name: 'Admin', capabilities: ORG_ALL.filter((c) => c !== 'org.roles'), builtin: true },
  member: { id: 'member', name: 'Member', capabilities: [], builtin: true },
}
export const PROJECT_ROLES: Record<'admin' | 'member' | 'viewer', Role> = {
  admin: { id: 'admin', name: 'Admin', capabilities: [...PROJECT_ALL], builtin: true },
  member: { id: 'member', name: 'Member', capabilities: ['project.view', 'project.ask', 'project.approve', 'project.connect', 'warehouse.use'], builtin: true },
  viewer: { id: 'viewer', name: 'Viewer', capabilities: ['project.view'], builtin: true },
}
export const builtinRole = (level: Level, id: string): Role | undefined => (level === 'org' ? (ORG_ROLES as Record<string, Role>)[id] : (PROJECT_ROLES as Record<string, Role>)[id])
/** Organisation roles that administer every project of the organisation (mirrored into each as its admin). */
export const ORG_ADMINISTERS_PROJECTS = ['owner', 'admin'] as const

export const ALL: readonly Capability[] = [...ORG_ALL, ...PROJECT_ALL]
export const can = (held: readonly string[] | null | undefined, c: Capability): boolean => !!held && held.includes(c)
/** What `given` holds that `held` does not — empty when a giver may give it. */
export const beyond = (given: readonly string[], held: readonly string[]): string[] => given.filter((c) => !held.includes(c))

/** A custom role, checked: a name, an id, capabilities of its level only, never a built-in id. */
export function checkRole(level: Level, r: { id?: unknown; name?: unknown; capabilities?: unknown }): { role?: Role; problems: string[] } {
  const problems: string[] = []
  const name = String(r.name ?? '').trim()
  const id = String(r.id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
  if (!name || name.length > 60) problems.push('a role needs a name of at most 60 characters')
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(id)) problems.push('a role id is lower-case letters, digits and dashes')
  if (builtinRole(level, id)) problems.push(`"${id}" is a built-in role and cannot be changed`)
  const caps = Array.isArray(r.capabilities) ? [...new Set(r.capabilities.map(String))] : []
  const unknown = caps.filter((c) => !isCapability(level, c))
  if (unknown.length) problems.push(`there is no ${level} capability ${unknown.join(', ')}`)
  if (level === 'org' && caps.includes('org.roles')) problems.push('only owners define roles — a custom role cannot')
  return problems.length ? { problems } : { role: { id, name, capabilities: caps as Capability[], builtin: false }, problems }
}

// ── Project routes: /api/projects/<id>/<sub> ─────────────────────────────────────────────────────────────────────────

/** What a call on a project needs. 'platform': the platform's superadmin only. 'org-people': the organisation's
 *  people decision (its owners and admins — mirrored into the project — or the superadmin). 'internal': never public. */
export type RouteNeed = Capability | 'platform' | 'org-people' | 'internal' | 'any'

export function projectRouteNeeds(method: string, sub: string): RouteNeed {
  const read = method === 'GET' || method === 'HEAD'
  const first = sub.split('/')[0]
  // Never public: the platform's own calls into the project.
  if (['setup', 'debug', 'org-admins', 'connector-op', 'connector-calls', 'members', 'verify-conn', 'log', 'engine'].includes(first) || first.startsWith('warehouse') || first.startsWith('connector-')) return 'internal'
  if (sub.startsWith('access/arrive')) return 'internal'
  if ((first === 'audit' || first === 'usage') && !read) return 'internal'
  if (first === 'profile' || first === 'service-token') return 'platform'
  if (first === 'access') return read ? 'project.people' : 'internal'   // given through /api/assignments
  if (first === 'access-domains') return read ? 'project.people' : 'org-people'
  if (first === 'roles' || first === 'groups') return 'project.people'
  if (first === 'agent-keys') return 'project.keys'
  if (first === 'audit' || first === 'usage' || first === 'logs' || first === 'conversations') return 'project.audit'
  if (first === 'access-policies' || first === 'access-attributes' || first === 'datasources') return 'project.data'
  if (first === 'connections') return read ? 'project.view' : 'project.connect'   // shared ones: project.data, checked by the DO
  if (first === 'connectors' || first === 'programs' || first === 'status') return read ? 'project.view' : 'project.manage'
  if (first === 'dashboards') return read ? 'project.view' : 'project.manage'
  return 'project.manage'
}

// ── Organisation routes: /api/<path> with x-org-id ───────────────────────────────────────────────────────────────────

export function orgRouteNeeds(method: string, path: string): RouteNeed {
  const read = method === 'GET' || method === 'HEAD'
  if (path === '/credits/usage' || path === '/credits/allowance' || path === '/user-by-clerk-id' || path === '/messages' || path === '/ws') return 'internal'
  if (path === '/credits/grant') return 'platform'
  if (path === '/me') return 'any'
  if (path === '/audit') return 'org.audit'
  if (path === '/users') return 'org.people'                       // what may be given is checked by the OrgDO (beyond)
  if (path === '/roles') return read ? 'org.people' : 'org.roles'
  if (path === '/projects') return read ? 'any' : 'org.projects'   // a member sees the projects they are in
  if (path === '/assignments') return 'org.people'                 // or project.people in that project (the Worker checks)
  if (path === '/conversations' || path.startsWith('/conversations')) return 'org.audit'
  if (path === '/credits' || path === '/credits/budgets') return 'org.billing'
  if (path === '/usage/people') return 'any'                        // a person sees themselves; org.billing sees everyone
  if (path === '/keys' || path.startsWith('/keys/')) return 'org.keys'
  if (path === '/warehouse') return 'any'                           // filtered: what the caller's warehouse capabilities show
  if (path === '/warehouse/tables') return read ? 'any' : 'warehouse.manage'
  if (path === '/warehouse/grants') return 'warehouse.manage'
  if (path === '/warehouse/append') return 'warehouse.write'
  if (path === '/warehouse/query') return 'warehouse.query'
  return 'org.roles'
}

// ── Hub messages: what a person (or the maker of an agent key) needs to send each ─────────────────────────────────────

const VIEW = ['session:agents', 'agents:list', 'view:open', 'view:intent', 'session:get', 'session:file', 'session:list', 'session:read', 'sessions:list', 'session:load', 'program:list', 'activity:list',
  'graph:domains', 'graph:names', 'graph:show', 'graph:history', 'graph:compose', 'graph:suggestions', 'decision:paths', 'decision:states', 'decision:state', 'artifact:list', 'artifact:get', 'connector:catalog',
  'sync:req', 'answer:get', 'answer:ack', 'log:attach', 'log:detach', 'ping', 'tick', 'ui:resize', 'suggestions:req', 'analyst:sync']
const ASK = ['analyse', 'turn:stop', 'session:open', 'session:intent', 'session:goto', 'session:keep', 'session:fork', 'session:start', 'session:new', 'session:compact', 'artifact:record', 'decision:outcome', 'decision:register', 'program:build',
  'graph:concept', 'graph:domain', 'graph:agent', 'graph:join', 'graph:leave', 'graph:suggest', 'graph:decide', 'graph:publish', 'connector:test', 'connector:introspect', 'connector:read', 'connector:act', 'connector:run', 'connector:calls', 'connector:ask']
export const MESSAGE_NEEDS: Readonly<Record<string, ProjectCapability>> = {
  ...Object.fromEntries(VIEW.map((t) => [t, 'project.view'])),
  ...Object.fromEntries(ASK.map((t) => [t, 'project.ask'])),
  'artifact:decide': 'project.approve',
  'decision:change': 'project.publish', 'decision:learn': 'project.publish',
  // Publishing a program: its owner, or someone with project.publish (the catalogue decides which).
  'program:publish': 'project.ask',
  'warehouse:tables': 'warehouse.use', 'warehouse:query': 'warehouse.use', 'warehouse:append': 'warehouse.append',
  // Terminals into the agents, the inspector, index and grounding builds, engine settings: running the project.
  'term:attach': 'project.manage', 'term:input': 'project.manage', 'term:detach': 'project.manage', 'inspect:req': 'project.manage',
  'index:build': 'project.manage', 'grounding:build': 'project.manage', 'config:update': 'project.manage', 'app:reload': 'project.manage',
}
/** What a message needs; one nobody named needs the strongest. */
export const messageNeeds = (t: string): ProjectCapability => MESSAGE_NEEDS[t] ?? 'project.manage'

// ── Organisation keys: sak_org_<org>_… — an agent working for the organisation (the warehouse today) ──────────────────

/** What an organisation key may be given: these capabilities, each only by someone holding it. */
export const ORG_KEY_SCOPES = ['warehouse.query', 'warehouse.write', 'warehouse.manage'] as const satisfies readonly OrgCapability[]
export type OrgKeyScope = typeof ORG_KEY_SCOPES[number]
export const isOrgKeyScope = (s: unknown): s is OrgKeyScope => typeof s === 'string' && (ORG_KEY_SCOPES as readonly string[]).includes(s)

/** What each organisation-key message needs (one of these capabilities). */
export const ORG_MESSAGE_NEEDS: Readonly<Record<string, readonly OrgCapability[]>> = {
  'warehouse:tables': ['warehouse.query', 'warehouse.write', 'warehouse.manage'],
  'warehouse:query': ['warehouse.query'],
  'warehouse:append': ['warehouse.write'],
  'warehouse:create': ['warehouse.manage'],
  'warehouse:grants': ['warehouse.manage'],
  'warehouse:grant': ['warehouse.manage'],
  'warehouse:revoke': ['warehouse.manage'],
}
export const orgMessageAllowed = (held: readonly string[], t: string): boolean => (ORG_MESSAGE_NEEDS[t] ?? []).some((c) => held.includes(c))
