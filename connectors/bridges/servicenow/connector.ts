// ServiceNow: an instance's tables — the usual ITSM, catalog, CMDB, people and knowledge tables, and any others a
// connection names — read through the Table API. Each table's fields come from the dictionary (sys_dictionary), along its
// line of parents in sys_db_object (incident extends task: its fields are task's and its own): label, type, the table a
// reference points to, mandatory, and sys_id its key. A read builds an encoded query (sysparm_query) from equality
// filters, safely escaped, and may add a condition of the connection's own; it pages by sysparm_offset in a stable order.
// Values are read raw by default (sysparm_display_value=false): sys_ids, choice values and UTC times join and compare
// exactly, where display values are labels and local times that change with the reader's language and time zone.
import { apiConnector, json, cachedToken, inParallel, ConnectorError, type Budget, type ConnectorContext, type Entity, type Field, type ReadResult } from '../../src/api'

/** The tables read when a connection names no others. */
export const DEFAULT_TABLES = ['incident', 'problem', 'change_request', 'change_task', 'sc_request', 'sc_req_item', 'sc_task', 'task', 'task_sla',
  'cmdb_ci', 'cmdb_ci_server', 'cmdb_rel_ci', 'sys_user', 'sys_user_group', 'sys_user_grmember', 'cmn_location', 'cmn_department', 'core_company', 'kb_knowledge']
/** Rows asked for in one call (the Table API allows more; smaller pages keep each answer quick). */
const PAGE = 1000
const TABLE = /^[a-z0-9_]+$/, SYS_ID = /^[0-9a-f]{32}$/

/** The instance's address, from whatever was pasted: https://acme.service-now.com/now/nav/…, acme.service-now.com, or
 *  just acme. A custom domain is kept as it is. */
export function instanceUrl(pasted: unknown): string {
  const raw = String(pasted ?? '').trim()
  if (!raw) throw new ConnectorError('give the instance (e.g. acme.service-now.com)')
  let host = raw.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0].toLowerCase()
  if (!host.includes('.')) host = `${host}.service-now.com`
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/.test(host)) throw new ConnectorError(`"${raw}" is not an instance's address (e.g. acme.service-now.com)`)
  return `https://${host}`
}

// ── WHAT IS KEPT FOR A CONNECTION (one per process: its context) ──────────────────────────────────────────────────────
interface Instance { budget: Budget | null; tables: Map<string, Described> }
interface Described { name: string; label: string; parent: string | null; fields: Map<string, any> }
const instances = new WeakMap<ConnectorContext, Instance>()
const instance = (ctx: ConnectorContext): Instance => { let i = instances.get(ctx); if (!i) instances.set(ctx, i = { budget: null, tables: new Map() }); return i }

/** X-RateLimit-Limit / -Remaining: sent when a rate limit rule applies to the user (per hour). */
function noteBudget(ctx: ConnectorContext, h: Headers) {
  const limit = Number(h.get('x-ratelimit-limit')), left = Number(h.get('x-ratelimit-remaining'))
  if (h.get('x-ratelimit-limit') && Number.isFinite(limit) && Number.isFinite(left)) instance(ctx).budget = { used: limit - left, limit, window: '1 hour' }
}

const oauth = (ctx: ConnectorContext) => ctx.settings.auth === 'oauth'
/** OAuth client credentials (/oauth_token.do): a token for the OAuth application's user, kept until refused. */
const token = cachedToken(async (ctx) => {
  if (!ctx.settings.clientId || !ctx.secrets.clientSecret) throw new ConnectorError("give the OAuth application's client id and client secret")
  try {
    const { data } = await json(ctx, `${instanceUrl(ctx.settings.instance)}/oauth_token.do`, { form: { grant_type: 'client_credentials', client_id: String(ctx.settings.clientId).trim(), client_secret: String(ctx.secrets.clientSecret).trim() }, retries: 1 })
    if (!data?.access_token) throw new ConnectorError('ServiceNow answered the sign-in without a token')
    return { token: String(data.access_token) }
  } catch (e: any) {
    if (!(e instanceof ConnectorError) || !e.status || e.status >= 500) throw e
    const b: any = e.body
    const said = b && typeof b === 'object' ? [b.error, b.error_description].filter(Boolean).join(': ') : ''
    throw new ConnectorError(`ServiceNow refused the sign-in${said ? ` (${said})` : ` (${e.message})`}`, e.status, e.body)
  }
})

/** One Table API call (a path and its parameters), signed in; its budget noted. */
async function api(ctx: ConnectorContext, path: string, params: Record<string, string> = {}) {
  if (!oauth(ctx) && (!ctx.settings.user || !ctx.secrets.password)) throw new ConnectorError("give the integration user's name and password")
  const url = `${instanceUrl(ctx.settings.instance)}${path}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`
  const go = async (headers: Record<string, string>) => { const r = await json(ctx, url, { headers }); noteBudget(ctx, r.headers); return r }
  return oauth(ctx) ? token.with(ctx, (t) => go({ authorization: `Bearer ${t.token}` })) : go({})
}
/** Every row of a Table API query, page by page (it is ordered by sys_id, so pages neither skip nor repeat). */
async function all(ctx: ConnectorContext, table: string, query: string, fields: string): Promise<any[]> {
  const out: any[] = []
  for (let offset = 0; ; offset += PAGE) {
    const { data } = await api(ctx, `/api/now/table/${table}`, { sysparm_query: `${query}^ORDERBYsys_id`, sysparm_fields: fields, sysparm_exclude_reference_link: 'true', sysparm_limit: String(PAGE), sysparm_offset: String(offset) })
    const rows = data?.result ?? []
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

// ── TABLES AS ENTITIES: sys_db_object (each table and its parent) and sys_dictionary (its fields) ─────────────────────
const tablesNamed = (ctx: ConnectorContext) => String(ctx.settings.tables ?? '').split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
const wanted = (ctx: ConnectorContext) => [...new Set([...DEFAULT_TABLES, ...tablesNamed(ctx)])]

/** The tables named, each with its fields along its line of parents; and those not found. */
async function describeTables(ctx: ConnectorContext, names: string[]): Promise<{ found: Described[]; missing: string[] }> {
  for (const t of names) if (!TABLE.test(t)) throw new ConnectorError(`"${t}" is not a table's name (e.g. incident, u_vendor)`)
  // the tables, then their parents, until the top
  const byId = new Map<string, any>()
  let rows = await all(ctx, 'sys_db_object', `nameIN${names.join(',')}`, 'sys_id,name,label,super_class')
  while (rows.length) {
    for (const r of rows) byId.set(r.sys_id, r)
    const parents = [...new Set(rows.map((r) => r.super_class).filter((id) => id && !byId.has(id)))]
    rows = parents.length ? await all(ctx, 'sys_db_object', `sys_idIN${parents.join(',')}`, 'sys_id,name,label,super_class') : []
  }
  const byName = new Map([...byId.values()].map((r) => [String(r.name), r]))
  const missing = names.filter((t) => !byName.has(t))
  if (missing.length === names.length) throw new ConnectorError(`found none of the tables (${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}): the user may not read the list of tables (sys_db_object)`)
  // their fields, from the dictionary, for every table on those lines
  const dict = await all(ctx, 'sys_dictionary', `nameIN${[...byName.keys()].join(',')}^elementISNOTEMPTY^active=true`, 'name,element,column_label,internal_type,reference,mandatory,primary,comments')
  if (!dict.length) throw new ConnectorError('the user may not read the dictionary (sys_dictionary), where each table\'s fields are described')
  // a reference given as the referenced table's sys_id rather than its name: named
  const ids = [...new Set(dict.map((d) => d.reference).filter((x) => SYS_ID.test(x ?? '')))]
  const refNames = new Map<string, string>()
  if (ids.length) for (const r of await all(ctx, 'sys_db_object', `sys_idIN${ids.join(',')}`, 'sys_id,name')) refNames.set(r.sys_id, r.name)
  const own = new Map<string, any[]>()
  for (const d of dict) { const list = own.get(d.name) ?? []; list.push({ ...d, reference: refNames.get(d.reference) ?? d.reference }); own.set(d.name, list) }
  const lineOf = (t: string): string[] => { const out: string[] = []; let r = byName.get(t); while (r && !out.includes(r.name)) { out.unshift(r.name); r = r.super_class ? byId.get(r.super_class) : undefined } return out }
  const found = names.filter((t) => byName.has(t)).map((t) => {
    const fields = new Map<string, any>()
    for (const table of lineOf(t)) for (const d of own.get(table) ?? []) fields.set(d.element, d)   // a child's own entry over its parent's
    const r = byName.get(t), parent = r.super_class ? byId.get(r.super_class)?.name ?? null : null
    const described = { name: t, label: String(r.label || t), parent, fields }
    instance(ctx).tables.set(t, described)
    return described
  })
  return { found, missing }
}

const TYPES: Record<string, Field['type']> = { integer: 'integer', longint: 'integer', decimal: 'number', float: 'number', boolean: 'boolean', glide_date: 'date', glide_date_time: 'timestamp', due_date: 'timestamp', date_time: 'timestamp' }
const typeOf = (d: any): Field['type'] => TYPES[String(d.internal_type)] ?? 'string'
export function fieldOf(d: any): Field {
  const key = d.primary === 'true' || d.primary === true || d.element === 'sys_id'
  const words = [d.column_label, d.comments].filter((x) => typeof x === 'string' && x.trim())
  return {
    name: d.element, type: typeOf(d),
    ...(words.length ? { description: words.join(' — ') } : {}),
    ...(key ? { key: true } : {}),
    ...(d.internal_type === 'reference' && d.reference ? { references: `${d.reference}.sys_id` } : {}),
    nullable: !key && !(d.mandatory === 'true' || d.mandatory === true),
  }
}
const entityOf = (t: Described): Entity => ({
  name: t.name, label: t.label,
  description: `${t.label}${t.parent ? ` (extends ${t.parent})` : ''}. Filters are equality on its fields; "query" adds an encoded query (active=true^priority<=2); "fields" names the fields to read.`,
  fields: [...t.fields.values()].map(fieldOf),
  ...(t.fields.has('sys_updated_on') ? { cursorField: 'sys_updated_on' } : {}),
})

async function tableOf(ctx: ConnectorContext, name: string): Promise<Described> {
  const held = instance(ctx).tables.get(name)
  if (held) return held
  if (!TABLE.test(name)) throw new ConnectorError(`"${name}" is not a table's name (e.g. incident, u_vendor)`)
  const { found } = await describeTables(ctx, [name]).catch((e) => { if (/found none of the tables/.test(e?.message)) throw new ConnectorError(`there is no table "${name}" this user may read`, 404); throw e })
  return found[0]
}

// ── READING ────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A filter value in an encoded query: a caret doubled (one would start the next condition). */
export const escapeValue = (s: string) => s.replace(/\^/g, '^^')

/** A condition's field names checked against the table: ServiceNow ignores a condition naming a field it does not have,
 *  and would then read every row. ORDERBY and ServiceNow's own upper-case keywords pass. */
export function checkQuery(t: Described, query: string) {
  // a doubled caret is part of a value; ^OR and ^NQ start a condition as ^ does (but ^ORDERBY is an order)
  for (const part of query.replace(/\^\^/g, '\u0000').split(/\^(?:OR(?!DERBY)|NQ)?/)) {
    const s = part.trim()
    if (!s) continue
    const order = /^ORDERBY(?:DESC)?([a-z0-9_.]+)$/.exec(s)
    const field = order ? order[1] : /^([a-z_][a-z0-9_]*(?:\.[a-z0-9_]+)*)/.exec(s)?.[1]
    if (!field) continue
    if (!t.fields.has(field.split('.')[0])) throw new ConnectorError(`${t.name} has no field ${field.split('.')[0]} (in "${s}")`)
  }
}

/** A raw value as its field's type says (the Table API sends every value as text; empty is ""). */
function valueOf(type: Field['type'] | undefined, x: unknown, raw: boolean): unknown {
  if (x === '' || x === null || x === undefined) return null
  if (!raw || typeof x !== 'string') return x
  if (type === 'integer' || type === 'number') { const n = Number(x); return Number.isFinite(n) ? n : x }
  if (type === 'boolean') return x === 'true' ? true : x === 'false' ? false : x
  return x
}

/** A time as the Table API writes one (UTC: 2026-01-31 09:00:00). */
const glideTime = (iso: string) => { const t = Date.parse(iso); if (!Number.isFinite(t)) throw new ConnectorError(`since is a date and time (2026-01-31T00:00:00Z), not "${iso}"`); return new Date(t).toISOString().slice(0, 19).replace('T', ' ') }

async function read(ctx: ConnectorContext, req: { entity: string; filters?: Record<string, unknown>; fields?: string[]; query?: string; since?: string | null; cursor?: string | null; limit?: number }): Promise<ReadResult> {
  const limit = req.limit ?? 100
  const t = await tableOf(ctx, req.entity)
  const field = (f: string, what: string) => { if (!/^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(f) || !t.fields.has(f.split('.')[0])) throw new ConnectorError(`${t.name} has no field ${f}${what}`); return f }
  const conds = Object.entries(req.filters ?? {}).map(([k, x]) => {
    field(k, ' to filter on')
    if (x === null) return `${k}ISEMPTY`
    const s = String(x)
    if (/^javascript:/i.test(s)) throw new ConnectorError('a filter is a value; a script condition goes in "query"')
    return `${k}=${escapeValue(s)}`
  })
  if (req.query) {
    if (conds.length && /\^NQ/.test(req.query)) throw new ConnectorError('a query with ^NQ (a second query) cannot be joined with filters: put the filters in the query')
    checkQuery(t, req.query)
    conds.push(req.query)
  }
  if (req.since) { field('sys_updated_on', ' to read changes from'); conds.push(`sys_updated_on>${glideTime(req.since)}`) }
  if (!conds.some((c) => /(^|\^)ORDERBY/.test(c))) conds.push(req.since ? 'ORDERBYsys_updated_on^ORDERBYsys_id' : 'ORDERBYsys_id')
  const fields = req.fields?.length ? req.fields.map((f) => field(f, '')) : null
  const raw = String(ctx.settings.displayValue ?? 'false') !== 'true'
  const rows: Record<string, unknown>[] = []
  let offset = Number(req.cursor ?? 0), total: number | null = null
  if (!Number.isInteger(offset) || offset < 0) throw new ConnectorError('a cursor is the offset a read gave')
  for (;;) {
    const page = Math.min(PAGE, limit - rows.length)
    const { data, headers } = await api(ctx, `/api/now/table/${t.name}`, {
      sysparm_query: conds.join('^'), ...(fields ? { sysparm_fields: fields.join(',') } : {}), sysparm_display_value: raw ? 'false' : 'true',
      sysparm_exclude_reference_link: 'true', sysparm_limit: String(page), sysparm_offset: String(offset),
    })
    const total_ = Number(headers.get('x-total-count'))
    if (total === null && headers.get('x-total-count') && Number.isFinite(total_)) total = total_
    const got: any[] = data?.result ?? []
    rows.push(...got.map((r) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, valueOf(t.fields.get(k) ? typeOf(t.fields.get(k)) : undefined, x, raw)]))))
    offset += got.length
    if (got.length < page || rows.length >= limit) return { rows: rows.slice(0, limit), next: got.length < page ? null : String(offset), total }
  }
}

const n = (x: number) => x.toLocaleString('en')
const host = (ctx: ConnectorContext) => instanceUrl(ctx.settings.instance).replace('https://', '')

export const createBridge = apiConnector('servicenow', {
  description: 'ServiceNow: incidents, problems, changes, requests and catalog tasks, the CMDB, users and groups, locations, knowledge — each table with its fields from the dictionary (references as <table>.sys_id). '
    + 'Values are raw (sys_ids, choice values, UTC times) unless the connection reads display values.',
  headers: ({ settings, secrets }) => (settings.auth !== 'oauth' && settings.user && secrets.password ? { authorization: `Basic ${Buffer.from(`${String(settings.user).trim()}:${secrets.password}`).toString('base64')}` } : {}),
  requires: ['instance'],
  async test(ctx) {
    const { data } = await api(ctx, '/api/now/table/sys_user', { sysparm_query: 'sys_id=javascript:gs.getUserID()', sysparm_fields: 'user_name,name', sysparm_limit: '1' })
    const me = data?.result?.[0]
    const b = instance(ctx).budget
    return `signed in to ${host(ctx)}${me?.user_name ? ` as ${me.user_name}${me.name ? ` (${me.name})` : ''}` : ''}${b ? `; calls left this hour: ${n(b.limit - b.used)} of ${n(b.limit)}` : ''}`
  },
  entities: async (ctx) => (await describeTables(ctx, wanted(ctx))).found.map(entityOf),
  read: { '*': read },
  budget: (ctx) => instance(ctx).budget,
  checks: {
    /** The instance answers its Table API (a refusal for want of a sign-in counts: it answered); asleep, it says so. */
    async instance(ctx) {
      const r = await ctx.fetch(`${instanceUrl(ctx.settings.instance)}/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id`, { headers: { accept: 'application/json' } })
      const text = await r.text()
      if (/hibernat/i.test(text)) throw new ConnectorError(`${host(ctx)} is hibernating`)
      if (!/json/i.test(r.headers.get('content-type') ?? '') || (r.status !== 200 && r.status !== 401 && r.status !== 403)) throw new ConnectorError(`${host(ctx)} answered ${r.status}, but not as a ServiceNow instance does`)
      return `${host(ctx)} answers`
    },
    /** The tables it will read: each found in the dictionary, and a row of each read (its read roles proven). */
    async tables(ctx) {
      const { found, missing } = await describeTables(ctx, wanted(ctx))
      const named = missing.filter((t) => tablesNamed(ctx).includes(t))
      if (named.length) throw new ConnectorError(`no table named ${named.join(', ')} that this user may see`)
      const tried = await inParallel(found, 4, async (t) => {
        try { await api(ctx, `/api/now/table/${t.name}`, { sysparm_limit: '1', sysparm_fields: 'sys_id' }); return null } catch (e: any) {
          if (e?.status === 403 || e?.status === 401) return `${t.name} (${e.message})`
          throw e
        }
      })
      const refused = tried.filter(Boolean) as string[]
      const readable = found.length - refused.length
      if (!readable) throw new ConnectorError(`the user may read none of the tables: ${refused.join('; ')}`)
      return `reads ${n(readable)} tables: ${found.filter((_, i) => !tried[i]).map((t) => t.name).join(', ')}${refused.length ? `. Not allowed: ${refused.join('; ')}` : ''}${missing.length ? `. Not on this instance: ${missing.join(', ')}` : ''}`
    },
  },
})
