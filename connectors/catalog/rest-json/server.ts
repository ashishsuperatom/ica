// Any JSON API: the endpoints the person names become entities; each read GETs the path and takes the rows from the
// answer (an array, or the array under data / items / results / records), flattened, with the fields they hold.
import { defineConnector, json, join, flatten, fieldsOf, nextLink, ConnectorError, type ConnectorContext } from '../../src/sdk'

const endpoints = (ctx: ConnectorContext) => String(ctx.settings.endpoints ?? '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
  const [name, path] = l.split(/\s+/)
  if (!name || !path || !/^[a-z][a-z0-9_]*$/i.test(name)) throw new ConnectorError(`"${l}" is not an endpoint line (a name and a path)`)
  return { name, path }
})
const rowsIn = (data: any): any[] => Array.isArray(data) ? data : ['data', 'items', 'results', 'records', 'rows', 'value'].map((k) => data?.[k]).find(Array.isArray) ?? (data && typeof data === 'object' ? [data] : [])
const nextIn = (data: any, headers: Headers) => nextLink(headers) ?? (typeof data?.next === 'string' ? data.next : typeof data?.links?.next === 'string' ? data.links.next : typeof data?.paging?.next === 'string' ? data.paging.next : null)

async function readPath(ctx: ConnectorContext, url: string, limit: number) {
  const rows: Record<string, unknown>[] = []
  let next: string | null = url
  while (next && rows.length < limit) { const { data, headers } = await json(ctx, next); rows.push(...rowsIn(data).map((r) => flatten(r))); next = nextIn(data, headers) }
  return { rows: rows.slice(0, limit), next }
}

export default defineConnector({
  async test(ctx) {
    const [first] = endpoints(ctx)
    if (!first) return { ok: false, message: 'name at least one endpoint' }
    const r = await readPath(ctx, join(ctx.settings.baseUrl, first.path), 1)
    return { ok: true, message: `${first.name} answered${r.rows.length ? '' : ' (no rows)'}` }
  },
  // The entities are what the endpoints answer: each read once (a row or a few) to find its fields.
  async entities(ctx) {
    return Promise.all(endpoints(ctx).map(async (e) => {
      const sample = await readPath(ctx, join(ctx.settings.baseUrl, e.path), 20).catch(() => ({ rows: [] as Record<string, unknown>[] }))
      return { name: e.name, description: `GET ${e.path}`, fields: fieldsOf(sample.rows) }
    }))
  },
  read: {
    async '*'(ctx, req) {
      const e = endpoints(ctx).find((x) => x.name === req.entity)
      if (!e) throw new ConnectorError(`there is no endpoint called "${req.entity}"`)
      const q = new URLSearchParams(Object.entries(req.filters ?? {}).map(([k, v]) => [k, String(v)])).toString()
      const url = req.cursor ?? `${join(ctx.settings.baseUrl, e.path)}${q ? (e.path.includes('?') ? '&' : '?') + q : ''}`
      return readPath(ctx, url, req.limit!)
    },
  },
})
