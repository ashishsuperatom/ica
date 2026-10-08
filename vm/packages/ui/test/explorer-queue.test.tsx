// The explorer's reads, queued (components/semantic/Explorer.tsx · queued): one read in flight per lane (the rows, the
// analysis), a read whose asker has gone never sent, an analysis read only after the table has stayed a moment.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { queued } from '../src/components/semantic/Explorer.tsx'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
function backend() {
  const sent: string[] = []; let running = 0, most = 0
  const read = async (r: any) => { sent.push(`${r.op}:${r.table}`); running++; most = Math.max(most, running); await wait(30); running--; return r.table }
  return { read, sent, most: () => most }
}

test('rows: one in flight at a time; every asker still there is answered in order', async () => {
  const b = backend(), q = queued(b.read as any)
  const got = await Promise.all(['a', 'b', 'c'].map((t) => q({ table: t, op: 'rows', page: 1, size: 100, q: '', where: [] } as any)))
  assert.deepEqual(got, ['a', 'b', 'c'])
  assert.equal(b.most(), 1)
})

test('flipping through five tables: the analysis of the ones left is never sent; only the last runs', async () => {
  const b = backend(), q = queued(b.read as any)
  const askers = ['a', 'b', 'c', 'd', 'e'].map((t) => { const c = new AbortController(); return { c, p: q({ table: t, op: 'profile' } as any, c.signal).catch((e) => e.message) } })
  for (const a of askers.slice(0, 4)) a.c.abort()          // each table left before the next was opened
  const out = await Promise.all(askers.map((a) => a.p))
  assert.deepEqual(b.sent, ['profile:e'])
  assert.match(String(out[0]), /dropped/)
  assert.equal(out[4], 'e')
})

test('an analysis read waits a moment first: a table passed over within it never starts', async () => {
  const b = backend(), q = queued(b.read as any)
  const c = new AbortController()
  const p = q({ table: 'x', op: 'profile' } as any, c.signal).catch(() => 'dropped')
  await wait(100); c.abort()
  assert.equal(await p, 'dropped')
  assert.deepEqual(b.sent, [])
})
