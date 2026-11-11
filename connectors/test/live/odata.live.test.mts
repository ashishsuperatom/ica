// THE ODATA CONNECTOR, AS BUILT (connectors/dist/released.json — the exact module the engine loads), against the public
// read-only OData sample services: Northwind v4 and v2, and TripPin (v4, when it answers). Not part of `pnpm test` — it
// needs the internet:
//   pnpm -C connectors build && pnpm -C connectors exec tsx --test test/live/odata.live.test.mts
// Each service: found from what a person would paste, signed in (none), described (keys, links, references where the
// service declares them), read with filters, a raw $filter, $select, $orderby and paging, and counted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const RELEASED = JSON.parse(readFileSync(new URL('../../dist/released.json', import.meta.url), 'utf8')) as { manifest: { id: string }; code: string }[]
const dir = mkdtempSync(join(tmpdir(), 'live-odata-'))
async function load(settings: Record<string, unknown>) {
  const built = RELEASED.find((r) => r.manifest.id === 'odata'); assert.ok(built, 'odata is built (pnpm build)')
  const file = join(dir, 'odata.mjs'); writeFileSync(file, built.code)
  return (await import(pathToFileURL(file).href)).createBridge({ settings, secrets: {} })
}
const q = (c: any, query: unknown) => c.query(JSON.stringify(query))

test('Northwind v4 (pasted as an entity set\'s URL): described, filtered, selected, ordered, paged past the server\'s page, counted', async () => {
  const c = await load({ url: 'https://services.odata.org/V4/Northwind/Northwind.svc/Products?$top=3' })
  assert.match(await c.test(), /^OData v4 service at https:\/\/services\.odata\.org\/V4\/Northwind\/Northwind\.svc\/: 26 entity sets; read 1 row of Categories$/)
  const d = await c.introspect()
  assert.equal(d.tables.length, 26)
  const orders = d.tables.find((t: any) => t.name === 'Orders')
  assert.deepEqual(orders.columns[0], { name: 'OrderID', type: 'integer', key: true, nullable: false })
  assert.match(orders.description, /Customer → Customers \(one\)/)
  assert.equal(orders.columns.find((x: any) => x.name === 'OrderDate').type, 'timestamp')
  const sig = await c.signatures()
  assert.equal(Object.keys(sig).length, 26)
  const rows = await q(c, { entity: 'Products', filters: { CategoryID: 1 }, filter: 'UnitPrice gt 15', select: ['ProductID', 'ProductName', 'UnitPrice'], orderby: 'UnitPrice desc', limit: 5 })
  assert.ok(rows.length >= 3 && rows.length <= 5)
  assert.deepEqual(Object.keys(rows[0]).sort(), ['ProductID', 'ProductName', 'UnitPrice'])
  assert.ok(rows.every((r: any, i: number) => r.UnitPrice > 15 && (i === 0 || rows[i - 1].UnitPrice >= r.UnitPrice)))
  assert.equal(rows[0].ProductName, 'Côte de Blaye')
  const customers = await q(c, { entity: 'Customers', limit: 45 })   // the service pages by 20: two next links followed
  assert.equal(customers.length, 45)
  assert.equal(new Set(customers.map((r: any) => r.CustomerID)).size, 45)
  assert.deepEqual(await q(c, { entity: 'Customers', count: true }), [{ count: 91 }])
  assert.deepEqual(await q(c, { entity: 'Customers', filters: { Country: ['Mexico', 'Canada'] }, count: true }), [{ count: 8 }])
  assert.deepEqual((await q(c, { entity: 'Customers', filters: { CustomerID: "O'Neil" } })), [])   // a quote in a value stays a value
  const late = await q(c, { entity: 'Orders', filter: 'OrderDate ge 1998-05-01T00:00:00Z', select: ['OrderID', 'OrderDate'], orderby: 'OrderDate', limit: 3 })
  assert.ok(late.length === 3 && late.every((r: any) => r.OrderDate >= '1998-05-01'))
})

test('Northwind v2 (pasted as its $metadata URL): references from its associations, d.__next followed, /Date()/ read as ISO, a decimal and a date filtered as v2 writes them', async () => {
  const c = await load({ url: 'https://services.odata.org/V2/Northwind/Northwind.svc/$metadata' })
  assert.match(await c.test(), /^OData v2 service at https:\/\/services\.odata\.org\/V2\/Northwind\/Northwind\.svc\/: 26 entity sets; read 1 row of Categories$/)
  const d = await c.introspect()
  const orders = d.tables.find((t: any) => t.name === 'Orders')
  assert.equal(orders.columns.find((x: any) => x.name === 'CustomerID').references, 'Customers.CustomerID')
  assert.equal(orders.columns.find((x: any) => x.name === 'EmployeeID').references, 'Employees.EmployeeID')
  assert.equal(d.tables.find((t: any) => t.name === 'Products').columns.find((x: any) => x.name === 'CategoryID').references, 'Categories.CategoryID')
  const customers = await q(c, { entity: 'Customers', limit: 30 })
  assert.equal(customers.length, 30)
  assert.equal('__metadata' in customers[0], false); assert.equal('Orders' in customers[0], false)
  const products = await q(c, { entity: 'Products', filters: { UnitPrice: 18 }, select: ['ProductID', 'ProductName', 'UnitPrice'] })
  assert.ok(products.length >= 1 && products.every((p: any) => p.UnitPrice === 18))
  const ordered = await q(c, { entity: 'Orders', filters: { OrderDate: '1996-07-04' }, select: ['OrderID', 'OrderDate', 'Freight'] })
  assert.deepEqual(ordered, [{ OrderID: 10248, OrderDate: '1996-07-04T00:00:00.000Z', Freight: 32.38 }])
  assert.deepEqual(await q(c, { entity: 'Orders', filter: "ShipCountry eq 'France'", count: true }), [{ count: 77 }])
})

test('TripPin (pasted as an entity set\'s URL, its $metadata 500 there): found above it; complex and collection properties as JSON; a raw filter', async (t) => {
  let c: any
  try { c = await load({ url: 'https://services.odata.org/TripPinRESTierService/People' }); await c.test() } catch (e: any) { t.skip(`TripPin did not answer: ${e?.message ?? e}`); return }
  assert.match(await c.test(), /^OData v4 service at https:\/\/services\.odata\.org\/TripPinRESTierService\/: \d+ entity sets; read 1 row of People$/)
  const people = (await c.introspect()).tables.find((x: any) => x.name === 'People')
  assert.deepEqual(people.columns.filter((x: any) => x.key).map((x: any) => x.name), ['UserName'])
  assert.equal(people.columns.find((x: any) => x.name === 'AddressInfo').type, 'json')
  const rows = await q(c, { entity: 'People', filter: "FirstName eq 'Russell'", select: ['UserName', 'FirstName', 'Emails'] })
  assert.deepEqual(rows.map((r: any) => r.UserName), ['russellwhyte'])
  assert.ok(Array.isArray(rows[0].Emails))
})
