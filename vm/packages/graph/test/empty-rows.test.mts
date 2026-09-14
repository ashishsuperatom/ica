// A relation read from rows keeps its declared columns when a span holds none of them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine, GraphStore, type Contract } from '../src/index.js'

const visits: Contract = { name: 'visits', kind: 'concept', description: 'Visits.', reads: { sources: ['LOG'], programs: [] }, params: {}, returns: 'relation',
  shape: { dimensions: { page: { column: 'page_id', label: 'page_name', history: 'stable' } },
           measures: { visits: { aggregate: 'count', unit: 'visits', kind: 'flow' }, seconds: { aggregate: 'sum', column: 'seconds', unit: 's', kind: 'flow' } }, time: 'visited_on' } }
const ROWS = [{ page_id: 'a', page_name: 'Home', seconds: 5, visited_on: '2026-09-01' }]

test('defined and asked over a span with no rows: the columns are there, the answer is empty', async () => {
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-empty-')), 'g.sqlite'))
  const engine = createEngine({ store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), dialects: {}, query: async () => [], today: () => '2026-09-14' })
  const body = `const R = ${JSON.stringify(ROWS)}
export default async (ctx, { from, to }) => ({ source: 'LOG', rows: R.filter((r) => r.visited_on >= from && r.visited_on < to) })`
  await engine.define({ body, contract: visits }, { by: 'test' })
  const empty = await engine.call<any>('visits', { measures: ['visits', 'seconds'], by: ['page'], during: { from: '2026-10-01', to: '2026-11-01' } })
  assert.deepEqual(empty.value.rows, [])
  const some = await engine.call<any>('visits', { measures: ['seconds'], by: ['page'], during: { from: '2026-09-01', to: '2026-10-01' } })
  assert.equal(some.value.rows[0].seconds, 5)
})
