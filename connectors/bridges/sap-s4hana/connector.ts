// SAP S/4HANA — Cloud or on-premise — through its OData APIs (src/odata.ts). A connection names the API services it reads
// (API_BUSINESS_PARTNER, API_SALES_ORDER_SRV, …); each service's entity sets become entities named <SERVICE>.<EntitySet>,
// so two services' sets never collide. The system is found from what the person pastes: the SAP Business Accelerator
// Hub's sandbox, an S/4HANA Cloud tenant (its API host, even when the Fiori launchpad's address is pasted), or an
// on-premise gateway. Every request carries sap-client when one is given. A service this connection may not read is
// left out of its entities, and named by the services check.
import { apiConnector, ConnectorError, type ConnectorContext } from '../../src/api'
import { odataSource, QUERY_HELP, signerOf, signInOf, type ODataService } from '../../src/odata'

/** The services read when the person names none: business partners, sales orders, products, purchase orders and the
 *  chart of accounts' G/L accounts. */
export const DEFAULT_SERVICES = ['API_BUSINESS_PARTNER', 'API_SALES_ORDER_SRV', 'API_PRODUCT_SRV', 'API_PURCHASEORDER_PROCESS_SRV', 'API_GLACCOUNTINCHARTOFACCOUNTS_SRV']
const ODATA_V2 = '/sap/opu/odata/sap'

/** Where the system's OData services are (ending in /sap/opu/odata/sap), from what was pasted: an address with or
 *  without https://, a service's URL, the Fiori launchpad's address of an S/4HANA Cloud tenant (its APIs answer on the
 *  host with -api added), or the sandbox's host. */
export function systemOf(pasted: string): { base: string; service: string | null } {
  const text = String(pasted ?? '').trim()
  if (!text) throw new ConnectorError('the system\'s address is needed')
  let u: URL
  try { u = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`) } catch { throw new ConnectorError(`"${text}" is not an address (https://…)`) }
  const cloud = /^(my\d+)\.(s4hana\.cloud\.sap|s4hana\.ondemand\.com)$/i.exec(u.hostname)
  if (cloud) u.hostname = `${cloud[1]}-api.${cloud[2]}`
  const at = u.pathname.toLowerCase().indexOf(ODATA_V2)
  const prefix = at >= 0 ? u.pathname.slice(0, at) : u.hostname === 'sandbox.api.sap.com' ? '/s4hanacloud' : ''
  const service = at >= 0 ? u.pathname.slice(at + ODATA_V2.length).split('/').filter(Boolean)[0] ?? null : null
  return { base: `${u.origin}${prefix}${ODATA_V2}`, service: service && service !== '$metadata' ? decodeURIComponent(service) : null }
}

/** The services to read: those named (a name, or a service's URL, one per line or separated by commas), the one in the
 *  pasted address, or the default set. */
export function servicesOf(settings: Record<string, any>): string[] {
  const out: string[] = []
  const add = (s: string) => { const name = s.includes('/') ? systemOf(s).service : s; if (name && !out.includes(name)) out.push(name) }
  for (const s of String(settings.services ?? '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)) {
    if (!/^[\w/;=.:-]+$/.test(s)) throw new ConnectorError(`"${s}" is not a service name (like API_BUSINESS_PARTNER) or a service's URL`)
    add(s)
  }
  const pasted = settings.host ? systemOf(String(settings.host)).service : null
  if (pasted) add(pasted)
  return out.length ? out : DEFAULT_SERVICES
}

/** A service's name as its entities' prefix: without a version (API_X;v=0002 → API_X). */
const prefixOf = (service: string) => `${service.replace(/;.*$/, '')}.`

const signer = (ctx: ConnectorContext) => {
  const s = signInOf({ ...ctx.settings, auth: ctx.settings.auth || 'basic' }, ctx.secrets)
  // S/4HANA's own token endpoint, when an OAuth client is used and no token URL given.
  if (s.kind === 'oauth-client' && !s.tokenUrl) s.tokenUrl = `${new URL(systemOf(String(ctx.settings.host)).base).origin}/sap/bc/sec/oauth2/token`
  return signerOf(ctx, s)
}
const serviceOf = (ctx: ConnectorContext, service: string): ODataService => ({
  root: `${systemOf(String(ctx.settings.host)).base}/${service}/`,
  params: ctx.settings.sapClient ? { 'sap-client': String(ctx.settings.sapClient).trim() } : undefined,
})
const source = (ctx: ConnectorContext, service: string) => odataSource(ctx, signer(ctx), serviceOf(ctx, service))

/** Each service read, or why not. */
async function survey(ctx: ConnectorContext) {
  return Promise.all(servicesOf(ctx.settings).map(async (service) => {
    try { const m = await source(ctx, service).metadata(); return { service, sets: m.sets.filter((s) => s.addressable).length, error: null as string | null } } catch (e: any) { return { service, sets: 0, error: String(e?.message ?? e) } }
  }))
}

export const createBridge = apiConnector('sap-s4hana', {
  description: `SAP S/4HANA, through its OData APIs: each entity set of each API service read is an entity named <SERVICE>.<EntitySet> (API_BUSINESS_PARTNER.A_BusinessPartner). Dates are read as ISO dates. ${QUERY_HELP}`,
  requires: ['host'],
  async test(ctx) {
    const all = await survey(ctx)
    const ok = all.filter((s) => !s.error)
    if (!ok.length) throw new ConnectorError(all[0]?.error ?? 'no service was named')
    const s = await source(ctx, ok[0].service).sample()
    return `signed in: ${ok.length} of ${all.length} service${all.length === 1 ? '' : 's'} answer${s.set ? `; read ${s.rows} row${s.rows === 1 ? '' : 's'} of ${prefixOf(ok[0].service)}${s.set}` : ''}`
  },
  async entities(ctx) {
    const all = await survey(ctx)
    const ok = all.filter((s) => !s.error)
    if (!ok.length && all.length) throw new ConnectorError(all[0].error!)
    for (const s of all) if (s.error) ctx.log(`sap-s4hana: ${s.service} left out`, { error: s.error })
    return (await Promise.all(ok.map((s) => source(ctx, s.service).entities({ prefix: prefixOf(s.service) })))).flat()
  },
  read: {
    async '*'(ctx, req) {
      const dot = req.entity.lastIndexOf('.')
      const service = servicesOf(ctx.settings).find((s) => prefixOf(s) === req.entity.slice(0, dot + 1))
      if (dot < 0 || !service) throw new ConnectorError(`"${req.entity}" is not an entity of the services this connection reads; an entity is named <SERVICE>.<EntitySet> (services: ${servicesOf(ctx.settings).join(', ')})`)
      return source(ctx, service).read(req.entity.slice(dot + 1), req)
    },
  },
  checks: {
    /** Which of the named services this connection can read, each with its entity sets — or why not. */
    async services(ctx) {
      const all = await survey(ctx)
      const lines = all.map((s) => s.error ? `${s.service}: cannot be read — ${s.error}` : `${s.service}: ${s.sets} entity set${s.sets === 1 ? '' : 's'}`)
      if (!all.some((s) => !s.error)) throw new ConnectorError(`none of the services can be read. ${lines.join('; ')}`)
      return lines.join('; ')
    },
  },
})
