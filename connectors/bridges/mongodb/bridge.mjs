// THE MONGODB CONNECTOR (manifest.json) — a document source. A query is JSON: a find or an aggregation, on one collection,
// read only (no write stage is let through), at most 100,000 documents:
//   {"collection": "orders", "find": {"status": "open"}, "projection": {"_id": 0}, "sort": {"at": -1}, "limit": 50}
//   {"collection": "orders", "aggregate": [{"$group": {"_id": "$status", "n": {"$sum": 1}}}]}
// A value "@name" anywhere in it is the parameter of that name. Its collections are described by the fields of a sample
// of their documents, with their estimated counts.
//
//   settings: { database }    secrets: { url }

import { MongoClient } from 'mongodb'   // bundled into the connector when the connectors are built

const MAX = 100_000
const WRITES = new Set(['$out', '$merge'])

const plain = (v) => {
  if (v === null || v === undefined) return v
  if (typeof v === 'bigint') return Number(v)
  if (v instanceof Date) return v.toISOString()
  if (v?._bsontype === 'ObjectId' || v?._bsontype === 'ObjectID') return String(v)
  if (v?._bsontype === 'Decimal128' || v?._bsontype === 'Long' || v?._bsontype === 'Int32' || v?._bsontype === 'Double') return Number(String(v))
  if (Array.isArray(v)) return v.map(plain)
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
  return v
}
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : v instanceof Date ? 'date' : v?._bsontype ? String(v._bsontype).toLowerCase() : typeof v)

export function createBridge({ settings = {}, secrets = {} } = {}) {
  const configured = !!(secrets.url && settings.database)
  let client = null
  // One client, made on first use. A connect that fails is NOT kept — the database may simply not be up yet — so the next
  // call tries again, instead of every call after it failing on a closed client ("Topology is closed").
  let connecting = null
  const db = async () => {
    if (!client) {
      connecting ??= (async () => {
        const c = new MongoClient(String(secrets.url), { maxPoolSize: 4, serverSelectionTimeoutMS: 20_000, readPreference: 'secondaryPreferred' })
        try { await c.connect(); client = c } catch (e) { c.close().catch(() => {}); throw e } finally { connecting = null }
      })()
      await connecting
    }
    return client.db(String(settings.database))
  }

  async function query(text, params = {}) {
    if (!configured) throw new Error('this source is not configured: a connection string and a database')
    let q
    try { q = JSON.parse(String(text), (_k, v) => (typeof v === 'string' && /^@\w+$/.test(v) && Object.prototype.hasOwnProperty.call(params, v.slice(1)) ? params[v.slice(1)] : v)) }
    catch (e) { throw new Error(`a MongoDB query is JSON: {"collection": …, "find": {…}} or {"collection": …, "aggregate": [ … ]} — ${e.message}`) }
    if (!q?.collection) throw new Error('which collection? {"collection": "<name>", …}')
    const c = (await db()).collection(String(q.collection))
    const limit = Math.min(Number(q.limit) || MAX, MAX)
    let docs
    if (Array.isArray(q.aggregate)) {
      if (q.aggregate.some((s) => Object.keys(s ?? {}).some((k) => WRITES.has(k)))) throw new Error('a query only reads: $out and $merge are not run')
      docs = await c.aggregate([...q.aggregate, { $limit: limit }], { maxTimeMS: 120_000 }).toArray()
    } else {
      docs = await c.find(q.find ?? q.filter ?? {}, { projection: q.projection, sort: q.sort, skip: q.skip, limit, maxTimeMS: 120_000 }).toArray()
    }
    return docs.map(plain)
  }
  function isTransient(e) { return /MongoNetworkError|MongoServerSelectionError|ECONNRESET|ETIMEDOUT|not primary/i.test(`${e?.name ?? ''} ${e?.message ?? ''}`) }
  async function introspect() {
    const d = await db()
    const tables = []
    for (const info of await d.listCollections({}, { nameOnly: true }).toArray()) {
      if (info.name.startsWith('system.')) continue
      const c = d.collection(info.name)
      const fields = new Map()
      for (const doc of await c.aggregate([{ $sample: { size: 50 } }]).toArray()) {
        for (const [k, v] of Object.entries(doc)) {
          if (!fields.has(k)) fields.set(k, typeOf(v))
          if (v && typeof v === 'object' && !Array.isArray(v) && !v._bsontype && !(v instanceof Date)) for (const [k2, v2] of Object.entries(v)) if (!fields.has(`${k}.${k2}`)) fields.set(`${k}.${k2}`, typeOf(v2))
        }
      }
      tables.push({ name: info.name, columns: [...fields].map(([name, type]) => ({ name, type })), rows: await c.estimatedDocumentCount().catch(() => undefined) })
    }
    return { kind: 'documents', dialect: 'mongodb', tables }
  }
  return {
    id: 'mongodb', kind: 'documents', dialect: 'mongodb',
    description: String(settings.description ?? '') || 'MongoDB: a query is JSON on one collection — {"collection": "c", "find": {…}, "projection": {…}, "sort": {…}, "limit": n} or {"collection": "c", "aggregate": [ … ]}; "@name" is a parameter.',
    ready: () => configured,
    test: async () => { await (await db()).command({ ping: 1 }) },
    isTransient, query, introspect,
    close: () => { const c = client; client = null; c?.close().catch(() => {}) },
  }
}
