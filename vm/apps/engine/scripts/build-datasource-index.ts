// Bootstrap populator for the DATASOURCE INDEX — a thin CLI over datasource-index/build.ts, which the admin
// console also calls. One implementation, so a run from a terminal and a run from the console cannot differ.
//   DB=<db/datasource-index.sqlite> [WIPE=1] [ONLY=<sourceId>] tsx scripts/build-datasource-index.ts
// The tables of each source come from the source itself (its bridge's introspect).
import { DataSourceIndex, dataSourceStats } from '@superatom/datasource-index'
import { buildDatasourceIndex } from '../datasource-index/build.js'

const DB = process.env.DB || ''
const MANAGER = process.env.MANAGER || 'http://localhost:4020'
if (!DB) { console.error('set DB=<db/datasource-index.sqlite>'); process.exit(1) }

const store = new DataSourceIndex(DB)
buildDatasourceIndex({
  store,
  managerUrl: MANAGER,
  only: process.env.ONLY || undefined,
  wipe: process.env.WIPE === '1',
  log: (line) => console.log(line),
})
  .then(() => { console.log('\n=== index totals ==='); console.table(dataSourceStats(store)); store.close?.() })
  .catch((e) => { console.error(e); process.exit(1) })
