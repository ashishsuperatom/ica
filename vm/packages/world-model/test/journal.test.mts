// What the world model's infrastructure guarantees, whoever hosts it: the journal is the truth and is append-only; a
// decision is stored before it is returned; everything computed is rebuilt from the journal alone; the cache is only a
// shortcut; an outcome may arrive after a restart; models share one journal and read only their own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine, memoryJournal, memoryCache, readAll, type Clock } from '../src/index.ts'
import { fileJournal, fileCache } from '../src/node.ts'

const clock = (): Clock => { let t = 1_000; return { now: () => ++t } }
const FP = 'fp-a', ACTIONS = ['approve', 'escalate']

/** A model that has learned: n decisions in situation FP, each with an outcome (escalate good, approve bad). */
async function teach(journal = memoryJournal(), cache = memoryCache(), n = 12) {
  const engine = await createEngine({ model: 'approvals', journal, cache, clock: clock() })
  for (let i = 0; i < n; i++) {
    const action = i % 2 ? 'approve' : 'escalate'
    const d = await engine.decide(FP, ACTIONS, { user: 'u1' }, action)
    await engine.recordOutcome(d.decisionId, action === 'escalate')
  }
  return { engine, journal, cache }
}

test('the journal is append-only, in order, and read on from a cursor, page by page', async () => {
  const j = memoryJournal()
  assert.equal(await j.append([{ at: 1, model: 'm', kind: 'k', data: 1 }, { at: 2, model: 'm', kind: 'k', data: 2 }]), 2)
  assert.equal(await j.append([{ at: 3, model: 'm', kind: 'k', data: 3 }]), 3)
  const first = await j.read(0, 2)
  assert.deepEqual(first.entries.map((e) => e.seq), [1, 2])
  assert.deepEqual((await j.read(first.next)).entries.map((e) => e.data), [3])
  const all: number[] = []
  for await (const e of readAll(j, 0, 1)) all.push(e.seq)
  assert.deepEqual(all, [1, 2, 3])
})

test('a decision is stored before it is returned — nothing is shown that the journal does not hold', async () => {
  const journal = memoryJournal()
  const engine = await createEngine({ model: 'approvals', journal, cache: memoryCache(), clock: clock() })
  const d = await engine.decide(FP, ACTIONS)
  const kept = journal.entries.find((e) => e.kind === 'decision')!
  assert.equal((kept.data as { decisionId: string }).decisionId, d.decisionId)
  assert.equal(kept.model, 'approvals')
})

test('everything computed is rebuilt from the journal alone: a fresh engine with no cache decides exactly the same', async () => {
  const { engine, journal } = await teach()
  const again = await createEngine({ model: 'approvals', journal, cache: memoryCache(), clock: clock() })
  assert.deepEqual(again.tree.toJSON(), engine.tree.toJSON())
  const a = await engine.decide(FP, ACTIONS, { user: 'u1' }), b = await again.decide(FP, ACTIONS, { user: 'u1' })
  assert.equal(b.action, a.action)
  assert.equal(b.action, 'escalate')                                      // what it learned
})

test('the cache is only a shortcut: opening from it plus the journal after it equals opening from the journal alone', async () => {
  const { engine, journal, cache } = await teach()
  await engine.saveCache()
  const more = await engine.decide(FP, ACTIONS, {}, 'escalate')            // written after the cache was saved
  await engine.recordOutcome(more.decisionId, true)
  const fromCache = await createEngine({ model: 'approvals', journal, cache, clock: clock() })
  const fromJournal = await createEngine({ model: 'approvals', journal, cache: memoryCache(), clock: clock() })
  assert.deepEqual(fromCache.tree.toJSON(), fromJournal.tree.toJSON())
})

test('an outcome that arrives after a restart is still learned — a decision stays open until its outcome comes', async () => {
  const journal = memoryJournal(), cache = memoryCache()
  const first = await createEngine({ model: 'approvals', journal, cache, clock: clock() })
  const d = await first.decide(FP, ACTIONS, {}, 'escalate')
  await first.saveCache()
  const reopened = await createEngine({ model: 'approvals', journal, cache, clock: clock() })   // the process restarted
  await reopened.recordOutcome(d.decisionId, true)
  const rebuilt = await createEngine({ model: 'approvals', journal, cache: memoryCache(), clock: clock() })
  assert.deepEqual(rebuilt.tree.toJSON(), reopened.tree.toJSON())
  await assert.rejects(() => reopened.recordOutcome('d-unknown', true), /unknown decisionId/)
})

test('models share one journal and each reads only its own', async () => {
  const journal = memoryJournal()
  await teach(journal)
  const other = await createEngine({ model: 'awards', journal, cache: memoryCache(), clock: clock() })
  assert.deepEqual(other.tree.toJSON(), (await createEngine({ model: 'awards', journal: memoryJournal(), cache: memoryCache() })).tree.toJSON())
  await other.decide(FP, ACTIONS)
  assert.deepEqual([...new Set(journal.entries.map((e) => e.model))].sort(), ['approvals', 'awards'])
})

test('alone on one machine: the file journal and cache keep a model across processes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-'))
  try {
    const { engine } = await teach(fileJournal(dir) as ReturnType<typeof memoryJournal>, fileCache(dir) as ReturnType<typeof memoryCache>, 6)
    await engine.saveCache()
    const reopened = await createEngine({ model: 'approvals', journal: fileJournal(dir), cache: fileCache(dir), clock: clock() })
    assert.deepEqual(reopened.tree.toJSON(), engine.tree.toJSON())
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
