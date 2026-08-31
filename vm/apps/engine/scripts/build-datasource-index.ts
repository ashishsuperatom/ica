// Bootstrap populator for the DATASOURCE INDEX — RESUMABLE. Enumerates each source's containers (Phase 0),
// then indexes the ones not already in the index (Phase N), persisting per container. Re-run to resume: it
// skips containers already indexed. The future connector agent replaces this as the live per-source updater.
//   DB=<project.sqlite> SEEDS_FILE=<project>/datasources/index-seeds.json [WIPE=1] [ONLY=<sourceId>] tsx scripts/build-datasource-index.ts
import { NodeStore, putEntries, applyRowCounts, dataSourceStats } from '@superatom/node-store'
import { getIndexer } from '../datasource-index/indexer.js'
import { readFileSync } from 'node:fs'

const DB = process.env.DB || ''
const MANAGER = process.env.MANAGER || 'http://localhost:4020'
const SEEDS_FILE = process.env.SEEDS_FILE || ''
const ONLY = process.env.ONLY || ''
const SEED_TABLES: Record<string, string[]> = SEEDS_FILE ? JSON.parse(readFileSync(SEEDS_FILE, 'utf8')) : {}
if (!DB) { console.error('set DB=<project.sqlite>'); process.exit(1) }

async function rawQuery(id: string, sql: string): Promise<any[]> {
  const r = await fetch(MANAGER + '/query', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, sql, raw: true }) })
  const j: any = await r.json(); if (j.error) throw new Error(j.error); return j.rows || []
}

async function main() {
  let sources: Array<{ id: string; dialect: string }> = await (await fetch(MANAGER + '/sources')).json().then((j: any) => j.sources || [])
  if (ONLY) sources = sources.filter((s) => s.id === ONLY)
  const store = new NodeStore(DB)
  if (process.env.WIPE === '1') { store.db.exec('DELETE FROM datasource_index' + (ONLY ? ` WHERE source='${ONLY}'` : '')); console.log('(wiped index' + (ONLY ? ' for ' + ONLY : '') + ')') }

  for (const s of sources) {
    console.log(`\n── ${s.id} [${s.dialect}] ──`)
    let indexer; try { indexer = getIndexer(s.dialect) } catch (e: any) { console.error('  ' + e.message); continue }
    // STEP 1 — enumerate every container FIRST (find all tables before indexing any).
    console.log(`  step 1 · enumerating containers…`)
    // The source's own catalog (via /introspect — for NetSuite this is the metadata-catalog) is the PRIMARY list.
    let catalogTables: string[] | undefined
    try {
      const j: any = await (await fetch(MANAGER + '/introspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: s.id }) })).json()
      const t = (j.tables || []).map((x: any) => String(x?.name ?? x ?? '')).filter(Boolean)
      if (t.length) { catalogTables = t; console.log(`  step 1 · catalog: ${t.length} tables from the source catalog`) }
    } catch { /* no catalog → type fallbacks (standard list, customrecordtype) */ }
    let containers: string[]
    try { containers = await indexer.listContainers(s.id, rawQuery, { seedTables: SEED_TABLES[s.id], catalogTables }) }
    catch (e: any) { console.error(`  step 1 FAILED: ${e.message}`); continue }
    const done = new Set<string>((store.db.prepare('SELECT DISTINCT container FROM datasource_index WHERE source=?').all(s.id) as any[]).map((r) => r.container))
    const todo = containers.filter((c) => !done.has(c))   // RESUME: skip containers already in the index (the index IS the done-state)
    console.log(`  step 1 · found ${containers.length} containers (${done.size} already indexed → ${todo.length} to do)`)
    // STEP 2 — index the remaining containers one by one, persisting each.
    if (todo.length) console.log(`  step 2 · indexing ${todo.length} containers…`)
    let i = 0, ok = 0, empty = 0, fields = 0
    for (const c of todo) {
      i++
      try {
        const entries = await indexer.indexContainer(s.id, c, rawQuery)
        if (entries.length) { putEntries(store, entries); ok++; fields += entries.length } else empty++
        if (i % 25 === 0 || i === todo.length) console.log(`  …${i}/${todo.length}  (${ok} indexed, ${empty} empty/absent, ${fields} fields)`)
      } catch { empty++ /* table absent or unqueryable → skip */ }
    }
    if (todo.length) console.log(`  step 2 · done: +${ok} containers, ${fields} new fields`)
    // STEP 3 — definitive row counts → auto-disable EMPTY containers so they never surface in search.
    // rowCounts() omits anything it couldn't count (timeout/unknown), so those stay enabled.
    if (indexer.rowCounts) {
      console.log(`  step 3 · row counts + disable empties…`)
      try {
        const { disabled, enabled } = applyRowCounts(store, s.id, await indexer.rowCounts(s.id, rawQuery))
        console.log(`  step 3 · ${disabled} empty → disabled, ${enabled} non-empty (kept)`)
      } catch (e: any) { console.warn(`  step 3 failed (all stay enabled): ${e.message}`) }
    }
    // Steps 4 (profile/cardinality/semantic-type/PII), 5 (link by value-overlap), 6 (AI describe) are LAZY
    // background enrichment — NOT built here. See the pipeline note at the top of datasource-index/indexer.ts.
  }
  console.log('\n=== index totals ===')
  console.table(dataSourceStats(store))
  store.close?.()
}
main().catch((e) => { console.error(e); process.exit(1) })
