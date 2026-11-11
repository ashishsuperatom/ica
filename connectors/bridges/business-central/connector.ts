// Microsoft Dynamics 365 Business Central, through its API v2.0 (OData v4, src/odata.ts). It signs in as an app
// registered in Microsoft Entra (client credentials; the token kept until it expires). Its data is a company's: the
// companies are read first, and every other entity is one of a company's collections (customers, vendors, items,
// salesOrders, generalLedgerEntries, …) — the company's navigation properties in the API's $metadata, read at
// companies(<id>)/<collection>. A connection reads one company: the one named, or the only one there is.
import { apiConnector, ConnectorError, type ConnectorContext } from '../../src/api'
import { clientCredentials, odataGet, odataSource, QUERY_HELP, resolvedType, type ODataEntitySet, type ODataMetadata, type Signer } from '../../src/odata'

const API = 'https://api.businesscentral.dynamics.com'
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The tenant, environment and company from what was given — a tenant's id or domain, or an address pasted from
 *  Business Central (https://businesscentral.dynamics.com/<tenant>/<environment>?company=…) or from its API
 *  (https://api.businesscentral.dynamics.com/v2.0/<tenant>/<environment>/api/v2.0/…). */
export function placeOf(settings: Record<string, any>): { tenant: string; environment: string; company: string } {
  let tenant = String(settings.tenant ?? '').trim(), environment = String(settings.environment ?? '').trim(), company = String(settings.company ?? '').trim()
  if (/^https?:\/\//i.test(tenant)) {
    const u = new URL(tenant)
    const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const at = parts[0] === 'v2.0' ? 1 : 0
    tenant = parts[at] ?? ''
    if (parts[at + 1] && !/^(api|web|client)$/i.test(parts[at + 1]) && (!environment || environment === 'production')) environment = parts[at + 1]
    if (!company && u.searchParams.get('company')) company = u.searchParams.get('company')!
  }
  if (!tenant) throw new ConnectorError('the tenant is needed: its directory (tenant) ID, or its domain (contoso.onmicrosoft.com)')
  if (!GUID.test(tenant) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(tenant)) throw new ConnectorError(`"${tenant}" is not a tenant: give its directory (tenant) ID or its domain (contoso.onmicrosoft.com)`)
  if (environment && !/^[\w-]+$/.test(environment)) throw new ConnectorError(`"${environment}" is not an environment's name`)
  return { tenant, environment: environment || 'production', company }
}

const baseOf = (ctx: ConnectorContext) => { const p = placeOf(ctx.settings); return `${API}/v2.0/${encodeURIComponent(p.tenant)}/${encodeURIComponent(p.environment)}/api/v2.0/` }

/** Signed in as the Entra app (its token for Business Central's API). */
const signer = (ctx: ConnectorContext): Signer => async (renew = false) => {
  const { tenant } = placeOf(ctx.settings)
  const token = await clientCredentials(ctx, { tokenUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, clientId: String(ctx.settings.clientId ?? '').trim(), clientSecret: String(ctx.secrets.clientSecret ?? ''), scope: `${API}/.default` }, renew)
  return { authorization: `Bearer ${token}` }
}

interface Company { id: string; name: string; displayName?: string }
const companiesKept = new WeakMap<ConnectorContext, { at: number; list: Promise<Company[]> }>()
/** The environment's companies (kept a few minutes). */
function companies(ctx: ConnectorContext): Promise<Company[]> {
  const kept = companiesKept.get(ctx)
  if (kept && Date.now() - kept.at < 5 * 60_000) return kept.list
  const list = odataGet(ctx, signer(ctx), `${baseOf(ctx)}companies`, 'application/json').then(({ text }) => (JSON.parse(text)?.value ?? []) as Company[])
  companiesKept.set(ctx, { at: Date.now(), list })
  list.catch(() => companiesKept.delete(ctx))
  return list
}
const nameOf = (c: Company) => c.displayName && c.displayName !== c.name ? `${c.name} (${c.displayName})` : c.name

/** The company read: the one named (by id, name or display name), or the only one. */
async function companyOf(ctx: ConnectorContext): Promise<Company> {
  const wanted = placeOf(ctx.settings).company.toLowerCase(), all = await companies(ctx)
  if (!all.length) throw new ConnectorError('the environment has no company this app may read')
  if (!wanted) { if (all.length === 1) return all[0]; throw new ConnectorError(`the environment has ${all.length} companies; name the one to read: ${all.map(nameOf).join(', ')}`) }
  const c = all.find((x) => x.id.toLowerCase() === wanted || x.name.toLowerCase() === wanted || (x.displayName ?? '').toLowerCase() === wanted)
  if (!c) throw new ConnectorError(`there is no company "${placeOf(ctx.settings).company}" here (its companies: ${all.map(nameOf).join(', ')})`)
  return c
}

/** A company's collections, as entity sets read under companies(<id>)/: the company type's collection-valued
 *  navigation properties, each named as its path. */
function companySets(m: ODataMetadata): ODataEntitySet[] {
  const set = m.sets.find((s) => s.name === 'companies')
  const t = set && resolvedType(m, set.type)
  if (!t) throw new ConnectorError('the API\'s $metadata has no companies entity set')
  return t.navigations.filter((n) => n.many && n.name).map((n) => {
    const own = m.sets.find((s) => s.name === (set.bindings[n.name] ?? n.name))
    return { name: n.name, type: n.target, label: own?.label, description: own?.description, addressable: true, bindings: own?.bindings ?? {} }
  })
}
const companiesSource = (ctx: ConnectorContext) => odataSource(ctx, signer(ctx), { root: baseOf(ctx) , sets: (m) => m.sets.filter((s) => s.name === 'companies') })
const companySource = async (ctx: ConnectorContext) => {
  const c = await companyOf(ctx)
  if (!GUID.test(c.id)) throw new ConnectorError(`the company's id "${c.id}" is not a GUID`)
  return odataSource(ctx, signer(ctx), { root: `${baseOf(ctx)}companies(${c.id})/`, metadataUrl: `${baseOf(ctx)}$metadata`, sets: companySets })
}

export const createBridge = apiConnector('business-central', {
  description: `Microsoft Dynamics 365 Business Central (API v2.0) — one company's data: each of its collections is an entity (customers, vendors, items, salesOrders, salesInvoices, purchaseOrders, generalLedgerEntries, accounts, …); companies lists the environment's companies. ${QUERY_HELP}`,
  requires: ['tenant', 'clientId', 'clientSecret'],
  async test(ctx) {
    const { environment } = placeOf(ctx.settings)
    const all = await companies(ctx)
    const counted = `signed in to ${environment}: ${all.length} compan${all.length === 1 ? 'y' : 'ies'}`
    // Before a company is chosen (the setup's next step), signing in and listing them is the test.
    if (!placeOf(ctx.settings).company && all.length > 1) return `${counted}: ${all.map(nameOf).join(', ')}`
    return `${counted}; reading ${nameOf(await companyOf(ctx))}`
  },
  async entities(ctx) {
    const [top, company] = await Promise.all([companiesSource(ctx).entities(), companySource(ctx).then((s) => s.entities())])
    return [...top, ...company]
  },
  read: {
    async '*'(ctx, req) {
      if (req.entity === 'companies') return companiesSource(ctx).read('companies', req)
      return (await companySource(ctx)).read(req.entity, req)
    },
  },
  checks: {
    /** The app gets a token from Microsoft Entra: its tenant, id and secret are right. */
    async token(ctx) {
      await signer(ctx)(true)
      return `Microsoft Entra signed the app in for ${placeOf(ctx.settings).tenant}`
    },
    /** The environment's companies, and the one this connection reads. */
    async companies(ctx) {
      const all = await companies(ctx)
      const c = await companyOf(ctx)
      return `${all.length} compan${all.length === 1 ? 'y' : 'ies'}: ${all.map(nameOf).join(', ')} — reading ${nameOf(c)}`
    },
  },
})
