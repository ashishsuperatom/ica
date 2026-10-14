// The console's places, by layer: the platform's, an organisation's, a project's (grouped by purpose), and what each needs.

export const NAMES = new Map<string, string>()
export const named = (id: string, kind: string) => NAMES.get(id) ?? `${kind} ${id.slice(0, 8)}`

export interface Place { slug: string; label: string; icon: string; says: string; needs?: string }
/** The places of a project, by purpose — the order the work happens in — each with what it needs of the person. */
export function purposesOf(): { key: string; title: string; places: Place[] }[] {
  return [
    { key: 'knowledge', title: 'Knowledge', places: [
      { slug: 'graph', label: 'Composition graph', icon: 'solar:structure-linear', says: 'Domains, intermediate and atomic concepts — walk, change and compose them.', needs: 'project.manage' },
      { slug: 'inspector/changes', label: 'Graph changes', icon: 'solar:notes-linear', says: 'Every edit to the graph: which node, by whom, why.', needs: 'project.manage' }] },
    { key: 'data', title: 'Data', places: [
      { slug: 'sources', label: 'Data sources', icon: 'solar:layers-linear', says: 'Where the data comes from: each source, its tables and fields, its rows.', needs: 'project.manage' },
      { slug: 'warehouse', label: 'Warehouse', icon: 'solar:box-linear', says: 'The organisation\'s tables granted to this project: rows, columns, values.', needs: 'warehouse.use' },
      { slug: 'lineage', label: 'Lineage', icon: 'solar:routing-2-linear', says: 'How the data flows: what each dataset is made from, and what reads it.', needs: 'project.manage' },
      { slug: 'inspector/grounding', label: 'Grounding', icon: 'solar:map-point-linear', says: 'Names people use, matched to the records they mean.', needs: 'project.manage' },
      { slug: 'data-access', label: 'Data access', icon: 'solar:shield-check-linear', says: 'Rows, columns and denials per person, role, group or key.', needs: 'project.data' }] },
    { key: 'agents', title: 'Agents', places: [
      { slug: 'agents', label: 'Agents and models', icon: 'solar:cpu-linear', says: 'The harness, account and model each agent runs.', needs: 'project.manage' },
      { slug: 'agent', label: 'Connector', icon: 'solar:link-round-linear', says: 'Connect a data source or run an infrastructure task; the agent works live in the terminal.', needs: 'project.connectors' },
      { slug: 'analyst', label: 'Analyst', icon: 'solar:magnifer-linear', says: 'Ask the analyst a question and watch it build the program and answer it, live.', needs: 'project.manage' },
      { slug: 'grounding', label: 'Grounding agent', icon: 'solar:map-point-search-linear', says: 'Builds the value→id indexes (entity names, hierarchies, id patterns) from this project’s own data, when you start it.', needs: 'project.manage' }] },
    { key: 'people', title: 'People', places: [
      { slug: 'access', label: 'Access and roles', icon: 'solar:users-group-rounded-linear', says: 'Who works in the project, as what, and who joins by their company’s domain.', needs: 'project.people' },
      { slug: 'groups', label: 'Groups', icon: 'solar:users-group-two-rounded-linear', says: 'Groups and their members.', needs: 'project.people' },
      { slug: 'agent-keys', label: 'Agent keys', icon: 'solar:key-linear', says: 'Keys agents and scripts use, and their scopes.', needs: 'project.keys' }] },
    { key: 'activity', title: 'Activity', places: [
      { slug: 'inspector/questions', label: 'Questions', icon: 'solar:question-circle-linear', says: 'Every question and the agent it went to.', needs: 'project.manage' },
      { slug: 'inspector/sessions', label: 'Sessions', icon: 'solar:chat-round-line-linear', says: 'Each chat made from the graph, and what changed since.', needs: 'project.manage' },
      { slug: 'events', label: 'Event log', icon: 'solar:list-linear', says: 'What the project did.', needs: 'project.audit' },
      { slug: 'audit', label: 'Audit history', icon: 'solar:history-linear', says: 'Who did what, and how it ended.', needs: 'project.audit' }] },
    { key: 'engine', title: 'Engine', places: [
      { slug: 'engine', label: 'Engine', icon: 'solar:server-square-linear', says: 'The engine: compute, state, connections.', needs: 'project.view' },
      { slug: 'running', label: 'Running', icon: 'solar:pulse-2-linear', says: 'Everything the engine runs — the engine, each connection, each agent: how each stands, what happened, what can be done.', needs: 'project.view' },
      { slug: 'engine-version', label: 'Engine version', icon: 'solar:box-minimalistic-linear', says: 'Which version of the engine runs, and switching it.', needs: 'project.manage' },
      { slug: 'inspector/summary', label: 'Engine contents', icon: 'solar:eye-scan-linear', says: 'What the engine holds, at a glance.', needs: 'project.manage' },
      { slug: 'inspector/files', label: 'Files', icon: 'solar:folder-with-files-linear', says: 'The project\'s files on the engine.', needs: 'project.manage' },
      { slug: 'inspector/db', label: 'Database', icon: 'solar:database-linear', says: 'The engine\'s tables.', needs: 'project.manage' },
      { slug: 'inspector/logs', label: 'Logs', icon: 'solar:document-text-linear', says: 'The engine\'s logs.', needs: 'project.manage' }] },
    { key: 'project', title: 'Project', places: [
      { slug: 'dashboards', label: 'Dashboards', icon: 'solar:chart-square-linear', says: 'Published dashboards and their builds.', needs: 'project.view' },
      { slug: 'subdomains', label: 'Addresses', icon: 'solar:global-linear', says: 'The project\'s addresses.', needs: 'project.manage' },
      { slug: 'channels', label: 'Channels', icon: 'solar:chat-square-linear', says: 'Teams and other channels.', needs: 'project.manage' },
      { slug: 'settings', label: 'Settings', icon: 'solar:settings-linear', says: 'The project’s API key, and deleting it.', needs: 'project.manage' }] },
  ]
}
/** The places of an organisation. */
export const ORG_PLACES: Place[] = [
  { slug: '', label: 'Projects', icon: 'solar:folder-2-linear', says: 'Its projects.' },
  { slug: 'people', label: 'People and roles', icon: 'solar:users-group-rounded-linear', says: 'Who is in it, as what, and the keys agents use for it.', needs: 'org.people' },
  { slug: 'warehouse', label: 'Warehouse', icon: 'solar:box-linear', says: 'Its tables, what each project may read and write, its keys.', needs: 'warehouse' },
  { slug: 'usage', label: 'Usage and credits', icon: 'solar:chart-2-linear', says: 'What its people used.' },
  { slug: 'billing', label: 'Billing', icon: 'solar:bill-list-linear', says: 'Who it is billed as, how it pays.', needs: 'org.billing' },
  { slug: 'settings', label: 'Settings', icon: 'solar:settings-linear', says: 'The organisation itself.', needs: 'org.roles' },
]
/** The platform's places (Superatom's own). */
export const PLATFORM_PLACES: Place[] = [
  { slug: '', label: 'Organisations', icon: 'solar:buildings-2-linear', says: 'Every organisation and its owners.' },
  { slug: 'engines', label: 'Engines', icon: 'solar:server-square-linear', says: 'Every project\'s engine, and whether it reports.' },
  { slug: 'addresses', label: 'Addresses', icon: 'solar:global-linear', says: 'Every <name>.superatom.site and the project it opens.' },
  { slug: 'attention', label: 'Attention', icon: 'solar:bell-linear', says: 'What needs a decision.' },
  { slug: 'models', label: 'Models and agents', icon: 'solar:cpu-linear', says: 'The model catalogue and the agents\' harnesses.' },
  { slug: 'credentials', label: 'Credentials', icon: 'solar:key-linear', says: 'The accounts models are reached through.' },
]
export const holds = (caps: string[] | null, needs?: string) => !needs || !caps ? true : needs === 'warehouse' ? caps.some((c) => c.startsWith('warehouse.')) : caps.includes(needs)
