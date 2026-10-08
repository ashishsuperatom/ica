// ── Connectors: what can be connected, and what connecting asks for ─────────────────────────────────────────────────
//
// Each connector declares what it is (a SQL database, a REST API, an MCP server), the form a person fills to connect it
// (secret fields marked, so they are sealed and never shown again), and who may connect it: shared by the project (an
// admin connects once, everyone uses it) or per user (each person connects their own). One list, read by the platform
// (to check a connection) and the user UI (to draw its form). Adding a connector is adding an entry; `bridge` names the
// engine-side bridge that runs it (null: it can be saved, not yet run). Code connectors run in the engine; API connectors
// are an HTTP API or MCP server — both are connections, listed together and part of the data source index.

import CLOUD from '../../connectors/dist/catalog.json'

export type FieldType = 'text' | 'secret' | 'number' | 'url' | 'select' | 'textarea'
export interface ConnectorField { name: string; label: string; type: FieldType; required?: boolean; options?: string[]; help?: string; placeholder?: string }
/** How it runs: CODE — our bridge in the engine (machine to machine, the whole engine has access); API — no code of
 *  ours, an HTTP API or an MCP server, used by agents and programs through it. Otherwise the same thing: a connection. */
/** CLOUD — a connector of the connectors package (connectors/): its code runs in the platform's sandbox, reached
 *  through the gateway that holds the connection's credentials; it reads data and may do actions. */
export type Runs = 'code' | 'api' | 'cloud'
export interface Connector {
  id: string; title: string; kind: 'sql' | 'rest' | 'mcp'; runs: Runs; description: string; levels: ('project' | 'user')[]; fields: ConnectorField[]; bridge: string | null
  /** How it is shown (an iconify icon, loaded when shown; cloud connectors also an accent), and what it offers. */
  icon?: string; accent?: string; offers?: { data: boolean; actions: boolean }; category?: string
  /** The platform's own source: in every project from its start, made and kept current by the platform — never connected
   *  or removed by people, so never offered to connect. */
  builtin?: boolean
}

/** SA-WAREHOUSE: the organisation's warehouse in Superatom, a source of every project (as far as it granted the project). */
export const SA_WAREHOUSE = 'SA-WAREHOUSE'

export const CONNECTORS: Connector[] = [
  { id: 'sa-warehouse', runs: 'code', builtin: true, title: SA_WAREHOUSE, icon: 'lucide:warehouse', kind: 'sql', description: "The organisation's warehouse in Superatom: the tables it granted this project, read through the platform.", levels: ['project'], bridge: 'sa-warehouse',
    fields: [] },
  { id: 'netsuite', runs: 'code', title: 'NetSuite', icon: 'cib:oracle-netsuite', kind: 'sql', description: 'Oracle NetSuite through SuiteQL, with an OAuth 2.0 machine-to-machine certificate.', levels: ['project'], bridge: 'netsuite-suiteql',
    fields: [
      { name: 'account', label: 'Account ID', type: 'text', required: true, placeholder: '1234567_SB1' },
      { name: 'clientId', label: 'Client ID', type: 'text', required: true },
      { name: 'certId', label: 'Certificate ID', type: 'text', required: true },
      { name: 'privateKey', label: 'Private key (PEM)', type: 'secret', required: true, help: 'The private key of the certificate uploaded to NetSuite.' },
    ] },
  // A source reached by a bridge written for it (by the connector agent, or a person): its settings and secrets are
  // whatever its bridge reads (createBridge({ settings, secrets })), given as two maps.
  { id: 'code', runs: 'code', title: 'Custom source (code)', kind: 'sql', description: 'A source reached by a bridge written for it; its settings and secrets are what the bridge reads.', levels: ['project'], bridge: 'its own',
    fields: [] },
  // An application's own database beside its engine: a DuckDB file, read by agents and programs, written by programs (the
  // bridge template duckdb; the data source manager supplies DuckDB's native driver).
  { id: 'duckdb', runs: 'code', title: 'DuckDB', icon: 'devicon:duckdb', kind: 'sql', description: "A DuckDB database file on the engine's disk — read by agents and programs, written by programs.", levels: ['project'], bridge: 'duckdb',
    fields: [
      { name: 'path', label: 'Database file', type: 'text', required: true, placeholder: '/data/app.duckdb', help: "Its path on the engine's machine." },
    ] },
  // SQL Server's protocol in the cloud, signing in as an Entra service principal (the bridge template mssql.bridge.mjs).
  { id: 'azure-sql', runs: 'code', title: 'Microsoft Fabric / Azure SQL', icon: 'thesvg-color:microsoft-fabric', kind: 'sql', description: 'A Microsoft Fabric warehouse or SQL endpoint, or an Azure SQL database, read with an Entra service principal.', levels: ['project'], bridge: 'mssql',
    fields: [
      { name: 'server', label: 'Server', type: 'text', required: true, placeholder: 'xxxx.datawarehouse.fabric.microsoft.com' },
      { name: 'database', label: 'Database', type: 'text', required: true },
      { name: 'tenantId', label: 'Tenant ID', type: 'text', required: true },
      { name: 'clientId', label: 'Client ID', type: 'text', required: true },
      { name: 'clientSecret', label: 'Client secret', type: 'secret', required: true },
    ] },
  { id: 'sqlserver', runs: 'code', title: 'Microsoft SQL Server', icon: 'selfhst:microsoft-sql-server', kind: 'sql', description: 'A SQL Server database, read-only.', levels: ['project', 'user'], bridge: null,
    fields: [
      { name: 'host', label: 'Host', type: 'text', required: true }, { name: 'port', label: 'Port', type: 'number', placeholder: '1433' },
      { name: 'database', label: 'Database', type: 'text', required: true }, { name: 'user', label: 'User', type: 'text', required: true },
      { name: 'password', label: 'Password', type: 'secret', required: true },
    ] },
  { id: 'postgres', runs: 'code', title: 'PostgreSQL', icon: 'devicon:postgresql', kind: 'sql', description: 'A PostgreSQL database, read-only.', levels: ['project', 'user'], bridge: null,
    fields: [
      { name: 'host', label: 'Host', type: 'text', required: true }, { name: 'port', label: 'Port', type: 'number', placeholder: '5432' },
      { name: 'database', label: 'Database', type: 'text', required: true }, { name: 'user', label: 'User', type: 'text', required: true },
      { name: 'password', label: 'Password', type: 'secret', required: true }, { name: 'ssl', label: 'SSL', type: 'select', options: ['require', 'prefer', 'disable'] },
    ] },
  // the cloud connectors: every connector the connectors package built (connectors/dist/catalog.json)
  ...(CLOUD as any[]).map((m): Connector => ({
    id: m.id, title: m.name, runs: 'cloud', kind: m.category === 'mcp' ? 'mcp' : m.category === 'database' ? 'sql' : 'rest', description: m.says, levels: ['project', 'user'], bridge: null,
    icon: m.icon, accent: m.accent, offers: m.offers, category: m.category,
    fields: (m.fields as any[]).map((f) => ({ name: f.key, label: f.label, type: f.type === 'boolean' ? 'select' : f.type, ...(f.type === 'boolean' ? { options: ['true', 'false'] } : {}), ...(f.required ? { required: true } : {}), ...(f.options ? { options: f.options } : {}), ...(f.help ? { help: f.help } : {}), ...(f.placeholder ? { placeholder: f.placeholder } : {}) })),
  })),
]

export const connectorById = (id: string) => CONNECTORS.find((c) => c.id === id)

/** Check the values of a connection form against its connector; returns the problems, and the values split into what is
 *  kept in the clear (settings) and what is sealed (secrets). */
export function checkConnection(c: Connector, values: Record<string, unknown>): { problems: string[]; settings: Record<string, unknown>; secrets: Record<string, string> } {
  const problems: string[] = [], settings: Record<string, unknown> = {}, secrets: Record<string, string> = {}
  if (c.id === 'code') {   // free-form: { settings: {…}, secrets: {…} }
    const s = values?.settings, x = values?.secrets
    if (s !== undefined && (typeof s !== 'object' || Array.isArray(s))) problems.push('settings is a map of names to values')
    if (x !== undefined && (typeof x !== 'object' || Array.isArray(x) || Object.values(x as object).some((v) => typeof v !== 'string'))) problems.push('secrets is a map of names to text')
    return { problems, settings: (s ?? {}) as Record<string, unknown>, secrets: (x ?? {}) as Record<string, string> }
  }
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

/** The icon of a SQL dialect — for a source whose connector has none of its own (one reached by its own bridge). */
const DIALECT_ICONS: Record<string, string> = {
  suiteql: 'cib:oracle-netsuite', mssql: 'selfhst:microsoft-sql-server', tsql: 'selfhst:microsoft-sql-server', postgres: 'devicon:postgresql', postgresql: 'devicon:postgresql',
  mysql: 'logos:mysql', sqlite: 'skill-icons:sqlite', oracle: 'logos:oracle',
}
/** How a connection is shown: its connector's icon, else its dialect's, else none (it is then shown by its letters). */
export function iconOfConnection(c: { connector?: string | null; dialect?: string | null }): string | undefined {
  return (c.connector && CONNECTORS.find((k) => k.id === c.connector)?.icon) || (c.dialect && DIALECT_ICONS[c.dialect.toLowerCase()]) || undefined
}
