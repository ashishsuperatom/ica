// The pages looked at, each at every width. A page may take steps after it loads (clicks on what selects or opens —
// never on what changes anything) to reach a state worth seeing. `{project}` is the project reviewed.

export const WIDTHS = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'tablet', width: 1024, height: 800 }, { name: 'phone', width: 390, height: 844 }]

/** Click the first button (or link) whose text starts with `text`; false when there is none. */
export const click = (text) => ({ click: text })
export const wait = (ms) => ({ wait: ms })

const P = (slug) => `{console}/o/{org}/p/{project}${slug ? `/${slug}` : ''}`

export const PAGES = [
  // ── the project ──
  { key: 'project-engine', url: P('') },
  { key: 'graph', url: P('graph') },
  { key: 'graph-domain', url: P('graph'), steps: [click('{domain}'), wait(800)] },
  { key: 'graph-domain-concept', url: P('graph'), steps: [click('{domain}'), wait(600), click('{concept}'), wait(800)] },
  { key: 'graph-versions', url: P('graph'), steps: [wait(1500), { clickSelector: '.sa-versions' }, wait(800)] },
  { key: 'changes-list', url: P('inspector/changes') },
  { key: 'changes-graph', url: P('inspector/changes'), steps: [{ clickSelector: '[aria-label="Graph"], button[title="Graph"]' }, wait(1500)] },
  { key: 'questions', url: P('inspector/questions') },
  { key: 'sessions', url: P('inspector/sessions') },
  { key: 'warehouse', url: P('warehouse') },
  { key: 'data-index', url: P('index') },
  { key: 'grounding', url: P('inspector/grounding') },
  { key: 'datasource-index', url: P('inspector/index') },
  { key: 'data-access', url: P('data-access') },
  { key: 'agents-models', url: P('agents') },
  { key: 'access', url: P('access') },
  { key: 'groups', url: P('groups') },
  { key: 'agent-keys', url: P('agent-keys') },
  { key: 'events', url: P('events') },
  { key: 'audit', url: P('audit') },
  { key: 'dashboards', url: P('dashboards') },
  { key: 'addresses', url: P('subdomains') },
  { key: 'channels', url: P('channels') },
  { key: 'engine-contents', url: P('inspector/summary') },
  { key: 'files', url: P('inspector/files') },
  { key: 'database', url: P('inspector/db') },
  { key: 'logs', url: P('inspector/logs') },
  { key: 'project-settings', url: P('settings') },
  // ── the organisation and the platform (reached from the project's breadcrumbs) ──
  { key: 'home', url: '{console}/' },
  // ── the person's app ──
  { key: 'workspace-home', url: '{app}/w', app: true },
  { key: 'workspace-agents', url: '{app}/w?page=agents', app: true },
  { key: 'workspace-activity', url: '{app}/w?page=activity', app: true },
  { key: 'workspace-connections', url: '{app}/w?page=connections', app: true },
  { key: 'workspace-agent', url: '{app}/w/s/{agent}', app: true },
]
