// Any OData service, v2 or v4 (src/odata.ts): its entity sets are entities, read with OData's own query options. The
// service is found from whatever URL the person pastes — its root, its $metadata, an entity set's — and, when that is not
// plainly a root, by trying the paths above it until one answers with $metadata.
import { apiConnector, ConnectorError, type ConnectorContext } from '../../src/api'
import { metadataOf, odataSource, QUERY_HELP, serviceRootOf, signerOf, signInOf } from '../../src/odata'

const roots = new WeakMap<ConnectorContext, Promise<string>>()
const signer = (ctx: ConnectorContext) => signerOf(ctx, signInOf(ctx.settings, ctx.secrets))

/** The service root: what was pasted, made a root; if no $metadata answers there, the paths above it (three at most). A
 *  refused sign-in is said at once — it would be refused above too. */
function rootOf(ctx: ConnectorContext): Promise<string> {
  const kept = roots.get(ctx); if (kept) return kept
  const found = (async () => {
    let root = serviceRootOf(String(ctx.settings.url ?? ''))
    let first: unknown
    for (let up = 0; up <= 3; up++) {
      try { await metadataOf(ctx, signer(ctx), { root }); return root } catch (e: any) {
        first ??= e
        // Not here: any answer but a refused sign-in (some services answer 500 for $metadata below an entity set).
        const notHere = (typeof e?.status === 'number' && e.status !== 401 && e.status !== 403) || /did not answer with an OData|not an OData service/.test(String(e?.message))
        const parent = root.replace(/[^/]+\/$/, '')
        if (!notHere || new URL(parent).pathname === new URL(root).pathname || new URL(parent).pathname === '/') break
        root = parent
      }
    }
    throw first
  })()
  roots.set(ctx, found)
  found.catch(() => roots.delete(ctx))
  return found
}

/** The entity sets the connection reads: those named, or every one. */
const named = (ctx: ConnectorContext) => String(ctx.settings.entitySets ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)
const source = async (ctx: ConnectorContext) => odataSource(ctx, signer(ctx), { root: await rootOf(ctx) })

export const createBridge = apiConnector('odata', {
  description: `An OData service (v2 or v4): each entity set is an entity, its properties the fields. ${QUERY_HELP}`,
  requires: ['url'],
  async test(ctx) {
    const src = await source(ctx)
    const m = await src.metadata()
    const s = await src.sample(named(ctx))
    return `OData v${m.version} service at ${src.svc.root}: ${m.sets.length} entity set${m.sets.length === 1 ? '' : 's'}${s.set ? `; read ${s.rows} row${s.rows === 1 ? '' : 's'} of ${s.set}` : ''}`
  },
  async entities(ctx) {
    const only = new Set(named(ctx))
    return (await source(ctx)).entities({ only: only.size ? (s) => only.has(s.name) : undefined })
  },
  read: {
    async '*'(ctx, req) {
      const only = named(ctx)
      if (only.length && !only.includes(req.entity)) throw new ConnectorError(`"${req.entity}" is not among the entity sets this connection reads (${only.join(', ')})`)
      return (await source(ctx)).read(req.entity, req)
    },
  },
  checks: {
    /** Which entity sets it can read: those named (each must exist), or every one. */
    async 'entity-sets'(ctx) {
      const m = await (await source(ctx)).metadata()
      const all = m.sets.map((s) => s.name), only = named(ctx)
      const missing = only.filter((n) => !all.includes(n))
      if (missing.length) throw new ConnectorError(`the service has no entity set ${missing.map((x) => `"${x}"`).join(', ')} (it has: ${all.slice(0, 30).join(', ')}${all.length > 30 ? ', …' : ''})`)
      const read = only.length ? only : all
      return `${read.length} entity set${read.length === 1 ? '' : 's'} to read: ${read.slice(0, 12).join(', ')}${read.length > 12 ? ', …' : ''}`
    },
  },
})
