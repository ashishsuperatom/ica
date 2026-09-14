// Bootstrap populator for the DATASOURCE INDEX — a thin CLI over datasource-index/build.ts, which the admin
// console also calls. One implementation, so a run from a terminal and a run from the console cannot differ.
//   DB=<db/datasource-index.sqlite> SEEDS_FILE=<project>/datasources/index-seeds.json [WIPE=1] [ONLY=<sourceId>] tsx scripts/build-datasource-index.ts
import { DataSourceIndex, dataSourceStats } from '@superatom/datasource-index'
import { buildDatasourceIndex } from '../datasource-index/build.js'
import { readFileSync } from 'node:fs'

const DB = process.env.DB || ''
const MANAGER = process.env.MANAGER || 'http://localhost:4020'
const SEEDS_FILE = process.env.SEEDS_FILE || ''
if (!DB) { console.error('set DB=<db/datasource-index.sqlite>'); process.exit(1) }

const store = new DataSourceIndex(DB)
buildDatasourceIndex({
  store,
  managerUrl: MANAGER,
  seedTables: SEEDS_FILE ? JSON.parse(readFileSync(SEEDS_FILE, 'utf8')) : {},
  only: process.env.ONLY || undefined,
  wipe: process.env.WIPE === '1',
  log: (line) => console.log(line),
})
  .then(() => { console.log('\n=== index totals ==='); console.table(dataSourceStats(store)); store.close?.() })
  .catch((e) => { console.error(e); process.exit(1) })
