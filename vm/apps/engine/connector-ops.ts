// ── A CONNECTION, USED BY A PERSON (the user UI's connection page) ──────────────────────────────────────────────────
//
// One kind of connector (docs/connectors-plan.md R1): whatever it reaches — a database, a document store, an API — a
// connection is tested, described, read and (an API's) acted on here, through the datasource manager, AS THE ONE ASKING:
// their ticket goes with every read, so their data access applies and a source that reads with each person's own key
// reads with theirs. An action that changes the other system runs only when a person confirmed it — an agent never can.
//
//   connector:test        does it work (signed in, a trivial read)
//   connector:introspect  what it offers: its entities (tables, collections, an API's resources) and actions
//   connector:read        the first rows of one entity, narrowed by its filters
//   connector:act         one of its actions, with its input (a change: confirmed by a person)

import { asSystem } from './manager.js'
import { dialectOf } from '../../../clients/explore.js'

export const CONNECTOR_OPS = new Set(['connector:test', 'connector:introspect', 'connector:read', 'connector:act'])

type Source = { id: string; kind: string; dialect?: string | null; acts?: boolean }
interface Described { tables?: { name: string; description?: string; columns?: { name: string; type?: string }[]; filters?: string[] }[]; actions?: { name: string; label?: string; effect?: string; confirm?: boolean }[] }

export function createConnectorOps(o: {
  manager: string
  /** The connection's name on the engine, from the platform's id of it. */
  nameOf: (connection: string) => string | null
  /** The asker's ticket (their data access; who they are). */
  ticketOf: (from: unknown) => Promise<string>
  sourceOf: (name: string) => Promise<Source | null>
}) {
  const call = async (path: string, body: unknown, ticket: string | null): Promise<any> => {
    const init = { method: 'POST', headers: { 'content-type': 'application/json', ...(ticket ? { 'x-sa-ticket': ticket } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(200_000) }
    const r = await fetch(`${o.manager}${path}`, ticket ? init : asSystem(init))
    const d: any = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(d?.error ?? `the connection did not answer (${r.status})`)
    return d
  }
  /** What it offers, as its connector describes it (the shared connection's description: the same for everyone). */
  const describe = async (name: string): Promise<Described> => call('/introspect', { id: name }, null)

  async function handle(p: any, from: unknown): Promise<Record<string, unknown>> {
    const op = String(p.t).slice('connector:'.length)
    const name = o.nameOf(String(p.connection ?? ''))
    if (!name) return { t: 'connector:refused', reason: 'there is no such connection on the engine' }
    const src = await o.sourceOf(name)
    if (!src) return { t: 'connector:refused', reason: `${name} is not loaded on the engine yet` }
    try {
      if (op === 'test') {
        const r = await call('/test', { id: name }, await o.ticketOf(from))
        return { t: 'connector:result', result: { ok: !!r.ok, message: r.ok ? r.said : r.error } }
      }
      if (op === 'introspect') {
        const d = await describe(name)
        return { t: 'connector:result', result: {
          entities: (d.tables ?? []).map((t) => ({ name: t.name, description: t.description, fields: (t.columns ?? []).map((c) => ({ name: c.name, type: c.type ?? 'string' })), ...(t.filters ? { filters: t.filters } : {}) })),
          actions: d.actions ?? [] } }
      }
      if (op === 'read') {
        const entity = String(p.entity ?? '')
        if (!entity) return { t: 'connector:refused', reason: 'what to read?' }
        const limit = Math.max(1, Math.min(Number(p.limit) || 20, 100))
        const filters = p.filters && typeof p.filters === 'object' ? Object.fromEntries(Object.entries(p.filters).filter(([, v]) => v !== '' && v !== null && v !== undefined)) : {}
        // the first rows, in the connection's own query language
        const sql = src.kind === 'sql' ? (() => { const d = dialectOf(src.dialect ?? null); return d.firstN(`SELECT * FROM ${d.id(entity)}`, limit) })()
          : src.kind === 'documents' ? JSON.stringify({ collection: entity, find: filters, limit })
          : JSON.stringify({ entity, filters, limit })
        const r = await call('/query', { id: name, sql }, await o.ticketOf(from))
        return { t: 'connector:result', result: { rows: (r.rows ?? []).slice(0, limit) } }
      }
      if (op === 'act') {
        if (!src.acts) return { t: 'connector:refused', reason: `${name} does no actions` }
        const action = String(p.action ?? '')
        const spec = (await describe(name)).actions?.find((a) => a.name === action)
        if (!spec) return { t: 'connector:refused', reason: `${name} has no action "${action}"` }
        const agent = (from as any)?.type === 'agent'
        if ((spec.effect !== 'read' || spec.confirm) && !(p.confirmed === true && !agent))
          return { t: 'connector:refused', reason: `${spec.label ?? spec.name} ${spec.effect === 'irreversible' ? 'cannot be undone' : 'changes'} ${name}: a person confirms it before it runs` }
        const r = await call('/act', { id: name, action, input: p.input ?? {} }, await o.ticketOf(from))
        if (r?.ok === false) return { t: 'connector:refused', reason: r.message ?? 'it did not do it' }
        return { t: 'connector:result', result: r }
      }
      return { t: 'connector:refused', reason: `there is no connector operation "${op}"` }
    } catch (e: any) { return { t: 'connector:refused', reason: e?.message ?? String(e) } }
  }
  return { handle }
}
