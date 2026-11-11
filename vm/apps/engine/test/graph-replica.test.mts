// The engine's replica of the composition graph: pulled from the platform, set aside and rebuilt whole when it differs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, replicaSince, changesFingerprint, type Cursor } from '@superatom/composition-graph/node'
import { createGraphReplica } from '../graph-replica.ts'

const concept = (text: string) => ({ form: 'text', title: 'A rule', text }) as any
const ctx = { by: 'platform', reason: 'test' }

test('a replica set aside while a pull is out drops that pull\'s reply and takes the whole graph — never the old pull\'s tail on an empty replica', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'replica-')); mkdirSync(join(dir, 'db'))
  // the platform's graph: five concepts
  const platform = openStore(join(dir, 'platform.sqlite'))
  for (const n of ['a', 'b', 'c', 'd', 'e']) platform.put(`rule/${n}`, 'concept', concept(n), ctx, {})
  // this engine's replica: the first two, but one written differently (it drifted)
  const file = join(dir, 'db', 'composition.sqlite')
  const drifted = openStore(file)
  drifted.put('rule/a', 'concept', concept('a'), ctx, {}); drifted.put('rule/b', 'concept', concept('B, edited here'), ctx, {})
  drifted.close()

  const sent: any[] = []
  const r = createGraphReplica({ file, send: (m) => (sent.push(m), true) })
  const batchFor = (from: Cursor) => ({ t: 'graph:batch', batch: replicaSince(platform, { ...from } as Cursor, 500), cursor: { change: 5, suggestion: 0, decisionAt: 0, version: 0 } })
  const lastPull = () => [...sent].reverse().find((m) => m.type === 'graph:pull')

  r.welcome()                                           // pull 1, from the replica's cursor (change 2)
  const pull1 = lastPull()
  r.onMessage(batchFor(pull1.cursor))                   // changes 3–5 arrive on top of the drifted replica
  r.onMessage(batchFor({ ...pull1.cursor, change: 5 })) // caught up: it asks for the fingerprint
  assert.ok(sent.some((m) => m.type === 'graph:fingerprint'))
  r.onMessage({ t: 'graph:changed' })                   // the platform changed meanwhile: pull 2, from change 5
  const pull2 = lastPull()
  const fp = await changesFingerprint(platform.db.prepare('SELECT id, name, to_hash FROM change').all() as any[])
  r.onMessage({ t: 'graph:fingerprint', ...fp })        // differs: set aside, rebuilt — pull 3, from the start
  await new Promise((res) => setTimeout(res, 20))
  const pull3 = lastPull()
  assert.equal(pull3.cursor.change, 0)
  r.onMessage(batchFor(pull2.cursor))                   // the old pull's reply: dropped
  r.onMessage(batchFor(pull3.cursor))                   // the whole graph
  r.onMessage(batchFor({ ...pull3.cursor, change: 5 }))

  const replica = openStore(file)
  assert.deepEqual(replica.names('concept').map((n) => n.name).sort(), ['rule/a', 'rule/b', 'rule/c', 'rule/d', 'rule/e'])
  assert.equal((replica.get('rule/b')!.body as any).text, 'b')   // the platform's, not the drifted one
})
