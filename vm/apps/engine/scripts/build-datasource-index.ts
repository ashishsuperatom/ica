// Bootstrap populator for the DATASOURCE INDEX — RESUMABLE. Enumerates each source's containers (Phase 0),
// then indexes the ones not already in the index (Phase N), persisting per container. Re-run to resume: it
// skips containers already indexed. The future connector agent replaces this as the live per-source updater.
//   DB=<project.sqlite> SEEDS_FILE=<project>/datasources/index-seeds.json [WIPE=1] [ONLY=<sourceId>] tsx scripts/build-datasource-index.ts
import { NodeStore, putEntries, dataSourceStats } from '@superatom/node-store'
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
    let containers: string[]
    try { containers = await indexer.listContainers(s.id, rawQuery, { seedTables: SEED_TABLES[s.id] }) }
    catch (e: any) { console.error(`  listContainers FAILED: ${e.message}`); continue }
    // RESUME: skip containers already in the index (the index table IS the done-state).
    const done = new Set<string>((store.db.prepare('SELECT DISTINCT container FROM datasource_index WHERE source=?').all(s.id) as any[]).map((r) => r.container))
    const todo = containers.filter((c) => !done.has(c))
    console.log(`  ${containers.length} containers · ${done.size} already indexed · ${todo.length} to do`)
    let i = 0, ok = 0, empty = 0, fields = 0
    for (const c of todo) {
      i++
      try {
        const entries = await indexer.indexContainer(s.id, c, rawQuery)
        if (entries.length) { putEntries(store, entries); ok++; fields += entries.length } else empty++
        if (i % 25 === 0 || i === todo.length) console.log(`  …${i}/${todo.length}  (${ok} indexed, ${empty} empty/absent, ${fields} fields)`)
      } catch { empty++ /* table absent or unqueryable → skip */ }
    }
    console.log(`  done: +${ok} containers, ${fields} new fields`)
  }
  console.log('\n=== index totals ===')
  console.table(dataSourceStats(store))
  store.close?.()
}
main().catch((e) => { console.error(e); process.exit(1) })
