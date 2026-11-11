// Salesforce: the objects an org's run-as user may read (describeGlobal), each described by its own describe — labels,
// help text, lookups, picklist values — and read with SOQL, built from a query's filters or given whole ({"soql": …}).
// It signs in with OAuth 2.0 client credentials of an External Client App (or a Connected App): a token for the app's
// run-as user, kept until Salesforce refuses it. Every call spends the org's API budget (Sforce-Limit-Info on each
// answer: calls used in the last 24 hours, of how many), so describes are made only when needed, kept, a few at a time,
// and asked again only when describeGlobal says something changed (If-Modified-Since); and describing stops before it
// spends the share of the budget kept for questions.
import { apiConnector, json, cachedToken, inParallel, ConnectorError, type Budget, type ConnectorContext, type Entity, type Field, type ReadResult } from '../../src/api'

/** The API version when none is set: old enough that every org has it, new enough for everything read here. */
export const DEFAULT_VERSION = '62.0'
/** Describes at once: enough to be quick, few enough not to crowd the org's concurrent-request limit. */
const DESCRIBE_AT_ONCE = 4

/** The org's My Domain address, from whatever was pasted: a Lightning URL (acme.lightning.force.com/…), a
 *  my.salesforce.com or Setup URL, or just its name (acme, acme--uat.sandbox). */
export function myDomain(pasted: unknown): string {
  const raw = String(pasted ?? '').trim()
  if (!raw) throw new ConnectorError("give the org's My Domain (Setup → My Domain shows it, e.g. acme.my.salesforce.com)")
  let host = raw.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0].replace(/:\d+$/, '').toLowerCase()
  if (/^(login|test)\.salesforce\.com$/.test(host)) throw new ConnectorError(`${host} cannot sign in an app with client credentials: give the org's own My Domain (Setup → My Domain shows it, e.g. acme.my.salesforce.com)`)
  if (!host.includes('.') || /^[a-z0-9-]+\.(sandbox|develop|scratch|demo|patch|trailblaze)$/.test(host)) host = `${host}.my.salesforce.com`
  host = host.replace(/\.lightning\.force\.com$/, '.my.salesforce.com').replace(/\.my\.salesforce-setup\.com$/, '.my.salesforce.com').replace(/\.my\.site\.com$/, '.my.salesforce.com')
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.my\.salesforce\.(com|mil)$/.test(host)) throw new ConnectorError(`"${raw}" is not a Salesforce My Domain address (it ends in .my.salesforce.com; Setup → My Domain shows it)`)
  return `https://${host}`
}

/** The API version as Salesforce writes it in a path (62.0), from 62, 62.0 or v62.0. */
export function versionOf(v: unknown): string {
  const s = String(v ?? '').trim().replace(/^v/i, '') || DEFAULT_VERSION
  if (!/^\d{2,3}(\.0)?$/.test(s)) throw new ConnectorError(`"${v}" is not a Salesforce API version (e.g. ${DEFAULT_VERSION})`)
  return s.includes('.') ? s : `${s}.0`
}

// ── WHAT IS KEPT FOR A CONNECTION (one per process: its context) ──────────────────────────────────────────────────────
interface Org {
  budget: Budget | null
  /** describeGlobal's objects, and Salesforce's time when they were read (for If-Modified-Since). */
  global: { at: string; objects: any[] } | null
  /** Each object's describe, and when it was read. */
  described: Map<string, { at: string; d: any }>
}
const orgs = new WeakMap<ConnectorContext, Org>()
const org = (ctx: ConnectorContext): Org => { let o = orgs.get(ctx); if (!o) orgs.set(ctx, o = { budget: null, global: null, described: new Map() }); return o }

/** Sforce-Limit-Info: "api-usage=25/15000" — calls used in the last 24 hours, of how many. */
function noteBudget(ctx: ConnectorContext, headers: Headers) {
  const m = /api-usage=(\d+)\/(\d+)/.exec(headers.get('sforce-limit-info') ?? '')
  if (m) org(ctx).budget = { used: Number(m[1]), limit: Number(m[2]), window: '24 hours' }
}

const token = cachedToken(async (ctx) => {
  const base = myDomain(ctx.settings.domain)
  if (!ctx.settings.clientId || !ctx.secrets.clientSecret) throw new ConnectorError("give the app's Consumer Key and Consumer Secret")
  try {
    const { data } = await json(ctx, `${base}/services/oauth2/token`, { form: { grant_type: 'client_credentials', client_id: String(ctx.settings.clientId).trim(), client_secret: String(ctx.secrets.clientSecret).trim() }, retries: 1 })
    if (!data?.access_token) throw new ConnectorError('Salesforce answered the sign-in without a token')
    return { token: String(data.access_token), instance: String(data.instance_url || base).replace(/\/+$/, '') }
  } catch (e: any) {
    if (!(e instanceof ConnectorError) || !e.status || e.status >= 500) throw e
    const b: any = e.body
    const said = b && typeof b === 'object' ? [b.error, b.error_description].filter(Boolean).join(': ') : ''
    throw new ConnectorError(`Salesforce refused the sign-in${said ? ` (${said})` : ` (${e.message})`}`, e.status, e.body)
  }
})

/** One call to the org's API, signed in; its budget noted. A path (/services/data/…) or the org's own URL. */
async function api(ctx: ConnectorContext, path: string, headers: Record<string, string> = {}) {
  return token.with(ctx, async (t) => {
    const r = await json(ctx, path.startsWith('https://') ? path : `${t.instance}${path}`, { headers: { authorization: `Bearer ${t.token}`, ...headers } })
    noteBudget(ctx, r.headers)
    return r
  })
}
const v = (ctx: ConnectorContext) => `/services/data/v${versionOf(ctx.settings.apiVersion)}`
const seenAt = (headers: Headers) => headers.get('date') ?? new Date().toUTCString()

/** describeGlobal: every object the run-as user may see. Asked again only if-modified-since the last answer; says
 *  whether anything changed. */
async function readGlobal(ctx: ConnectorContext): Promise<{ objects: any[]; changed: boolean }> {
  const o = org(ctx)
  try {
    const r = await api(ctx, `${v(ctx)}/sobjects`, o.global ? { 'if-modified-since': o.global.at } : {})
    o.global = { at: seenAt(r.headers), objects: r.data?.sobjects ?? [] }
    return { objects: o.global.objects, changed: true }
  } catch (e: any) {
    if (e?.status === 304 && o.global) return { objects: o.global.objects, changed: false }
    throw e
  }
}

// What an org holds that is not business data: sharing rows, field history, feeds, change events, tags, custom
// settings and metadata, big objects, and Setup's own records (code, permissions, logs). Indexed only when named.
const PLUMBING_END = /(Share|History|Feed|ChangeEvent|Tag|__hd|__mdt|__b|__e)$/
const PLUMBING_START = /^(Apex|Aura|AsyncApex|Cron|Flow|FieldPermissions|ObjectPermissions|PermissionSet|SetupEntity|SetupAudit|AuthSession|Lightning|StaticResource|EventLogFile|EntityDefinition|FieldDefinition|EntityParticle|DataType)/
const named = (ctx: ConnectorContext) => String(ctx.settings.objects ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)

/** The objects to index: the queryable ones that are not plumbing, and every object the connection names. */
function toIndex(ctx: ConnectorContext, objects: any[]): { names: string[]; missing: string[] } {
  const extra = new Set(named(ctx).map((n) => n.toLowerCase()))
  const queryable = objects.filter((o) => o.queryable && !o.deprecatedAndHidden)
  const names = queryable.filter((o) => extra.has(String(o.name).toLowerCase()) || (!o.customSetting && !PLUMBING_END.test(o.name) && !PLUMBING_START.test(o.name))).map((o) => String(o.name))
  const have = new Set(queryable.map((o) => String(o.name).toLowerCase()))
  return { names, missing: named(ctx).filter((n) => !have.has(n.toLowerCase())) }
}

/** The share of the daily budget kept for questions (percent): describing for the index stops before it. */
function guard(ctx: ConnectorContext) {
  const b = org(ctx).budget, keep = Math.min(Math.max(Number(ctx.settings.reserve ?? 10), 0), 90)
  if (b && b.used >= b.limit * (1 - keep / 100)) throw new ConnectorError(`the org has used ${b.used.toLocaleString('en')} of its ${b.limit.toLocaleString('en')} API calls in the last 24 hours; describing more objects now would spend the ${keep}% kept for questions — try again later`)
}

/** An object's describe: kept; asked again (if-modified-since) when `revalidate`. A new describe respects the budget. */
async function describe(ctx: ConnectorContext, name: string, revalidate = false): Promise<any> {
  const o = org(ctx), held = o.described.get(name.toLowerCase())
  if (held && !revalidate) return held.d
  if (!held) guard(ctx)
  try {
    const r = await api(ctx, `${v(ctx)}/sobjects/${encodeURIComponent(name)}/describe`, held ? { 'if-modified-since': held.at } : {})
    o.described.set(name.toLowerCase(), { at: seenAt(r.headers), d: r.data })
    return r.data
  } catch (e: any) {
    if (e?.status === 304 && held) return held.d
    if (e?.status === 404) throw new ConnectorError(`there is no object "${name}" this user may read`, 404)
    throw e
  }
}

// ── AN OBJECT AS AN ENTITY ─────────────────────────────────────────────────────────────────────────────────────────────
const TYPES: Record<string, Field['type']> = { boolean: 'boolean', int: 'integer', long: 'integer', double: 'number', currency: 'number', percent: 'number', date: 'date', datetime: 'timestamp', address: 'json', location: 'json', complexvalue: 'json' }
/** Picklist values worth saying in a field's description (an agent filters by them): at most this many. */
const SAY_VALUES = 25

export function fieldOf(f: any): Field {
  const words = [f.label, f.inlineHelpText].filter((x) => typeof x === 'string' && x.trim())
  const refs: string[] = f.referenceTo ?? []
  if (f.type === 'reference' && refs.length > 1) words.push(`points to one of: ${refs.join(', ')}`)
  const picks = (f.picklistValues ?? []).filter((p: any) => p.active !== false).map((p: any) => p.value)
  if ((f.type === 'picklist' || f.type === 'multipicklist') && picks.length && picks.length <= SAY_VALUES) words.push(`${f.type === 'multipicklist' ? 'any of (joined by ;)' : 'one of'}: ${picks.join(', ')}`)
  return {
    name: f.name, type: TYPES[f.type] ?? 'string',
    ...(words.length ? { description: words.join(' — ') } : {}),
    ...(f.type === 'id' ? { key: true } : {}),
    ...(f.type === 'reference' && refs.length === 1 ? { references: `${refs[0]}.Id` } : {}),
    nullable: !!f.nillable,
  }
}
const cursorFieldOf = (d: any) => ['SystemModstamp', 'LastModifiedDate'].find((n) => d.fields?.some((f: any) => f.name === n))
const entityOf = (d: any): Entity => ({
  name: d.name, label: d.label,
  description: `${d.labelPlural ?? d.label ?? d.name}${d.custom ? ' (a custom object)' : ''}.`,
  fields: (d.fields ?? []).map(fieldOf),
  ...(cursorFieldOf(d) ? { cursorField: cursorFieldOf(d) } : {}),
})

// ── READING: SOQL ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** A text value as a SOQL string literal: quotes and backslashes escaped, as SOQL's reference says. */
export const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/\f/g, '\\f').replace(/\x08/g, '\\b')}'`
const DAY = /^\d{4}-\d{2}-\d{2}$/, TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/** A filter's value as a SOQL literal of its field's type — never text pasted into the query. */
export function literal(f: any, value: unknown): string {
  if (value === null) return 'null'
  const s = String(value)
  switch (f.type) {
    case 'boolean': if (s === 'true' || s === 'false') return s.toUpperCase(); break
    case 'int': case 'long': case 'double': case 'currency': case 'percent': if (s.trim() !== '' && Number.isFinite(Number(s))) return String(Number(s)); break
    case 'date': if (DAY.test(s)) return s; break
    case 'datetime': if (TIME.test(s)) return s; break
    default: return quote(s)
  }
  throw new ConnectorError(`${f.name} is ${f.type === 'datetime' ? 'a date and time (2026-01-31T00:00:00Z)' : f.type === 'date' ? 'a date (2026-01-31)' : f.type === 'boolean' ? 'true or false' : 'a number'}, not "${s}"`)
}

/** A record as a row: Salesforce's attributes left out; a parent's fields as Parent.Field; a child query's records listed. */
export function rowOf(rec: any, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, x] of Object.entries(rec ?? {})) {
    if (k === 'attributes') continue
    const key = prefix ? `${prefix}.${k}` : k
    if (x && typeof x === 'object' && !Array.isArray(x) && 'attributes' in (x as object)) rowOf(x, key, out)
    else if (x && typeof x === 'object' && Array.isArray((x as any).records)) out[key] = (x as any).records.map((r: any) => rowOf(r))
    else out[key] = x
  }
  return out
}

/** Run SOQL (or continue one from its next-records URL) until `limit` rows or its end. */
async function soql(ctx: ConnectorContext, first: string, limit: number): Promise<ReadResult> {
  const rows: Record<string, unknown>[] = []
  let path: string | null = first, total: number | null = null
  const batch = { 'sforce-query-options': `batchSize=${Math.min(Math.max(limit, 200), 2000)}` }
  while (path && rows.length < limit) {
    const { data } = await api(ctx, path, batch)
    total ??= typeof data?.totalSize === 'number' ? data.totalSize : null
    rows.push(...(data?.records ?? []).map((r: any) => rowOf(r)))
    path = data?.done === false && data?.nextRecordsUrl ? String(data.nextRecordsUrl) : null
  }
  return { rows: rows.slice(0, limit), next: path, total }
}
const queryPath = (ctx: ConnectorContext, text: string) => `${v(ctx)}/query?q=${encodeURIComponent(text)}`

/** SOQL given whole: it can only read, but FOR VIEW / FOR REFERENCE / FOR UPDATE would mark or lock records. */
export function checkSoql(text: string): string {
  const s = String(text ?? '').trim()
  if (!/^select\s/i.test(s)) throw new ConnectorError('SOQL here only reads: a query starts with SELECT')
  if (/\bfor\s+(view|reference|update)\b/i.test(s)) throw new ConnectorError('FOR VIEW, FOR REFERENCE and FOR UPDATE change records (when they were viewed, a lock): leave them out')
  return s
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/

async function read(ctx: ConnectorContext, req: { entity: string; filters?: Record<string, unknown>; fields?: string[]; since?: string | null; cursor?: string | null; limit?: number }): Promise<ReadResult> {
  const limit = req.limit ?? 100
  if (req.cursor) {
    if (!/^\/services\/data\/v[\d.]+\/query\/[\w-]+$/.test(req.cursor)) throw new ConnectorError('a cursor is the nextRecordsUrl a read gave')
    return soql(ctx, req.cursor, limit)
  }
  if (!IDENT.test(req.entity) || req.entity.includes('.')) throw new ConnectorError(`"${req.entity}" is not an object's API name`)
  const d = await describe(ctx, req.entity)
  const byName = new Map<string, any>((d.fields ?? []).map((f: any) => [String(f.name).toLowerCase(), f]))
  const fields = req.fields?.length
    ? req.fields.map((f) => {
      if (!IDENT.test(f)) throw new ConnectorError(`"${f}" is not a field's API name`)
      if (!f.includes('.') && !byName.has(f.toLowerCase())) throw new ConnectorError(`${d.name} has no field ${f}`)
      return f
    })
    : (d.fields ?? []).filter((f: any) => f.type !== 'base64').map((f: any) => f.name)   // a file's body is read one record at a time
  const where = Object.entries(req.filters ?? {}).map(([k, x]) => {
    const f = byName.get(k.toLowerCase())
    if (!f) throw new ConnectorError(`${d.name} has no field ${k} to filter on`)
    if (f.filterable === false) throw new ConnectorError(`${d.name}.${f.name} cannot be filtered on in SOQL`)
    return `${f.name} = ${literal(f, x)}`
  })
  const since = req.since ? cursorFieldOf(d) : undefined
  if (req.since) {
    if (!since) throw new ConnectorError(`${d.name} has no time it was last changed to read from`)
    if (!Number.isFinite(Date.parse(req.since))) throw new ConnectorError(`since is a date and time (2026-01-31T00:00:00Z), not "${req.since}"`)
    where.push(`${since} > ${literal({ name: since, type: 'datetime' }, new Date(req.since).toISOString().replace(/\.\d{3}Z$/, 'Z'))}`)
  }
  const text = `SELECT ${fields.join(', ')} FROM ${d.name}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${since ? ` ORDER BY ${since}` : ''} LIMIT ${limit}`
  return soql(ctx, queryPath(ctx, text), limit)
}

const n = (x: number) => x.toLocaleString('en')
const budgetWords = (b: Budget | null) => (b ? `; API calls used in the last 24 hours: ${n(b.used)} of ${n(b.limit)}` : '')

export const createBridge = apiConnector('salesforce', {
  description: 'Salesforce: the objects the run-as user may read, each field with its label and help text, lookups as references (Object.Id). '
    + 'Filters are equality on fields ({"Industry": "Energy"}); "fields" names the fields to read (all but file bodies when none); parent fields as Account.Name.',
  requires: ['domain', 'clientId', 'clientSecret'],
  async test(ctx) {
    const { objects } = await readGlobal(ctx)
    const { names } = toIndex(ctx, objects)
    return `signed in to ${myDomain(ctx.settings.domain).replace('https://', '')} (API v${versionOf(ctx.settings.apiVersion)}): ${n(names.length)} objects to read (${n(objects.length)} the user may see in all)${budgetWords(org(ctx).budget)}`
  },
  async entities(ctx) {
    const { objects, changed } = await readGlobal(ctx)
    const described = await inParallel(toIndex(ctx, objects).names, DESCRIBE_AT_ONCE, (name) => describe(ctx, name, changed).catch((e) => {
      if (e?.status === 404 || e?.status === 403) return null   // listed, but not described for this user: left out
      throw e
    }))
    return described.filter(Boolean).map(entityOf)
  },
  read: { '*': read },
  native: {
    key: 'soql',
    say: '{"soql": "SELECT Name, Amount FROM Opportunity WHERE IsWon = true", "limit": n}: a whole SOQL query (it only reads).',
    run: (ctx, text, limit) => soql(ctx, queryPath(ctx, checkSoql(text)), limit),
  },
  budget: (ctx) => org(ctx).budget,
  checks: {
    /** Its My Domain answers, and has the API version asked for (the versions list needs no sign-in). */
    async domain(ctx) {
      const base = myDomain(ctx.settings.domain), want = versionOf(ctx.settings.apiVersion)
      const { data } = await json(ctx, `${base}/services/data/`, { retries: 1 })
      const versions = (Array.isArray(data) ? data : []).map((x: any) => String(x.version))
      if (!versions.includes(want)) throw new ConnectorError(`this org has no API version ${want} (it has ${versions.at(0) ?? '?'} to ${versions.at(-1) ?? '?'})`)
      return `${base.replace('https://', '')} answers, with API v${want} (its newest: v${versions.at(-1)})`
    },
    /** The objects it will read: how many, the first few, and any named that this user may not read. */
    async objects(ctx) {
      const { objects } = await readGlobal(ctx)
      const { names, missing } = toIndex(ctx, objects)
      if (missing.length) throw new ConnectorError(`no object named ${missing.join(', ')} that this user may read`)
      if (!names.length) throw new ConnectorError('the user may read no object')
      return `${n(names.length)} objects to read: ${names.slice(0, 8).join(', ')}${names.length > 8 ? `, and ${n(names.length - 8)} more` : ''}${budgetWords(org(ctx).budget)}`
    },
  },
})
