import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query } from '@superatom/scaffold'
import { GraphStore, createEngine } from '../src/index.ts'
const d = mkdtempSync(join(tmpdir(), 'tz-'))
const store = new GraphStore(join(d, 'g.sqlite'))
const engine = createEngine({ store, modulesDir: join(d, 'm'), query, dialects: { F5NETSUITE: 'oracle' } })
await engine.define({ body: `export default (ctx, { from, to }) => ({ source: 'F5NETSUITE', params: { from, to },
    sql: "SELECT tb.lastmodifieddate AS changed_at, 1 AS n FROM timebill tb WHERE tb.lastmodifieddate >= TO_DATE(@from, 'YYYY-MM-DD') - 2 AND tb.lastmodifieddate < TO_DATE(@to, 'YYYY-MM-DD') + 2" })`,
  contract: { name: 'changes', kind: 'concept', description: 'x', reads: { sources: ['F5NETSUITE'], programs: [] }, params: {}, returns: 'relation',
    shape: { dimensions: {}, measures: { changes: { aggregate: 'sum', column: 'n', unit: 'c', kind: 'flow' } }, time: 'changed_at', timeZone: 'UTC' } } }, { by: 't' })
for (const tz of [undefined, 'Pacific/Auckland']) {
  const r = await engine.call<any>('changes', { by: ['day'], during: { from: '2026-04-03', to: '2026-04-04' } }, tz ? { assume: { timezone: tz } } : {})
  console.log(tz, r.value.rows, '\n', store.getCall(r.callId)!.queries[0].sql)
}
const raw = await query('F5NETSUITE', `SELECT COUNT(*) AS n, SUM(1) AS s FROM timebill tb WHERE tb.lastmodifieddate >= TO_DATE('2026-04-01', 'YYYY-MM-DD') AND tb.lastmodifieddate < TO_DATE('2026-04-06', 'YYYY-MM-DD')`)
console.log(raw)
