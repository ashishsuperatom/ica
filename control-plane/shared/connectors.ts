// ── Connectors: what can be connected, and what connecting asks for ─────────────────────────────────────────────────
//
// One kind of connector: the engine connector (connectors/bridges/<id>/), run on the engine, one process per connection.
// Each declares what it is (a SQL database, a document store, an API), the form a person fills to connect it (secret
// fields marked, so they are sealed and never shown again) and how a connection may sign in (one shared account, or each
// person's own key). One list, read by the platform (to check a connection) and the user UI (to draw its form).

import ENGINE from '../../connectors/dist/engine.json'
import { setupOf, type SetupStep } from '../../connectors/src/setup'
export type { SetupStep }

export type FieldType = 'text' | 'secret' | 'number' | 'url' | 'select' | 'textarea'
export interface ConnectorField { name: string; label: string; type: FieldType; required?: boolean; options?: string[]; help?: string; placeholder?: string
  /** Asked for only when another field has this value (e.g. { auth: 'sql' }); otherwise neither required nor kept. */
  when?: Record<string, string> }
export interface Connector {
  id: string; title: string; kind: 'sql' | 'documents' | 'rest'; description: string; levels: ('project' | 'user')[]; fields: ConnectorField[]; bridge: string | null
  /** An engine connector: its dialect, how a connection may sign in, and the hash of its current build (its version). */
  dialect?: string; identity?: ('shared' | 'person-key' | 'person-oauth')[]; version?: string
  /** A person signs in with this provider (person-oauth). */
  oauth?: { provider: string; scopes: string[] }
  /** How a person sets it up, step by step, each step proven (connectors/src/setup.ts). */
  setup?: SetupStep[]
  /** How it is shown (an iconify icon, loaded when shown). */
  icon?: string
  /** The platform's own source: in every project from its start, made and kept current by the platform — never connected
   *  or removed by people, so never offered to connect. */
  builtin?: boolean
  /** An organisation's own connector (its registry, R3): who made it, from which project; blocked by an admin. */
  org?: { madeBy: string; fromProject: string; blocked: boolean; blockedVersions: string[]; /** where its current version's code is kept */ currentFrom?: string }
}

/** A connector's catalogue entry from its manifest and the hash of its build — Superatom's (dist/engine.json) and an
 *  organisation's (its registry) alike. */
export const connectorOfManifest = (m: any, hash: string | null): Connector => ({
  id: m.id, title: m.title, kind: m.kind === 'documents' ? 'documents' : m.kind === 'api' ? 'rest' : 'sql', dialect: m.dialect, description: m.description, levels: m.levels, identity: m.identity,
  bridge: m.id, ...(hash ? { version: hash } : {}), icon: m.icon, ...(m.oauth ? { oauth: m.oauth } : {}), ...(m.builtin ? { builtin: true } : {}), fields: m.fields,
  ...(m.builtin ? {} : { setup: setupOf({ title: m.title, kind: m.kind, fields: m.fields ?? [], identity: m.identity ?? ['shared'], setup: m.setup, oauth: m.oauth }) }),
})

/** SA-WAREHOUSE: the organisation's warehouse in Superatom, a source of every project (as far as it granted the project). */
export const SA_WAREHOUSE = 'SA-WAREHOUSE'

export const CONNECTORS: Connector[] = [
  // A source the connector agent is writing a connector for: its settings and secrets — whatever the code will read —
  // given as two maps. When the code works it is published as an organisation connector (the one door) and the
  // connection moved onto it; until then it has no code to run.
  { id: 'code', title: 'Custom source (code)', kind: 'sql', description: 'A source the connector agent writes a connector for: give its settings and secrets; once the code works it is published and this connection runs it.', levels: ['project'], bridge: 'its own',
    fields: [] },
  // THE ENGINE CONNECTORS: each a folder of the connectors package (connectors/bridges/<id>/), its manifest the whole of
  // what the platform knows of it (connectors/dist/engine.json, with the hash of its build — its version).
  ...(ENGINE as any[]).map((m) => connectorOfManifest(m, m.hash)),
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
    // A field asked for only when another has a value: otherwise neither required nor kept.
    if (f.when && Object.entries(f.when).some(([k, want]) => String(values?.[k] ?? '') !== want)) continue
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
