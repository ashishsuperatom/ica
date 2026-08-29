// Bootstrap populator for the DATASOURCE INDEX — a thin caller of the per-type indexer registry (the future
// connector agent replaces this as the live, per-source updater). Run:
//   DB=<project.sqlite> MANAGER=http://localhost:4020 pnpm exec tsx scripts/build-datasource-index.ts
import { NodeStore, putEntries, dataSourceStats } from '@superatom/node-store'
import { buildEntries } from '../datasource-index/indexer.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DB = process.env.DB || ''            // project.sqlite (required — no project baked into the engine)
const MANAGER = process.env.MANAGER || 'http://localhost:4020'
// Per-source seed tables (for catalog-less types) live OUTSIDE the engine, in the project's datasource config.
// SEEDS_FILE points at <project>/datasources/index-seeds.json = { "<sourceId>": ["table", …] }.
const SEEDS_FILE = process.env.SEEDS_FILE || ''
const SEED_TABLES: Record<string, string[]> = SEEDS_FILE ? JSON.parse(readFileSync(SEEDS_FILE, 'utf8')) : {}
if (!DB) { console.error('set DB=<project.sqlite> (and optionally SEEDS_FILE=<project>/datasources/index-seeds.json)'); process.exit(1) }

async function rawQuery(id: string, sql: string): Promise<any[]> {
  const r = await fetch(MANAGER + '/query', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, sql, raw: true }) })
  const j: any = await r.json()
  if (j.error) throw new Error(j.error)
  return j.rows || []
}

async function main() {
  const sources: Array<{ id: string; dialect: string }> = await (await fetch(MANAGER + '/sources')).json().then((j: any) => j.sources || [])
  console.log(`sources: ${sources.map((s) => `${s.id}(${s.dialect})`).join(', ')}`)
  const store = new NodeStore(DB)
  if (process.env.WIPE === '1') { store.db.exec('DELETE FROM datasource_index'); console.log('(wiped existing index)') }
  let total = 0
  for (const s of sources) {
    console.log(`\n── ${s.id} [${s.dialect}] ──`)
    try {
      const entries = await buildEntries(s.dialect, s.id, rawQuery, { seedTables: SEED_TABLES[s.id] })
      if (entries.length) { putEntries(store, entries); total += entries.length }
      console.log(`  ${entries.length} fields`)
    } catch (e: any) { console.error(`  ${s.id} FAILED: ${e.message}`) }
  }
  console.log(`\n=== indexed ${total} fields ===`)
  console.table(dataSourceStats(store))
  store.close?.()
}
main().catch((e) => { console.error(e); process.exit(1) })
