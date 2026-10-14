// The same small enterprise dataset, written for each database the live tests run (up.sh): regions, customers, products,
// orders and their lines — deterministic, so every database holds exactly the same rows and the same answers.
//   node seed.mjs <postgres|mysql|mssql|oracle|clickhouse|mongo>   → its statements (or, for mongo, a mongosh script) on stdout

let s = 42
const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)
const pick = (a) => a[Math.floor(rnd() * a.length)]

const regions = [[1, 'North'], [2, 'South'], [3, 'East'], [4, 'West'], [5, 'Central']]
const customers = Array.from({ length: 200 }, (_, i) => [i + 1, `Customer ${String(i + 1).padStart(3, '0')}`, pick(regions)[0], pick(['Enterprise', 'Mid-market', 'Small business'])])
const categories = ['Valves', 'Pipes', 'Pumps', 'Fittings', 'Sensors']
const products = Array.from({ length: 50 }, (_, i) => [i + 1, `Product ${String(i + 1).padStart(2, '0')}`, categories[i % categories.length], Math.round((5 + rnd() * 495) * 100) / 100])
const orders = [], lines = []
let line = 1
for (let i = 1; i <= 2000; i++) {
  const day = new Date(Date.UTC(2025, 0, 1) + Math.floor(rnd() * 540) * 86_400_000).toISOString().slice(0, 10)
  orders.push([i, pick(customers)[0], day, pick(['open', 'shipped', 'invoiced', 'cancelled'])])
  for (let k = 0, n = 1 + Math.floor(rnd() * 4); k < n; k++) { const p = pick(products); lines.push([line++, i, p[0], 1 + Math.floor(rnd() * 20), p[3]]) }
}

const q = (v) => (typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)
const db = process.argv[2]
const D = { postgres: 'DATE', mysql: 'DATE', mssql: 'DATE', oracle: 'DATE', clickhouse: 'Date' }[db]
const N = { postgres: 'NUMERIC(10,2)', mysql: 'DECIMAL(10,2)', mssql: 'DECIMAL(10,2)', oracle: 'NUMBER(10,2)', clickhouse: 'Decimal(10,2)' }[db]
const T = { postgres: 'VARCHAR(100)', mysql: 'VARCHAR(100)', mssql: 'NVARCHAR(100)', oracle: 'VARCHAR2(100)', clickhouse: 'String' }[db]
const I = { postgres: 'INTEGER', mysql: 'INT', mssql: 'INT', oracle: 'NUMBER(10)', clickhouse: 'Int32' }[db]
const date = (d) => (db === 'oracle' ? `DATE '${d}'` : `'${d}'`)

if (db === 'mongo') {
  const docs = (rows, f) => JSON.stringify(rows.map(f))
  console.log(`db = db.getSiblingDB('sales');
db.regions.insertMany(${docs(regions, (r) => ({ region_id: r[0], name: r[1] }))});
db.customers.insertMany(${docs(customers, (c) => ({ customer_id: c[0], name: c[1], region_id: c[2], segment: c[3] }))});
db.products.insertMany(${docs(products, (p) => ({ product_id: p[0], name: p[1], category: p[2], price: p[3] }))});
db.orders.insertMany(${docs(orders, (o) => ({ order_id: o[0], customer_id: o[1], ordered_on: { $date: `${o[2]}T00:00:00Z` }, status: o[3], lines: lines.filter((l) => l[1] === o[0]).map((l) => ({ product_id: l[2], quantity: l[3], unit_price: l[4] })) }))}.map((d) => ({ ...d, ordered_on: new Date(d.ordered_on.$date) })));`)
} else {
  const engine = db === 'clickhouse' ? ' ENGINE = MergeTree ORDER BY tuple()' : ''
  const pk = db === 'clickhouse' ? '' : ' PRIMARY KEY'
  const out = []
  out.push(`CREATE TABLE regions (region_id ${I}${pk}, name ${T})${engine}`)
  out.push(`CREATE TABLE customers (customer_id ${I}${pk}, name ${T}, region_id ${I}, segment ${T})${engine}`)
  out.push(`CREATE TABLE products (product_id ${I}${pk}, name ${T}, category ${T}, price ${N})${engine}`)
  out.push(`CREATE TABLE orders (order_id ${I}${pk}, customer_id ${I}, ordered_on ${D}, status ${T})${engine}`)
  out.push(`CREATE TABLE order_lines (line_id ${I}${pk}, order_id ${I}, product_id ${I}, quantity ${I}, unit_price ${N})${engine}`)
  const ins = (table, rows, f = (r) => r.map(q)) => {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200)
      if (db === 'oracle') out.push(`INSERT ALL ${chunk.map((r) => `INTO ${table} VALUES (${f(r).join(', ')})`).join(' ')} SELECT 1 FROM DUAL`)
      else out.push(`INSERT INTO ${table} VALUES ${chunk.map((r) => `(${f(r).join(', ')})`).join(', ')}`)
    }
  }
  ins('regions', regions); ins('customers', customers); ins('products', products)
  ins('orders', orders, (o) => [q(o[0]), q(o[1]), date(o[2]), q(o[3])]); ins('order_lines', lines)
  const sep = db === 'mssql' ? '\nGO\n' : db === 'oracle' ? '\n/\n' : ';\n'
  console.log(out.join(sep) + (db === 'mssql' ? '\nGO' : db === 'oracle' ? '\n/' : ';'))
}
