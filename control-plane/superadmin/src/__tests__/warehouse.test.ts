import { describe, expect, it } from 'vitest'
import { readAvro, writeAvro } from '../warehouse/cloud/avro'
import { checkQuery } from '../warehouse/access'
import { cloudWarehouse } from '../warehouse/cloud/index'
import { parseExact, stringifyExact } from '../warehouse/cloud/catalog'
import { namespaceOf, type TableInfo } from '../warehouse/bridge'

const orders: TableInfo = { name: 'orders', columns: [{ name: 'id', type: 'long' }, { name: 'customer', type: 'string' }, { name: 'amount', type: 'double' }, { name: 'margin', type: 'double' }] }
const people: TableInfo = { name: 'people', columns: [{ name: 'id', type: 'long' }, { name: 'salary', type: 'double' }] }

describe('the warehouse access check (fails closed)', () => {
  it('places plain table names in the organisation\'s namespace and lets granted columns through', () => {
    const r = checkQuery('SELECT customer, sum(amount) AS total FROM orders o WHERE o.amount > 10 GROUP BY customer ORDER BY total DESC', [orders, people], { orders: ['customer', 'amount'] }, 'org_acme')
    expect(r.sql).toBe('SELECT customer, sum(amount) AS total FROM org_acme.orders o WHERE o.amount > 10 GROUP BY customer ORDER BY total DESC')
    expect(r.tables).toEqual(['orders'])
  })
  it('refuses a table not granted, a column held back, a star over limited columns, writes, comments and a second statement', () => {
    const g = { orders: ['customer', 'amount'] }
    expect(() => checkQuery('SELECT id FROM people', [orders, people], g, 'n')).toThrow(/may not read the table "people"/)
    expect(() => checkQuery('SELECT margin FROM orders', [orders, people], g, 'n')).toThrow(/may not read the column "margin"/)
    expect(() => checkQuery('SELECT * FROM orders', [orders, people], g, 'n')).toThrow(/select the columns by name/)
    expect(checkQuery('SELECT count(*) FROM orders', [orders, people], g, 'n').sql).toBe('SELECT count(*) FROM n.orders')
    expect(() => checkQuery('DELETE FROM orders', [orders], null, 'n')).toThrow(/SELECT queries only/)
    expect(() => checkQuery('SELECT 1 FROM orders -- x', [orders], null, 'n')).toThrow(/comments/)
    expect(() => checkQuery('SELECT id FROM orders; SELECT id FROM people', [orders, people], null, 'n')).toThrow(/one statement/)
    expect(() => checkQuery('SELECT id FROM other_ns.orders', [orders], null, 'n')).toThrow(/plainly/)
    expect(() => checkQuery('SELECT id FROM nowhere', [orders], null, 'n')).toThrow(/no table "nowhere"/)
  })
  it('no alias can stand in for what is held back: aliasing, qualifying, subqueries, alias names like columns or tables', () => {
    const g = { orders: ['id', 'amount'] }
    const sch = [orders, people]
    const refused = (sql: string, why: RegExp) => expect(() => checkQuery(sql, sch, g, 'n'), sql).toThrow(why)
    refused('SELECT margin AS margin FROM orders', /"margin"/)
    refused('SELECT o.margin FROM orders o', /column "margin"/)
    refused('SELECT id FROM orders margin', /alias "margin" is the name of a column/)
    refused('SELECT amount AS people FROM orders', /alias "people" is the name of a table/)
    refused('SELECT amount AS margin FROM orders WHERE margin > 0', /alias "margin" is the name of a column/)
    refused('SELECT x FROM (SELECT margin AS x FROM orders) sub', /column "margin"/)
    refused('WITH people AS (SELECT id FROM orders) SELECT id FROM people', /CTE "people" like a table/)
    refused('WITH x AS (SELECT id FROM orders) SELECT salary FROM people', /may not read the table "people"/)
    refused(`SELECT id FROM orders WHERE customer = E'\\x'`, /escaped string/)
    refused(`SELECT id FROM orders WHERE amount > 1 OR 'a\\' = 'b'`, /backslash/)
    refused('SELECT o.* FROM orders o', /select the columns by name/)
    const dated = { name: 'events', columns: [{ name: 'id', type: 'long' as const }, { name: 'date', type: 'date' as const }] }
    expect(() => checkQuery('SELECT date FROM events', [dated], { events: ['id'] }, 'n')).toThrow(/column "date"/)
    // what is granted still reads, with aliases of its own
    expect(checkQuery('SELECT amount AS total FROM orders o WHERE o.amount > 1 ORDER BY total DESC', sch, g, 'n').sql).toBe('SELECT amount AS total FROM n.orders o WHERE o.amount > 1 ORDER BY total DESC')
    expect(checkQuery('SELECT t FROM (SELECT amount AS t FROM orders) sub', sch, g, 'n').sql).toBe('SELECT t FROM (SELECT amount AS t FROM n.orders) sub')
  })
  it('an administrator reads everything; CTEs and joins are placed too', () => {
    const r = checkQuery('WITH big AS (SELECT id, amount FROM orders WHERE amount > 5) SELECT b.id, p.salary FROM big b JOIN people p ON p.id = b.id', [orders, people], null, 'org_x')
    expect(r.sql).toContain('FROM org_x.orders')
    expect(r.sql).toContain('JOIN org_x.people p')
    expect(r.sql).toContain('FROM big b')
  })
})

describe('avro container files', () => {
  it('round-trips records with longs beyond a double', async () => {
    const schema = { type: 'record', name: 'r', fields: [{ name: 'id', type: 'long' }, { name: 'name', type: ['null', 'string'] }, { name: 'e', type: { type: 'record', name: 'empty', fields: [] } }] }
    const out = await readAvro(writeAvro(schema, [{ id: 9007199254740993n, name: null, e: {} }, { id: -5n, name: 'x', e: {} }], { k: 'v' }))
    expect(out.meta.k).toBe('v')
    expect(out.records).toEqual([{ id: 9007199254740993n, name: null, e: {} }, { id: -5n, name: 'x', e: {} }])
  })
  it('keeps snapshot ids exact through the catalog\'s JSON', () => {
    const j = parseExact('{"current-snapshot-id": 7528251855892523726, "snapshots": [{"snapshot-id": 7528251855892523726}]}')
    expect(j['current-snapshot-id']).toBe('7528251855892523726')
    expect(stringifyExact(j)).toBe('{"current-snapshot-id":7528251855892523726,"snapshots":[{"snapshot-id":7528251855892523726}]}')
  })
})

/** An Iceberg REST catalog and a SQL endpoint in memory: enough to run the module end to end. */
function fakeCloud() {
  const tables = new Map<string, any>(); const namespaces = new Set<string>(); const files = new Map<string, Uint8Array>(); const queries: string[] = []
  const store = { root: 's3://wh', async put(k: string, b: Uint8Array) { files.set(k, b) }, async get(k: string) { return files.get(k) ?? null } }
  const fetcher = (async (input: any, init: any = {}) => {
    const url = new URL(String(input)); const body = init.body ? parseExact(String(init.body)) : null
    const ok = (v: unknown, status = 200) => new Response(stringifyExact(v), { status })
    if (url.hostname.startsWith('api.sql')) { queries.push(body.query); return ok({ success: true, result: { schema: [{ name: 'customer' }, { name: 'total' }], rows: [{ customer: 'Acme', total: 3 }] } }) }
    const p = url.pathname.replace(/^\/acct\/wh/, '')
    if (p === '/v1/config') return ok({ overrides: { prefix: 'acct_wh' } })
    const m = /^\/v1\/acct_wh\/namespaces(?:\/([^/]+)(?:\/tables(?:\/([^/]+))?)?)?$/.exec(p)
    if (!m) return ok({ error: { message: 'no route ' + p } }, 404)
    const [, ns, t] = m
    if (!ns && init.method === 'POST') { if (namespaces.has(body.namespace[0])) return ok({ error: { message: 'exists' } }, 409); namespaces.add(body.namespace[0]); return ok({}) }
    if (ns && !t && init.method === 'POST') {
      const key = `${ns}.${body.name}`; if (tables.has(key)) return ok({ error: { message: 'exists' } }, 409)
      const meta = { 'format-version': 2, 'table-uuid': 'u', location: `s3://wh/${ns}/${body.name}`, 'last-sequence-number': 0, 'last-column-id': body.schema.fields.length, 'current-schema-id': 0, schemas: [body.schema], 'default-spec-id': 0, 'partition-specs': [{ 'spec-id': 0, fields: [] }], 'current-snapshot-id': null, snapshots: [], refs: {} }
      tables.set(key, meta); return ok({ metadata: meta })
    }
    if (ns && !t) return ok({ identifiers: [...tables.keys()].filter((k) => k.startsWith(ns + '.')).map((k) => ({ namespace: [ns], name: k.split('.')[1] })) })
    const meta = tables.get(`${ns}.${t}`); if (!meta) return ok({ error: { message: 'no table' } }, 404)
    if (init.method === 'POST') {
      if (String(body.requirements[0]['snapshot-id']) !== String(meta['current-snapshot-id'])) return ok({ error: { message: 'conflict' } }, 409)
      for (const u of body.updates) {
        if (u.action === 'add-snapshot') { meta.snapshots.push(u.snapshot); meta['last-sequence-number'] = u.snapshot['sequence-number'] }
        if (u.action === 'set-snapshot-ref') meta['current-snapshot-id'] = u['snapshot-id']
      }
      return ok({ metadata: meta })
    }
    return ok({ metadata: meta })
  }) as typeof fetch
  return { store, fetcher, files, queries, tables }
}

describe('the warehouse module, end to end against a catalog in memory', () => {
  it('makes a table in the organisation\'s namespace, appends twice, and queries through the access check', async () => {
    const f = fakeCloud()
    const { bridge, ingest } = cloudWarehouse({ accountId: 'acct', bucket: 'wh', catalogToken: 't', sqlToken: 't', catalogUri: 'https://catalog.example/acct/wh' }, f.store, f.fetcher)
    await ingest.createTable('acme', { name: 'orders', columns: [{ name: 'id', type: 'long', required: true }, { name: 'customer', type: 'string' }, { name: 'amount', type: 'double' }] })
    await expect(ingest.createTable('acme', { name: 'orders', columns: [{ name: 'id', type: 'long' }] })).rejects.toThrow(/already a table/)
    await expect(ingest.createTable('acme', { name: 'Bad Name', columns: [{ name: 'id', type: 'long' }] })).rejects.toThrow(/not a table name/)
    const a = await ingest.append('acme', 'orders', [{ id: 1, customer: 'Acme', amount: 2 }, { id: 2, customer: 'Beta', amount: 1 }])
    const b = await ingest.append('acme', 'orders', [{ id: 3, customer: 'Acme', amount: 1 }])
    expect(a.rows).toBe(2); expect(b.rows).toBe(1)
    const meta = f.tables.get(`${namespaceOf('acme')}.orders`)
    expect(meta.snapshots).toHaveLength(2)
    const list = await readAvro(f.files.get(meta.snapshots[1]['manifest-list'].replace('s3://wh/', ''))!)
    expect(list.records.map((r) => Number(r.added_rows_count))).toEqual([1, 2])   // the new manifest, then the parent's carried forward
    await expect(ingest.append('acme', 'orders', [{ customer: 'no id' }])).rejects.toThrow(/required/)

    expect((await bridge.tables('acme')).map((t) => t.name)).toEqual(['orders'])
    const r = await bridge.queryAs('acme', 'SELECT customer, sum(amount) AS total FROM orders GROUP BY customer', { orders: ['customer', 'amount'] }, { limit: 10 })
    expect(r.rows).toEqual([{ customer: 'Acme', total: 3 }])
    expect(f.queries.at(-1)).toBe('SELECT * FROM (SELECT customer, sum(amount) AS total FROM org_acme.orders GROUP BY customer) AS answer LIMIT 11')
    await expect(bridge.queryAs('acme', 'SELECT id FROM orders', { orders: ['customer'] })).rejects.toThrow(/may not read the column "id"/)
    expect(await bridge.tables('other')).toEqual([])   // another organisation sees nothing of this one
  })
  it('without settings it says it is not set up', async () => {
    const { bridge, ingest } = cloudWarehouse(null, null)
    expect(bridge.configured).toBe(false)
    await expect(bridge.tables('acme')).rejects.toThrow(/not set up/)
    await expect(ingest.append('acme', 'orders', [{ id: 1 }])).rejects.toThrow(/not set up/)
  })
})
