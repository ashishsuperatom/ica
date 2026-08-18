// Local, self-contained test of the grounding module — NO Fly, NO external DB. Seeds a small "source" DB
// with realistic messy data, builds the grounding indexes, and exercises all three resolvers — including the
// central design property: a LIVE hierarchy resolves against the source at query time, so a row inserted
// AFTER the build shows up with no rebuild, while a MATERIALIZED copy goes stale (which is why we avoid it).
//   Run:  cd vm && pnpm exec tsx packages/grounding/src/grounding.test.ts
import Database from 'better-sqlite3'
import { GroundingStore, buildGrounding } from './index.js'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}  ${detail}`) } }

// ── a fake "source" DB (stands in for the project's real database) ──
const src = new Database(':memory:')
src.exec(`
  CREATE TABLE customer(id INTEGER, name TEXT);
  CREATE TABLE branch(id INTEGER, name TEXT);
  CREATE TABLE sn(sn_id INTEGER, name TEXT, branch_id INTEGER);   -- service-network: carries its parent branch key
  CREATE TABLE invoice(no TEXT);
`)
for (const [id, name] of [[1,'SRI SAI ROAD LINES'],[2,'SANDEEP LORRY SUPPLIERS HYD'],[3,'EVEREST TRANSPORT ORGANISATION HYD'],[4,'KIRBY BUILDING SYSTEMS AND STRUCTURES INDIA PVT LTD']] as [number,string][]) src.prepare(`INSERT INTO customer VALUES (?,?)`).run(id, name)
for (const [id, name] of [[1,'HYDERABAD'],[2,'MUMBAI']] as [number,string][]) src.prepare(`INSERT INTO branch VALUES (?,?)`).run(id, name)
for (const [sid, name, b] of [[10,'BALANAGAR',1],[11,'PASHAMYLARAM',1],[12,'MEDCHAL',1],[13,'ANDHERI',2]] as [number,string,number][]) src.prepare(`INSERT INTO sn VALUES (?,?,?)`).run(sid, name, b)
src.prepare(`INSERT INTO invoice VALUES (?)`).run('CGN/27/00123')
// Source runs SQL, binding @name params only when given (build queries have none; live hierarchy binds @id).
const source = (sql: string, _src?: string, params?: Record<string, unknown>) => params ? src.prepare(sql).all(params) : src.prepare(sql).all()

// ── build the grounding store (wired to the live source) ──
const g = new GroundingStore(':memory:', { source })
const built = await buildGrounding(g, source, {
  entities: [
    { type: 'customer', sql: 'SELECT id, name AS value FROM customer' },
    { type: 'branch',   sql: 'SELECT id, name AS value FROM branch' },
    { type: 'service_network', sql: 'SELECT sn_id AS id, name AS value FROM sn' },
  ],
  hierarchies: [
    // LIVE: the child row carries its parent key — resolve against the source, never copied.
    { name: 'branch-sn-live', entityType: 'branch', childType: 'service_network', resolver: 'column', oneToMany: true,
      spec: { table: 'sn', idCol: 'sn_id', parentCol: 'branch_id' } },
    // MATERIALIZED: same relationship, but copied into the edge table — to contrast staleness.
    { name: 'branch-sn-mat', entityType: 'branch', childType: 'service_network', resolver: 'materialized', oneToMany: true,
      spec: { childrenSql: 'SELECT branch_id AS parent_id, sn_id AS child_id FROM sn' } },
  ],
  patterns: [
    { name: 'invoice-no', regex: '^CGN/\\d+/\\d+$', entityType: 'invoice', location: 'invoice.no', howToFind: "SELECT * FROM invoice WHERE no = @v", confidence: 0.9 },
  ],
  aliases: [{ type: 'customer', id: 3, alias: 'Everest Transport' }],
})
console.log('built:', JSON.stringify(built), '(edges copied ONLY for the materialized hierarchy)')

console.log('\n[resolveEntity — fuzzy, per type]')
const r1 = g.resolveEntity('sri sae road lines')
ok('typo "sri sae road lines" → SRI SAI ROAD LINES', r1.byType.customer?.[0]?.ref.id == 1, JSON.stringify(r1.byType.customer?.[0]))
ok('"everest" → EVEREST… (via alias/fuzzy)', g.resolveEntity('everest').byType.customer?.[0]?.ref.id == 3)
ok('"kirby" → KIRBY…', g.resolveEntity('kirby').byType.customer?.[0]?.ref.id == 4)
ok('results grouped byType (never one flat list)', typeof r1.byType === 'object')

console.log('\n[resolveHierarchy — LIVE column resolution against the source]')
const kids = await g.resolveHierarchy({ type: 'branch', id: 1 }, 'descendants', 'branch-sn-live')
ok('Hyderabad branch → 3 service-networks', kids.length === 3, JSON.stringify(kids))
ok('children carry the child type (service_network)', kids.every((k) => k.type === 'service_network'))
ok('child ids are the localities', [10,11,12].every((id) => kids.some((k) => Number(k.id) === id)))
const anc = await g.resolveHierarchy({ type: 'service_network', id: 12 }, 'ancestors', 'branch-sn-live')
ok('MEDCHAL → ancestor branch = Hyderabad(1)', anc.length === 1 && Number(anc[0].id) === 1)

console.log('\n[getHierarchy — join knowledge for a program to compose into SQL]')
const hj = g.getHierarchy('branch-sn-live')
ok('getHierarchy returns the join key {table,idCol,parentCol}', hj?.spec.table === 'sn' && hj?.spec.idCol === 'sn_id' && hj?.spec.parentCol === 'branch_id', JSON.stringify(hj))
ok('getHierarchy carries the child type + resolver', hj?.childType === 'service_network' && hj?.resolver === 'column')

console.log('\n[resolveValueByPattern — identifier typing]')
ok('"CGN/27/00123" → invoice-no', (g.resolveValueByPattern('CGN/27/00123'))[0]?.ref.type === 'invoice')
ok('non-matching value → no pattern hit', g.resolveValueByPattern('just a name').length === 0)

console.log('\n[freshness — insert a new service-network AFTER the build, NO rebuild]')
src.prepare(`INSERT INTO sn VALUES (?,?,?)`).run(14, 'KOTHUR', 1)   // a new Hyderabad locality arrives in the source
const liveAfter = await g.resolveHierarchy({ type: 'branch', id: 1 }, 'descendants', 'branch-sn-live')
const matAfter  = await g.resolveHierarchy({ type: 'branch', id: 1 }, 'descendants', 'branch-sn-mat')
ok('LIVE hierarchy reflects the new row immediately (4)', liveAfter.length === 4, `got ${liveAfter.length}`)
ok('LIVE includes the newly-inserted KOTHUR (id 14)', liveAfter.some((k) => Number(k.id) === 14))
ok('MATERIALIZED copy is STALE (still 3 — why we avoid copying)', matAfter.length === 3, `got ${matAfter.length}`)

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
