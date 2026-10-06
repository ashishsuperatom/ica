import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.ts'
import { governance as g, GovernanceRefusal, compose as composeDomain, publishDraft, publishedUpto, draft, restoreVersion, versionLine, route } from '../src/index.ts'

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
  assert.throws(() => g.write(s, ana, 'x', 'concept', { title: 'X', form: 'poem', text: 'y' }), /form is text, bullets, numbered, worked, or composed/)
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

test('an agent is a node like any other: checked, owned, governed, its domain must exist', () => {
  const s = fresh()
  g.write(s, ana, 'c1', 'concept', text('one'))
  g.write(s, ana, 'trips', 'domain', { capabilities: [], concepts: ['c1'], files: [] })
  assert.throws(() => g.write(s, ana, 'vehicle-trips', 'agent', { title: 'Vehicle trips', domain: 'nope', programs: [] }), /names a domain that does not exist: "nope"/)
  assert.throws(() => g.write(s, ana, 'vehicle-trips', 'agent', { domain: 'trips', programs: [] }), /an agent has a title/)
  // A new node starts as its maker's; placing it in a group or for everyone is publishing (an admin decides).
  assert.throws(() => g.write(s, ana, 'vehicle-trips', 'agent', { title: 'Vehicle trips', domain: 'trips', programs: ['unsettled-trips'], ica: 'composer' }, {}, { scope: 'group:ops' }), /starts as yours \(user:ana\)/)
  g.write(s, ana, 'vehicle-trips', 'agent', { title: 'Vehicle trips', domain: 'trips', programs: ['unsettled-trips'], ica: 'composer' })
  const a = s.get('vehicle-trips')!
  assert.equal(a.kind, 'agent'); assert.equal(a.owner, 'user:ana'); assert.equal(a.scope, 'user:ana')
  g.write(s, admin, 'ops-trips', 'agent', { title: 'Ops trips', domain: 'trips', programs: [] }, {}, { scope: 'group:ops' })
  assert.equal(s.get('ops-trips')!.scope, 'group:ops')
  assert.throws(() => g.write(s, bo, 'vehicle-trips', 'agent', { title: 'mine', domain: 'trips', programs: [] }), /suggest the change instead/)
})

test('publishing is decided: a person cannot widen their own node; they suggest it, an admin approves, the scope changes and nothing else', () => {
  const s = fresh()
  g.write(s, ana, 'mine', 'concept', text('Ana\'s way of reading settlement.'), {}, { scope: 'user:ana' })
  assert.throws(() => g.write(s, ana, 'mine', 'concept', text('Ana\'s way of reading settlement.'), {}, { scope: 'global' }), /is decided by an admin — suggest it \(publish\)/)
  assert.throws(() => g.publish(s, bo, 'mine', 'global', 'it is good'), /only user:ana or an admin publishes/)
  assert.throws(() => g.publish(s, ana, 'mine', 'user:ana', 'same'), /already seen at least that widely/)
  const sug = g.publish(s, ana, 'mine', 'group:finance', 'finance should read it this way')
  assert.equal(sug.scope, 'group:finance')
  assert.throws(() => g.decide(s, ana, sug.id, 'approved'), /publishing "mine" is decided by an admin/)
  const before = s.get('mine')!.hash
  g.decide(s, admin, sug.id, 'approved', 'agreed')
  assert.equal(s.get('mine')!.scope, 'group:finance')
  assert.equal(s.get('mine')!.hash, before)
  assert.equal(g.write(s, admin, 'mine', 'concept', text('Ana\'s way of reading settlement.'), {}, { scope: 'global' }).changed !== undefined, true)   // an admin may widen directly
})

test('two levels: a domain composes intermediate concepts, an intermediate composes atomic ones; attach and detach at either', () => {
  const s = fresh()
  g.write(s, admin, 'rag', 'concept', text('RAG is the worst of four.'))
  g.write(s, admin, 'pillar', 'concept', text('A pillar is a department tree.'))
  g.write(s, admin, 'health', 'concept', { title: 'Project health', form: 'composed', text: 'How a project is judged.', concepts: ['rag'] })
  g.write(s, admin, 'pmo', 'domain', { capabilities: [], concepts: [], files: [] })
  g.compose(s, admin, 'pmo', 'health', {})                                   // a domain takes an intermediate
  g.compose(s, admin, 'health', 'pillar', {})                                // an intermediate takes an atomic
  assert.deepEqual((s.get('health')!.body as any).concepts, ['rag', 'pillar'])
  const text1 = composeDomain(s, 'pmo').text
  assert.match(text1, /# Project health\nHow a project is judged\.\n\n## Settled|# Project health\nHow a project is judged\.\n\n## /)
  assert.ok(text1.indexOf('RAG is the worst') < text1.indexOf('A pillar is'))   // in its order
  // the levels hold
  assert.throws(() => g.compose(s, admin, 'health', 'health', {}), /intermediate concept — an intermediate concept is made of atomic ones/)
  g.write(s, admin, 'other', 'concept', { title: 'Other', form: 'composed', concepts: [] })
  assert.throws(() => g.compose(s, admin, 'other', 'health', {}), /made of atomic ones/)
  assert.throws(() => g.write(s, admin, 'rag', 'concept', { title: 'RAG', form: 'composed', concepts: [] }), /is a part of "health" — a part stays atomic/)
  assert.throws(() => g.compose(s, admin, 'rag', 'pillar', {}), /no domain or intermediate concept "rag"/)
  // detach
  g.compose(s, admin, 'health', 'rag', { leave: true })
  assert.deepEqual((s.get('health')!.body as any).concepts, ['pillar'])
  assert.throws(() => g.compose(s, admin, 'health', 'rag', { leave: true }), /"rag" is not in "health"/)
  assert.doesNotMatch(composeDomain(s, 'pmo').text, /RAG is the worst/)
})

test('edits are a draft; publishing makes the next version, which the agents read; discarding sets the draft back', () => {
  const s = fresh()
  g.write(s, admin, 'a', 'concept', text('first'))
  g.write(s, admin, 'd', 'domain', { capabilities: [], concepts: ['a'], files: [] })
  assert.equal(publishedUpto(s), undefined)                                   // nothing published: the agents read the graph as it is
  assert.throws(() => publishDraft(s, ana, 'x'), /may publish/)
  assert.throws(() => publishDraft(s, admin, ''), /what changed/)
  const v1 = publishDraft(s, admin, 'the first shape')
  assert.equal(v1.name, 'v1')
  assert.deepEqual(draft(s), [])
  assert.throws(() => publishDraft(s, admin, 'again'), /nothing in the draft/)
  g.write(s, admin, 'a', 'concept', text('second'))
  g.write(s, admin, 'b', 'concept', text('new one'))
  assert.deepEqual(draft(s).map((x) => [x.name, x.was !== null, x.now !== null]), [['a', true, true], ['b', false, true]])
  // the agents still read v1
  assert.match(composeDomain(s, 'd', undefined, { upto: publishedUpto(s) }).text, /first/)
  // discard: the draft is v1 again — nothing to publish, though the log grew
  assert.deepEqual(restoreVersion(s, admin, 'v1').sort(), ['a', 'b'])
  assert.deepEqual(draft(s), [])
  g.write(s, admin, 'a', 'concept', text('second'))
  const v2 = publishDraft(s, admin, 'a rewritten')
  assert.equal(v2.name, 'v2')
  assert.match(composeDomain(s, 'd', undefined, { upto: publishedUpto(s) }).text, /second/)
  assert.equal(route(s, 'second', publishedUpto(s)).ranked[0].domain, 'd')
  assert.throws(() => s.db.exec('DELETE FROM version'), /append-only/)
})

test('published versions form a tree: bringing an older one back and publishing starts a new line from it', () => {
  const s = fresh()
  g.write(s, admin, 'a', 'concept', text('A1')); publishDraft(s, admin, 'one')
  g.write(s, admin, 'a', 'concept', text('A2')); publishDraft(s, admin, 'two')
  restoreVersion(s, admin, 'v1'); g.write(s, admin, 'b', 'concept', text('B')); publishDraft(s, admin, 'from one again')
  g.write(s, admin, 'c', 'concept', text('C')); publishDraft(s, admin, 'four')
  assert.deepEqual(versionLine(s).map((v) => [v.name, v.parent, v.restoredFrom]), [['v1', null, null], ['v2', 'v1', null], ['v3', 'v1', 'v1'], ['v4', 'v3', null]])
})

test('a node made before names were plain keeps its name and can still be changed; a new one is named plainly', () => {
  const s = fresh()
  g.write(s, ana, 'a', 'concept', text('A'))
  s.put('trips and money', 'domain', { capabilities: [], concepts: [], files: [] }, { by: 'user:ana' }, { owner: 'user:ana' })
  g.compose(s, ana, 'trips and money', 'a', {})
  assert.deepEqual((s.get('trips and money')!.body as any).concepts, ['a'])
  assert.throws(() => g.write(s, ana, 'another one', 'domain', { capabilities: [], concepts: [], files: [] }), /is not a name/)
})
