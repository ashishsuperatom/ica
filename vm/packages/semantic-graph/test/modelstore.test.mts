// A model built in the graph store by operations: each checked before it is written — duplicates, breakage and
// dangling references refused and recorded — renames and promotions rewriting what refers to them, every change kept,
// and a model exported and imported back unchanged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, evaluate, ModelStore, schemaProblems, type Instance, type Operation } from '../src/index.js'
import { instance as branchesData, schema as branches } from './fixtures/branches.js'
import { toSqlite } from './fixtures/sqlite.js'

const ctx = { by: 'test', reason: 'building a retailer', from: 'CONCEPTS.md' }
const retailer = (): ModelStore => {
  const g = new ModelStore(':memory:')
  assert.ok(g.createModel('retail', ctx).ok)
  const ops: Operation[] = [
    { op: 'add-entity', name: 'Region', synonyms: ['area'] },
    { op: 'add-entity', name: 'Store', description: 'A shop.', synonyms: ['shop', 'branch'] },
    { op: 'add-entity', name: 'Product' },
    { op: 'add-calendar', name: 'Day', level: 'day' },
    { op: 'add-calendar', name: 'Month', level: 'month' },
    { op: 'add-arrow', id: 'Day.month', to: 'Month' },
    { op: 'add-arrow', id: 'Store.region', to: 'Region' },
    { op: 'add-attribute', id: 'Product.category', type: 'text', members: ['Fresh', 'Frozen'] },
    { op: 'add-attribute', id: 'Store.opened', type: 'date' },
    { op: 'add-fact', name: 'Sale', description: 'A product sold in a store on a day.' },
    { op: 'add-arrow', id: 'Sale.store', to: 'Store' },
    { op: 'add-arrow', id: 'Sale.product', to: 'Product' },
    { op: 'add-arrow', id: 'Sale.day', to: 'Day' },
    { op: 'add-measure', id: 'Sale.units', unit: 'units', kind: 'flow', aggregate: 'sum', synonyms: ['quantity'] },
    { op: 'add-condition', name: 'frozen product', on: 'Product', where: [{ attribute: 'category', in: ['Frozen'] }] },
  ]
  for (const op of ops) { const r = g.apply('retail', op, ctx); if (!r.ok) assert.fail(`${op.op}: ${r.reason}`) }
  return g
}
const data: Instance = {
  elements: { Region: { east: {}, west: {} }, Store: { s1: { label: 'Main St', arrows: { region: 'east' }, attributes: { opened: '2020-01-01' } }, s2: { label: 'Harbour', arrows: { region: 'west' } } },
    Product: { p1: { attributes: { category: 'Fresh' } }, p2: { attributes: { category: 'Frozen' } } } },
  rows: { Sale: [
    { arrows: { store: 's1', product: 'p1', day: '2026-09-01' }, measures: { units: 5 } },
    { arrows: { store: 's2', product: 'p2', day: '2026-09-02' }, measures: { units: 3 } },
  ] },
}

test('a model built by operations is a schema questions are answered on', () => {
  const g = retailer()
  const { schema } = g.state('retail')
  assert.deepEqual(schemaProblems(schema), [])
  const v = check(schema, { measures: ['Sale.units'], by: [{ to: 'Region' }], where: [{ condition: 'frozen product' }] })
  if (!v.ok) assert.fail(v.reason)
  assert.deepEqual(evaluate(schema, data, v.plan).rows, [['west', 3]])
})

test('an operation that would duplicate, break or dangle is refused, recorded, and changes nothing', () => {
  const g = retailer()
  const before = JSON.stringify(g.state('retail'))
  const refused = (op: Operation, why: RegExp) => { const r = g.apply('retail', op, ctx); assert.ok(!r.ok && why.test(r.reason), `${op.op}: ${r.ok ? 'applied' : r.reason}`) }
  refused({ op: 'add-entity', name: 'store' }, /"store" already means Store/)
  refused({ op: 'add-entity', name: 'Outlet', synonyms: ['shop'] }, /"shop" already means Store \(as a synonym\)/)
  refused({ op: 'add-measure', id: 'Sale.revenue', unit: 'money', kind: 'flow', aggregate: 'sum' }, /problem: Sale.revenue is money and does not say where its currency comes from/)
  refused({ op: 'add-measure', id: 'Store.size', unit: 'm2', kind: 'stock', aggregate: 'sum' }, /measures belong to facts/)
  refused({ op: 'remove', id: 'Store' }, /still used: the arrow Sale.store leads to it/)
  refused({ op: 'remove', id: 'Product.category' }, /the condition "frozen product" may use it/)
  refused({ op: 'set', id: 'Sale.store', property: 'unit', value: 'x' }, /what can be set on it: kind, partial, synonyms/)
  refused({ op: 'add-condition', name: 'eastern', on: 'Store', where: [{ to: 'Region', via: ['area'], in: ['east'] }] }, /goes via area, which is not a path from Store/)
  refused({ op: 'bind', object: 'Store', binding: { source: 'shop', sql: 'SELECT 1', key: 'id', arrows: { region: 'region', owner: 'owner' } } }, /column for the arrow owner, which Store does not have/)
  assert.equal(JSON.stringify(g.state('retail')), before)
  const log = g.changes('retail', { limit: 9 })
  assert.equal(log.filter((c) => !c.applied).length, 9)
  assert.equal(log[0].from, 'CONCEPTS.md')
})

test('a dry run says what would happen and writes nothing', () => {
  const g = retailer()
  const n = g.lastChange('retail')
  const r = g.apply('retail', { op: 'add-entity', name: 'Supplier' }, { ...ctx, dryRun: true })
  assert.ok(r.ok && r.state.schema.objects.Supplier)
  assert.ok(!g.state('retail').schema.objects.Supplier)
  assert.equal(g.lastChange('retail'), n)
})

test('rename rewrites everything that refers to what is renamed', () => {
  const g = retailer()
  assert.ok(g.apply('retail', { op: 'rename', id: 'Store', to: 'Shop' }, ctx).ok)
  assert.ok(g.apply('retail', { op: 'rename', id: 'Sale.store', to: 'shop' }, ctx).ok)
  assert.ok(g.apply('retail', { op: 'rename', id: 'Product.category', to: 'range' }, ctx).ok)
  const { schema } = g.state('retail')
  assert.deepEqual(schema.objects.Sale.arrows?.shop, 'Shop')
  assert.deepEqual(schema.conditions?.['frozen product'].where, [{ attribute: 'range', in: ['Frozen'] }])
  assert.deepEqual(schemaProblems(schema), [])
  assert.ok(check(schema, { measures: ['Sale.units'], by: [{ to: 'Region' }] }).ok)
})

test('an attribute promoted to an entity keeps its meaning: conditions keep to the entity along the new arrow', () => {
  const g = retailer()
  const r = g.apply('retail', { op: 'promote-attribute', id: 'Product.category', entity: 'Category' }, ctx)
  if (!r.ok) assert.fail(r.reason)
  const { schema } = g.state('retail')
  assert.deepEqual(schema.objects.Category.members, { Fresh: 'Fresh', Frozen: 'Frozen' })
  assert.deepEqual(schema.objects.Product.arrows?.category, { to: 'Category', partial: true })
  assert.deepEqual(schema.conditions?.['frozen product'].where, [{ to: 'Category', via: ['category'], in: ['Frozen'] }])
  const promoted: Instance = { ...data, elements: { ...data.elements, Category: { Fresh: {}, Frozen: {} }, Product: { p1: { arrows: { category: 'Fresh' } }, p2: { arrows: { category: 'Frozen' } } } } }
  const v = check(schema, { measures: ['Sale.units'], by: [{ to: 'Region' }], where: [{ condition: 'frozen product' }] })
  if (!v.ok) assert.fail(v.reason)
  assert.deepEqual(evaluate(schema, promoted, v.plan).rows, [['west', 3]], 'the same answer as before the promotion')
})

test('every change is kept with the node it touched, and a changed node counts its versions', () => {
  const g = retailer()
  g.apply('retail', { op: 'set', id: 'Store', property: 'description', value: 'A shop with a till.' }, { by: 'reviewer', reason: 'clearer' })
  const history = g.changes('retail', { id: 'Store' })
  assert.deepEqual(history.slice(0, 2).map((c) => [c.op, c.by]), [['set', 'reviewer'], ['add-entity', 'test']])
  assert.equal((g.db.prepare("SELECT version FROM g_node WHERE model = 'retail' AND id = 'Store'").get() as any).version, 2)
})

test('a model exported and imported back is the same model, each node a recorded operation', () => {
  const { sources } = toSqlite(branches, branchesData)
  const g = new ModelStore(':memory:')
  const r = g.import('branches', { schema: branches, sources, settings: { currency: 'AUD' } }, ctx)
  assert.deepEqual(r.refused, [])
  const out = g.export('branches')
  const sorted = (x: unknown): unknown => Array.isArray(x) ? x.map(sorted) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)])) : x
  assert.deepEqual(sorted(out.schema), sorted(branches))
  assert.deepEqual(sorted(out.sources), sorted(sources))
  assert.deepEqual(out.settings, { currency: 'AUD' })
  assert.equal(g.changes('branches', { limit: 1000 }).length, r.applied + 1)
})
