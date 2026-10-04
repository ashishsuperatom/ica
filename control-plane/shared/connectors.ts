// ── Connectors: what can be connected, and what connecting asks for ─────────────────────────────────────────────────
//
// Each connector declares what it is (a SQL database, a REST API, an MCP server), the form a person fills to connect it
// (secret fields marked, so they are sealed and never shown again), and who may connect it: shared by the project (an
// admin connects once, everyone uses it) or per user (each person connects their own). One list, read by the platform
// (to check a connection) and the user UI (to draw its form). Adding a connector is adding an entry; `bridge` names the
// engine-side bridge that runs it (null: it can be saved, not yet run). Code connectors run in the engine; API connectors
// are an HTTP API or MCP server — both are connections, listed together and part of the data source index.

export type FieldType = 'text' | 'secret' | 'number' | 'url' | 'select' | 'textarea'
export interface ConnectorField { name: string; label: string; type: FieldType; required?: boolean; options?: string[]; help?: string; placeholder?: string }
/** How it runs: CODE — our bridge in the engine (machine to machine, the whole engine has access); API — no code of
 *  ours, an HTTP API or an MCP server, used by agents and programs through it. Otherwise the same thing: a connection. */
export type Runs = 'code' | 'api'
export interface Connector { id: string; title: string; kind: 'sql' | 'rest' | 'mcp'; runs: Runs; description: string; levels: ('project' | 'user')[]; fields: ConnectorField[]; bridge: string | null }

export const CONNECTORS: Connector[] = [
  { id: 'netsuite', runs: 'code', title: 'NetSuite', kind: 'sql', description: 'Oracle NetSuite through SuiteQL, with an OAuth 2.0 machine-to-machine certificate.', levels: ['project'], bridge: 'netsuite-suiteql',
    fields: [
      { name: 'account', label: 'Account ID', type: 'text', required: true, placeholder: '1234567_SB1' },
      { name: 'clientId', label: 'Client ID', type: 'text', required: true },
      { name: 'certId', label: 'Certificate ID', type: 'text', required: true },
      { name: 'privateKey', label: 'Private key (PEM)', type: 'secret', required: true, help: 'The private key of the certificate uploaded to NetSuite.' },
    ] },
  { id: 'sqlserver', runs: 'code', title: 'Microsoft SQL Server', kind: 'sql', description: 'A SQL Server database, read-only.', levels: ['project', 'user'], bridge: null,
    fields: [
      { name: 'host', label: 'Host', type: 'text', required: true }, { name: 'port', label: 'Port', type: 'number', placeholder: '1433' },
      { name: 'database', label: 'Database', type: 'text', required: true }, { name: 'user', label: 'User', type: 'text', required: true },
      { name: 'password', label: 'Password', type: 'secret', required: true },
    ] },
  { id: 'postgres', runs: 'code', title: 'PostgreSQL', kind: 'sql', description: 'A PostgreSQL database, read-only.', levels: ['project', 'user'], bridge: null,
    fields: [
      { name: 'host', label: 'Host', type: 'text', required: true }, { name: 'port', label: 'Port', type: 'number', placeholder: '5432' },
      { name: 'database', label: 'Database', type: 'text', required: true }, { name: 'user', label: 'User', type: 'text', required: true },
      { name: 'password', label: 'Password', type: 'secret', required: true }, { name: 'ssl', label: 'SSL', type: 'select', options: ['require', 'prefer', 'disable'] },
    ] },
  { id: 'rest-api', runs: 'api', title: 'REST API', kind: 'rest', description: 'Any HTTP API with a token.', levels: ['project', 'user'], bridge: null,
    fields: [
      { name: 'baseUrl', label: 'Base URL', type: 'url', required: true }, { name: 'header', label: 'Auth header', type: 'text', placeholder: 'Authorization' },
      { name: 'token', label: 'Token', type: 'secret', required: true },
    ] },
  { id: 'mcp', runs: 'api', title: 'MCP server', kind: 'mcp', description: 'A Model Context Protocol server, whose tools agents can use.', levels: ['project', 'user'], bridge: null,
    fields: [
      { name: 'url', label: 'Server URL', type: 'url', required: true }, { name: 'transport', label: 'Transport', type: 'select', options: ['streamable-http', 'sse'] },
      { name: 'token', label: 'Token', type: 'secret', help: 'Sent as a bearer token, if the server needs one.' },
    ] },
]

export const connectorById = (id: string) => CONNECTORS.find((c) => c.id === id)

/** Check the values of a connection form against its connector; returns the problems, and the values split into what is
 *  kept in the clear (settings) and what is sealed (secrets). */
export function checkConnection(c: Connector, values: Record<string, unknown>): { problems: string[]; settings: Record<string, unknown>; secrets: Record<string, string> } {
  const problems: string[] = [], settings: Record<string, unknown> = {}, secrets: Record<string, string> = {}
  for (const f of c.fields) {
    const v = values?.[f.name]
    const empty = v === undefined || v === null || String(v).trim() === ''
    if (empty) { if (f.required) problems.push(`${f.label} is required`); continue }
    if (f.type === 'number' && !Number.isFinite(Number(v))) { problems.push(`${f.label} is a number`); continue }
    if (f.type === 'url' && !/^https?:\/\/\S+$/.test(String(v))) { problems.push(`${f.label} is a URL (http or https)`); continue }
    if (f.type === 'select' && f.options && !f.options.includes(String(v))) { problems.push(`${f.label} is one of ${f.options.join(', ')}`); continue }
    if (f.type === 'secret') secrets[f.name] = String(v)
    else settings[f.name] = f.type === 'number' ? Number(v) : String(v)
  }
  for (const k of Object.keys(values ?? {})) if (!c.fields.some((f) => f.name === k)) problems.push(`${c.title} has no field ${k}`)
  return { problems, settings, secrets }
}
