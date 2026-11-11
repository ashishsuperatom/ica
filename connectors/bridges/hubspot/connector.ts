// HubSpot: an account's CRM — its standard objects (contacts, companies, deals, tickets, line items, products, quotes,
// and any others a connection names), its custom objects (/crm/v3/schemas), its owners, and the associations between
// records — read through the CRM API v3 with a private app's access token. Each object's fields are its properties
// (/crm/v3/properties/<object>): label, description and options; an owner property refers to owners.id. A filtered read
// goes through the search API (filterGroups, EQ); an unfiltered one lists with properties= and pages by `after`. Every
// answer but a search's carries the account's rate limits (X-HubSpot-RateLimit-*): the budget.
import { apiConnector, json, inParallel, ConnectorError, type Budget, type ConnectorContext, type Entity, type Field, type ReadResult } from '../../src/api'

const API = 'https://api.hubapi.com'
/** The CRM's standard objects read when a connection names no others. */
export const STANDARD = ['contacts', 'companies', 'deals', 'tickets', 'line_items', 'products', 'quotes']
/** A list URL longer than this is sent as a search instead (its properties in the body). */
const URL_ROOM = 6000
/** Property calls at once (HubSpot allows about ten a second for a private app). */
const AT_ONCE = 4

// ── WHAT IS KEPT FOR A CONNECTION (one per process: its context) ──────────────────────────────────────────────────────
interface Account {
  budget: Budget | null
  /** Each object's properties (by entity name), and its path in the API (a custom object's is its objectTypeId). */
  objects: Map<string, { path: string; props: Map<string, any> }>
}
const accounts = new WeakMap<ConnectorContext, Account>()
const account = (ctx: ConnectorContext): Account => { let a = accounts.get(ctx); if (!a) accounts.set(ctx, a = { budget: null, objects: new Map() }); return a }

/** X-HubSpot-RateLimit-Daily / -Daily-Remaining (the day), -Max / -Remaining / -Interval-Milliseconds (the burst). */
function noteBudget(ctx: ConnectorContext, h: Headers) {
  const num = (k: string) => { const x = h.get(`x-hubspot-ratelimit-${k}`); return x === null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x) }
  const daily = num('daily'), dailyLeft = num('daily-remaining'), max = num('max'), left = num('remaining'), every = num('interval-milliseconds')
  const burst = max !== null && left !== null ? { remaining: left, limit: max, window: every ? `${every / 1000} seconds` : 'a few seconds' } : undefined
  if (daily !== null && dailyLeft !== null) account(ctx).budget = { used: daily - dailyLeft, limit: daily, window: '1 day', ...(burst ? { burst } : {}) }
  else if (burst) account(ctx).budget = { used: burst.limit - burst.remaining, limit: burst.limit, window: burst.window }
}

/** One call to HubSpot, its budget noted; a missing scope said by name. */
async function api(ctx: ConnectorContext, path: string, body?: unknown) {
  try {
    const r = await json(ctx, `${API}${path}`, body === undefined ? {} : { body })
    noteBudget(ctx, r.headers)
    return r
  } catch (e: any) {
    const scopes = scopesIn(e?.body)
    if (e?.status === 403 && scopes.length) throw new ConnectorError(`not allowed: the token needs the scope ${scopes.join(' or ')}`, 403, e.body)
    throw e
  }
}
/** The scopes a refusal names (HubSpot's MISSING_SCOPES answer). */
const scopesIn = (b: any): string[] => [...new Set<string>((b?.errors ?? []).flatMap((x: any) => [...(x?.context?.requiredGranularScopes ?? []), ...(x?.context?.requiredScopes ?? [])]).map(String))]

// ── OBJECTS AS ENTITIES ────────────────────────────────────────────────────────────────────────────────────────────────
const TYPES: Record<string, Field['type']> = { number: 'number', bool: 'boolean', date: 'date', datetime: 'timestamp', json: 'json' }
const SAY_OPTIONS = 25
const OWNER = /_owner_id$/

/** A property as a field: its label and description; its options when few; an owner property refers to owners.id. */
export function fieldOf(p: any): Field {
  const words = [p.label, p.description].filter((x) => typeof x === 'string' && x.trim())
  const opts = (p.options ?? []).filter((o: any) => !o.hidden).map((o: any) => o.value)
  if (p.type === 'enumeration' && opts.length && opts.length <= SAY_OPTIONS) words.push(`${p.fieldType === 'checkbox' ? 'any of (joined by ;)' : 'one of'}: ${opts.join(', ')}`)
  const owner = p.referencedObjectType === 'OWNER' || (OWNER.test(p.name) && p.type !== 'datetime')
  return {
    name: p.name, type: TYPES[p.type] ?? 'string',
    ...(words.length ? { description: words.join(' — ') } : {}),
    ...(owner ? { references: 'owners.id' } : p.name === 'associatedcompanyid' ? { references: 'companies.id' } : {}),
    nullable: true,
  }
}
const ID: Field = { name: 'id', type: 'string', key: true, nullable: false, description: "The record's id (hs_object_id)" }
const entityOf = (name: string, label: string, props: any[], custom: boolean): Entity => ({
  name, label,
  description: `${label}${custom ? ' (a custom object)' : ''}. Filters are equality on its properties; "fields" names the properties to read (all but hidden ones when none).`,
  fields: [ID, ...props.filter((p) => p.name !== 'hs_object_id').map(fieldOf)],
  cursorField: props.some((p) => p.name === 'hs_lastmodifieddate') ? 'hs_lastmodifieddate' : 'lastmodifieddate',
})

const OWNERS: Entity = { name: 'owners', label: 'Owners', description: 'The people records are assigned to (hubspot_owner_id and other owner properties refer to them).', fields: [
  { name: 'id', type: 'string', key: true, nullable: false }, { name: 'email', type: 'string' }, { name: 'first_name', type: 'string' }, { name: 'last_name', type: 'string' },
  { name: 'user_id', type: 'integer', description: "The HubSpot user's id" }, { name: 'teams', type: 'string', description: "The owner's teams, comma-separated" },
  { name: 'archived', type: 'boolean' }, { name: 'created_at', type: 'timestamp' }, { name: 'updated_at', type: 'timestamp' }] }
const ASSOCIATIONS: Entity = { name: 'associations', label: 'Associations', description: 'The records one record is associated with (filters: object, id, to — e.g. deals, 123, companies).', filters: ['object', 'id', 'to'], fields: [
  { name: 'from_object', type: 'string' }, { name: 'from_id', type: 'string' }, { name: 'to_object', type: 'string' }, { name: 'to_id', type: 'string' },
  { name: 'labels', type: 'string', description: 'How they are associated (the association labels, comma-separated)' }] }

const named = (ctx: ConnectorContext) => String(ctx.settings.objects ?? '').split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)

/** Every object the token may read, described; and what it may not, with the scope it needs. */
async function discover(ctx: ConnectorContext): Promise<{ entities: Entity[]; refused: { object: string; why: string }[] }> {
  const a = account(ctx), refused: { object: string; why: string }[] = []
  const standard = [...new Set([...STANDARD, ...named(ctx)])]
  // an object type HubSpot does not know is answered 400 ("Unable to infer object type") or 404
  const why = (e: any) => (e?.status === 404 || e?.status === 400 ? 'not an object in this account' : scopesIn(e?.body).length ? `needs the scope ${scopesIn(e.body).join(' or ')}` : e?.message ?? String(e))
  const [described, schemas, owners] = await Promise.all([
    inParallel(standard, AT_ONCE, async (name) => {
      try { return { name, props: (await api(ctx, `/crm/v3/properties/${encodeURIComponent(name)}?archived=false`)).data?.results ?? [] } } catch (e: any) {
        if (e?.status === 403 || e?.status === 404 || e?.status === 400) { refused.push({ object: name, why: why(e) }); return null }
        throw e
      }
    }),
    api(ctx, '/crm/v3/schemas?archived=false').then((r) => r.data?.results ?? [], (e) => { if (e?.status === 403) { refused.push({ object: 'custom objects', why: why(e) }); return [] } throw e }),
    api(ctx, '/crm/v3/owners?limit=1').then(() => true, (e) => { if (e?.status === 403) { refused.push({ object: 'owners', why: why(e) }); return false } throw e }),
  ])
  const entities: Entity[] = []
  a.objects.clear()
  for (const d of described) if (d) {
    a.objects.set(d.name, { path: d.name, props: new Map(d.props.map((p: any) => [p.name, p])) })
    entities.push(entityOf(d.name, d.name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), d.props, false))
  }
  for (const s of schemas) {
    const name = String(s.name ?? s.objectTypeId)
    a.objects.set(name, { path: String(s.objectTypeId ?? s.fullyQualifiedName ?? name), props: new Map((s.properties ?? []).map((p: any) => [p.name, p])) })
    entities.push(entityOf(name, s.labels?.plural ?? s.labels?.singular ?? name, s.properties ?? [], true))
  }
  if (owners) entities.push(OWNERS)
  entities.push(ASSOCIATIONS)
  return { entities, refused }
}

/** An object's path and properties: kept from the last discovery, or asked for that object alone. */
async function objectOf(ctx: ConnectorContext, entity: string) {
  const a = account(ctx), held = a.objects.get(entity)
  if (held) return held
  if (!/^[a-z0-9_-]+$/i.test(entity)) throw new ConnectorError(`"${entity}" is not a HubSpot object's name`)
  try {
    const props = (await api(ctx, `/crm/v3/properties/${encodeURIComponent(entity)}?archived=false`)).data?.results ?? []
    const o = { path: entity, props: new Map<string, any>(props.map((p: any) => [p.name, p])) }
    a.objects.set(entity, o)
    return o
  } catch (e: any) {
    if (e?.status === 404 || e?.status === 400) {
      await discover(ctx)   // perhaps a custom object made since
      const found = a.objects.get(entity)
      if (found) return found
      throw new ConnectorError(`there is no object "${entity}" in this HubSpot account`, 404)
    }
    throw e
  }
}

/** A property's value as its type says (HubSpot sends every value as text). */
function valueOf(p: any, x: unknown): unknown {
  if (x === null || x === undefined || x === '') return null
  if (p?.type === 'number') { const n = Number(x); return Number.isFinite(n) ? n : x }
  if (p?.type === 'bool') return x === 'true' || x === true ? true : x === 'false' || x === false ? false : x
  return x
}

// ── READING ────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function readObject(ctx: ConnectorContext, req: { entity: string; filters?: Record<string, unknown>; fields?: string[]; since?: string | null; cursor?: string | null; limit?: number }): Promise<ReadResult> {
  const limit = req.limit ?? 100
  const o = await objectOf(ctx, req.entity)
  const has = (name: string) => o.props.has(name)
  const fields = req.fields?.length
    ? req.fields.filter((f) => f !== 'id').map((f) => { if (!has(f)) throw new ConnectorError(`${req.entity} has no property ${f}`); return f })
    : [...o.props.values()].filter((p) => !p.hidden).map((p) => String(p.name))
  const filters: { propertyName: string; operator: string; value?: string }[] = Object.entries(req.filters ?? {}).map(([k, x]) => {
    const name = k === 'id' ? 'hs_object_id' : k
    if (!has(name)) throw new ConnectorError(`${req.entity} has no property ${k} to filter on`)
    return x === null ? { propertyName: name, operator: 'NOT_HAS_PROPERTY' } : { propertyName: name, operator: 'EQ', value: String(x) }
  })
  if (req.since) {
    const t = Date.parse(req.since)
    if (!Number.isFinite(t)) throw new ConnectorError(`since is a date and time (2026-01-31T00:00:00Z), not "${req.since}"`)
    filters.push({ propertyName: has('hs_lastmodifieddate') ? 'hs_lastmodifieddate' : 'lastmodifieddate', operator: 'GTE', value: String(t) })
  }
  const props = fields.join(','), rows: Record<string, unknown>[] = []
  let after: string | null = req.cursor ?? null, total: number | null = null
  const rowOf = (r: any) => {
    const out: Record<string, unknown> = { id: String(r.id) }
    for (const f of fields) out[f] = valueOf(o.props.get(f), r.properties?.[f])
    return out
  }
  // Filtered, or too many properties for a URL: the search API (at most 200 a page, 10,000 in all).
  if (filters.length || props.length > URL_ROOM) {
    do {
      const body = { filterGroups: filters.length ? [{ filters }] : [], properties: fields, limit: Math.min(200, limit - rows.length), ...(after ? { after } : {}), ...(req.since ? { sorts: [{ propertyName: filters.at(-1)!.propertyName, direction: 'ASCENDING' }] } : {}) }
      const { data } = await api(ctx, `/crm/v3/objects/${encodeURIComponent(o.path)}/search`, body)
      total ??= typeof data?.total === 'number' ? data.total : null
      rows.push(...(data?.results ?? []).map(rowOf))
      after = data?.paging?.next?.after ?? null
    } while (after && rows.length < limit)
    return { rows: rows.slice(0, limit), next: after, total }
  }
  do {
    const q = new URLSearchParams({ limit: String(Math.min(100, limit - rows.length)), archived: 'false', ...(props ? { properties: props } : {}), ...(after ? { after } : {}) })
    const { data } = await api(ctx, `/crm/v3/objects/${encodeURIComponent(o.path)}?${q}`)
    rows.push(...(data?.results ?? []).map(rowOf))
    after = data?.paging?.next?.after ?? null
  } while (after && rows.length < limit)
  return { rows: rows.slice(0, limit), next: after, total }
}

async function readOwners(ctx: ConnectorContext, req: { cursor?: string | null; limit?: number; filters?: Record<string, unknown> }): Promise<ReadResult> {
  const limit = req.limit ?? 100, rows: Record<string, unknown>[] = []
  let after: string | null = req.cursor ?? null
  const email = req.filters?.email
  do {
    const q = new URLSearchParams({ limit: String(Math.min(100, limit - rows.length)), ...(email ? { email: String(email) } : {}), ...(after ? { after } : {}) })
    const { data } = await api(ctx, `/crm/v3/owners?${q}`)
    rows.push(...(data?.results ?? []).map((o: any) => ({ id: String(o.id), email: o.email ?? null, first_name: o.firstName ?? null, last_name: o.lastName ?? null, user_id: o.userId ?? null, teams: (o.teams ?? []).map((t: any) => t.name).join(', ') || null, archived: o.archived ?? false, created_at: o.createdAt ?? null, updated_at: o.updatedAt ?? null })))
    after = data?.paging?.next?.after ?? null
  } while (after && rows.length < limit)
  return { rows: rows.slice(0, limit), next: after }
}

async function readAssociations(ctx: ConnectorContext, req: { filters?: Record<string, unknown>; cursor?: string | null; limit?: number }): Promise<ReadResult> {
  const f = req.filters ?? {}
  if (!f.object || !f.id || !f.to) throw new ConnectorError('associations needs filters object, id and to (e.g. {"object": "deals", "id": "123", "to": "companies"})')
  const [from, to] = await Promise.all([objectOf(ctx, String(f.object)), objectOf(ctx, String(f.to))])
  const limit = req.limit ?? 100, rows: Record<string, unknown>[] = []
  let after: string | null = req.cursor ?? null
  do {
    const q = new URLSearchParams({ limit: String(Math.min(500, limit - rows.length)), ...(after ? { after } : {}) })
    const { data } = await api(ctx, `/crm/v4/objects/${encodeURIComponent(from.path)}/${encodeURIComponent(String(f.id))}/associations/${encodeURIComponent(to.path)}?${q}`)
    rows.push(...(data?.results ?? []).map((r: any) => ({ from_object: String(f.object), from_id: String(f.id), to_object: String(f.to), to_id: String(r.toObjectId), labels: (r.associationTypes ?? []).map((t: any) => t.label || `${String(t.category ?? '').toLowerCase()} ${t.typeId}`.trim()).join(', ') || null })))
    after = data?.paging?.next?.after ?? null
  } while (after && rows.length < limit)
  return { rows: rows.slice(0, limit), next: after }
}

const n = (x: number) => x.toLocaleString('en')
const budgetWords = (b: Budget | null) => (!b ? '' : b.window === '1 day' ? `; calls left today: ${n(b.limit - b.used)} of ${n(b.limit)}` : `; calls left in this ${b.window}: ${n(b.limit - b.used)} of ${n(b.limit)}`)

export const createBridge = apiConnector('hubspot', {
  description: 'HubSpot CRM: contacts, companies, deals, tickets, line items, products, quotes, custom objects, owners, and associations between records. Each object\'s fields are its properties; owner properties refer to owners.id. '
    + 'Filters are equality on properties ({"lifecyclestage": "customer"}); "fields" names the properties to read.',
  headers: ({ secrets }) => (secrets.token ? { authorization: `Bearer ${String(secrets.token).trim()}` } : {}),
  requires: ['token'],
  async test(ctx) {
    try {
      const { data } = await api(ctx, '/account-info/v3/details')
      return `signed in to HubSpot account ${data?.portalId ?? '?'}${data?.accountType ? ` (${String(data.accountType).toLowerCase()})` : ''}${budgetWords(account(ctx).budget)}`
    } catch (e: any) {
      if (e?.status !== 403) throw e
      // The token is good but may not read the account's details: read one owner, or one contact, to prove it reads.
      await api(ctx, '/crm/v3/objects/contacts?limit=1').catch(() => api(ctx, '/crm/v3/owners?limit=1'))
      return `signed in to HubSpot${budgetWords(account(ctx).budget)}`
    }
  },
  entities: async (ctx) => (await discover(ctx)).entities,
  read: { owners: readOwners, associations: readAssociations, '*': readObject },
  budget: (ctx) => account(ctx).budget,
  checks: {
    /** The objects the token may read, and those it may not (with the scope each needs). */
    async objects(ctx) {
      const { entities, refused } = await discover(ctx)
      const objects = entities.filter((e) => e.name !== 'associations' && e.name !== 'owners').map((e) => e.name)
      const unknown = refused.filter((r) => named(ctx).includes(r.object) && r.why === 'not an object in this account')
      if (unknown.length) throw new ConnectorError(`no object named ${unknown.map((r) => r.object).join(', ')} in this HubSpot account`)
      if (!objects.length) throw new ConnectorError(`the token may read no CRM object (${refused.map((r) => `${r.object}: ${r.why}`).join('; ')})`)
      return `reads ${n(objects.length)} objects: ${objects.join(', ')}${refused.length ? `. Not readable with this token: ${refused.map((r) => `${r.object} (${r.why})`).join('; ')}` : ''}${budgetWords(account(ctx).budget)}`
    },
  },
})
