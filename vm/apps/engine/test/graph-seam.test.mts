// The graph seam: reads and governed changes, as people and agents send them over the hub.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '@superatom/composition-graph'
import { createGraphSeam } from '../graph-seam.ts'

const dir = mkdtempSync(join(tmpdir(), 'graph-'))
const file = join(dir, 'composition.sqlite')
const legacy = new Store(file)
legacy.put('imported', 'concept', { title: 'Old', form: 'text', text: 'from the knowledge file' }, { by: 'import' })
legacy.put('private-note', 'concept', { title: 'Mine', form: 'text', text: 'only ana' }, { by: 'import' }, { scope: 'user:ana', owner: 'user:ana' })
legacy.close()

const out: any[] = []
const seam = createGraphSeam({ projectDir: dir, file, send: (_to, m) => out.push(m) })
const as = (from: any) => async (payload: any) => { await seam.handle(payload, from); return out.at(-1) }
// bot: a key with the publish scope (the hub says admin); reader: a key without it, whose new nodes start as its own.
const bot = as({ type: 'agent', userId: 'agent:key_1', admin: true }), reader = as({ type: 'agent', userId: 'agent:key_2' }), ana = as({ type: 'runtime', userId: 'ana' }), root = as({ type: 'runtime', userId: 'root', admin: true })
const concept = (text: string) => ({ title: 'Settlement', form: 'text', text })

test('an agent makes a concept and a domain, joins them, and reads them back; the history says who', async () => {
  assert.equal((await bot({ t: 'graph:concept', name: 'settlement', body: concept('A trip is settled when its settlement document exists.'), reason: 'from the data' })).changed, true)
  assert.equal((await bot({ t: 'graph:domain', name: 'trips', body: { capabilities: [], concepts: [], files: [] } })).node.owner, 'agent:key_1')
  assert.deepEqual((await bot({ t: 'graph:join', domain: 'trips', concept: 'settlement' })).node.body.concepts, ['settlement'])
  const comp = await bot({ t: 'graph:compose', domain: 'trips' })
  assert.match(comp.composition.text, /A trip is settled when its settlement document exists\./)
  assert.deepEqual((await bot({ t: 'graph:history', name: 'settlement' })).history.map((c: any) => [c.by, c.reason]), [['agent:key_1', 'from the data']])
})

test('a person suggests a change to the agent\'s concept; the agent approves it', async () => {
  assert.equal((await ana({ t: 'graph:concept', name: 'settlement', body: concept('mine now') })).reason, `"settlement" is agent:key_1's — suggest the change instead`)
  const sug = (await ana({ t: 'graph:suggest', name: 'settlement', kind: 'concept', body: concept('Settled: a settlement document exists for the trip.'), reason: 'clearer' })).suggestion
  assert.deepEqual((await bot({ t: 'graph:suggestions', status: 'open' })).suggestions.map((s: any) => s.id), [sug.id])
  assert.equal((await bot({ t: 'graph:decide', id: sug.id, verdict: 'approved', reason: 'yes' })).suggestion.status, 'approved')
  assert.equal((await ana({ t: 'graph:show', name: 'settlement' })).node.body.text, 'Settled: a settlement document exists for the trip.')
})

test('scopes: a person sees their own nodes and global ones, an agent only global and its own, an admin all', async () => {
  const names = async (ask: any) => (await ask({ t: 'graph:names', kind: 'concept' })).names.map((n: any) => n.name).sort()
  assert.deepEqual(await names(ana), ['imported', 'private-note', 'settlement'])
  assert.deepEqual(await names(reader), ['imported', 'settlement'])
  assert.deepEqual(await names(root), ['imported', 'private-note', 'settlement'])
  assert.equal((await reader({ t: 'graph:show', name: 'private-note' })).reason, 'there is no "private-note"')
  assert.equal((await reader({ t: 'graph:history', name: 'private-note' })).reason, 'there is no "private-note"')   // nor its history
  // a key that may not publish makes nodes that start as its own: it sees them, others do not until published
  assert.equal((await reader({ t: 'graph:concept', name: 'draft', body: concept('a draft') })).node.scope, 'user:key_2')
  assert.equal((await reader({ t: 'graph:concept', name: 'wide', body: concept('x'), scope: 'global' })).reason, 'a new "wide" starts as yours (user:key_2) — then suggest it for everyone (publish)')
  assert.deepEqual(await names(reader), ['draft', 'imported', 'settlement'])
  assert.deepEqual(await names(ana), ['imported', 'private-note', 'settlement'])
})

test('imported knowledge with no owner: only an admin changes it; refusals are sentences', async () => {
  assert.match((await ana({ t: 'graph:concept', name: 'imported', body: concept('x') })).reason, /has no owner — an admin changes it/)
  assert.equal((await root({ t: 'graph:concept', name: 'imported', body: concept('fixed by an admin') })).changed, true)
  assert.equal((await bot({ t: 'graph:decide', id: 99, verdict: 'approved' })).reason, 'there is no suggestion 99')
  assert.equal((await bot({ t: 'graph:decide', id: 1, verdict: 'maybe' })).reason, 'a verdict is approved, rejected or withdrawn')
  assert.equal((await bot({ t: 'graph:show', name: 'x', asOf: 'yesterday' })).reason, '"yesterday" is not a time')
  out.length = 0; await seam.handle({ t: 'graph:domains' }, { type: 'runtime' })
  assert.equal(out.at(-1).reason, 'the hub did not say who is asking')
})
