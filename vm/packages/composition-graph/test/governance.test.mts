import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.ts'
import { governance as g, GovernanceRefusal } from '../src/index.ts'

const fresh = () => new Store(join(mkdtempSync(join(tmpdir(), 'gov-')), 'composition.sqlite'))
const ana = { id: 'user:ana' }, bo = { id: 'user:bo' }, bot = { id: 'agent:key_1' }, admin = { id: 'user:root', admin: true }
const text = (t: string) => ({ title: 'Settlement', form: 'text', text: t })

test('a new node is made by whoever writes it and is theirs; only they (or an admin) change it', () => {
  const s = fresh()
  assert.equal(g.write(s, bot, 'settlement', 'concept', text('A trip is settled when its settlement document exists.')).changed, true)
  assert.equal(s.get('settlement')!.owner, 'agent:key_1')
  assert.throws(() => g.write(s, ana, 'settlement', 'concept', text('changed')), (e: any) => e instanceof GovernanceRefusal && e.message === `"settlement" is agent:key_1's — suggest the change instead`)
  g.write(s, bot, 'settlement', 'concept', text('Settled: a settlement document exists for the trip.'))
  g.write(s, admin, 'settlement', 'concept', text('Settled: its settlement document exists.'))
  assert.equal(s.get('settlement')!.owner, 'agent:key_1')                      // an admin's edit does not take ownership
  assert.deepEqual(s.history('settlement').map((c) => c.by), ['agent:key_1', 'agent:key_1', 'user:root'])
})

test('bodies and names are checked; a domain may only name concepts that exist', () => {
  const s = fresh()
  assert.throws(() => g.write(s, ana, 'x', 'concept', { title: 'X', form: 'text' }), /a text concept has its text/)
  assert.throws(() => g.write(s, ana, 'x', 'concept', { title: 'X', form: 'poem', text: 'y' }), /form is text, bullets, numbered or worked/)
  assert.throws(() => g.write(s, ana, 'bad name', 'concept', text('y')), /is not a name/)
  assert.throws(() => g.write(s, ana, 'x', 'setting', { value: 1 }), /a setting is not changed this way/)
  assert.throws(() => g.write(s, ana, 'trips', 'domain', { capabilities: [], concepts: ['nope'], files: [] }), /names a concept that does not exist: "nope"/)
})

test('join and leave change the domain, by its owner, in order, at a position', () => {
  const s = fresh()
  g.write(s, ana, 'a', 'concept', text('A')); g.write(s, ana, 'b', 'concept', text('B')); g.write(s, ana, 'c', 'concept', text('C'))
  g.write(s, ana, 'trips', 'domain', { capabilities: [], concepts: ['a'], files: [] })
  g.compose(s, ana, 'trips', 'c', {})
  g.compose(s, ana, 'trips', 'b', { at: 1 })
  assert.deepEqual((s.get('trips')!.body as any).concepts, ['a', 'b', 'c'])
  g.compose(s, ana, 'trips', 'a', { leave: true })
  assert.deepEqual((s.get('trips')!.body as any).concepts, ['b', 'c'])
  assert.throws(() => g.compose(s, bo, 'trips', 'a', {}), /"trips" is user:ana's — suggest the change instead/)
  assert.throws(() => g.compose(s, ana, 'trips', 'a', { leave: true }), /"a" is not in "trips"/)
})

test('others suggest; the owner approves (applied, recorded with where it came from) or rejects; the suggester may withdraw', () => {
  const s = fresh()
  g.write(s, ana, 'settlement', 'concept', text('v1'))
  assert.throws(() => g.suggest(s, bo, 'settlement', 'concept', text('v2'), ''), /a suggestion says why/)
  assert.throws(() => g.suggest(s, bo, 'settlement', 'concept', text('v1'), 'same'), /already says/)
  assert.throws(() => g.suggest(s, bo, 'new-one', 'concept', text('v'), 'why'), /a new concept is made, not suggested/)
  const one = g.suggest(s, bo, 'settlement', 'concept', text('v2'), 'clearer')
  assert.equal(one.status, 'open')
  assert.throws(() => g.decide(s, bo, one.id, 'approved'), /only user:ana \(the owner\) or an admin decides on suggestion 1/)
  const done = g.decide(s, ana, one.id, 'approved', 'agreed')
  assert.equal(done.status, 'approved'); assert.equal(done.decidedBy, 'user:ana')
  assert.equal((s.get('settlement')!.body as any).text, 'v2')
  const last = s.history('settlement').at(-1)!
  assert.equal(last.by, 'user:ana'); assert.equal(last.from, 'suggestion:1'); assert.match(last.reason!, /^approved suggestion 1 by user:bo: clearer — agreed$/)
  assert.throws(() => g.decide(s, ana, one.id, 'rejected'), /was already approved/)
  const two = g.suggest(s, bot, 'settlement', 'concept', text('v3'), 'shorter')
  assert.equal(g.decide(s, ana, two.id, 'rejected', 'no').status, 'rejected')
  assert.equal((s.get('settlement')!.body as any).text, 'v2')
  const three = g.suggest(s, bot, 'settlement', 'concept', text('v4'), 'again')
  assert.throws(() => g.decide(s, bo, three.id, 'withdrawn'), /only the one who suggested it withdraws it/)
  assert.equal(g.decide(s, bot, three.id, 'withdrawn').status, 'withdrawn')
  assert.deepEqual(g.list(s, { name: 'settlement' }).map((x) => [x.id, x.status]), [[3, 'withdrawn'], [2, 'rejected'], [1, 'approved']])
})

test('a suggestion made before the node changed is not approved as if nothing happened', () => {
  const s = fresh()
  g.write(s, ana, 'settlement', 'concept', text('v1'))
  const sug = g.suggest(s, bo, 'settlement', 'concept', text('bo says'), 'mine')
  g.write(s, ana, 'settlement', 'concept', text('v2'))
  assert.throws(() => g.decide(s, ana, sug.id, 'approved'), /changed after suggestion 1 was made/)
  assert.equal(g.get(s, sug.id)!.status, 'open')                                  // nothing recorded by the refusal
  assert.equal(g.decide(s, ana, sug.id, 'rejected', 'stale').status, 'rejected')
})

test('a node with no owner (imported knowledge) is changed or decided only by an admin; history is append-only', () => {
  const s = fresh()
  s.put('legacy', 'concept', text('imported'), { by: 'import' })
  assert.throws(() => g.write(s, ana, 'legacy', 'concept', text('x')), /has no owner — an admin changes it/)
  const sug = g.suggest(s, ana, 'legacy', 'concept', text('better'), 'fix')
  assert.throws(() => g.decide(s, ana, sug.id, 'approved'), /has no owner — an admin decides/)
  assert.equal(g.decide(s, admin, sug.id, 'approved').status, 'approved')
  assert.throws(() => s.db.exec('DELETE FROM decision'), /decisions are append-only/)
  assert.throws(() => s.db.exec("UPDATE suggestion SET reason = 'x'"), /suggestions are append-only/)
})
