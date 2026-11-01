// Closing an intent (intent-close.ts) and the checks on its ways out (intent-checks.ts), with the clone scripted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIntentClose } from '../intent-close.ts'
import { compileCheck } from '../intent-checks.ts'

const who = { id: 'user:u1', admin: false, email: 'u1@x.io', scopes: ['user:u1'] }
const closing = (cwd: string, variant: any = null) => ({
  session: 's1', who, conversation: { harness: 'pi' as any, ref: 'f', cwd },
  node: { id: 'in-aaaaaa1', title: 'Spend', intent: 'spend by supplier', madeHere: true, variant },
  turns: [{ question: 'spend by supplier in march', answer: 'A: 10', agent: 'analyst' }],
})
// A clone that writes what it is told into the file its prompt names.
const cloneWriting = (json: unknown, seen: string[] = []) => async (of: any, prompt: string) => {
  seen.push(prompt)
  const file = /as JSON to (\S+):/.exec(prompt)![1]
  writeFileSync(join(of.cwd, file), JSON.stringify(json))
  return { text: 'done', how: 'forked' as const, ms: 5 }
}

test('what the clone learnt is kept: new concepts as the person\'s own (those for everyone suggested), the person\'s variant, the names, the next intents with checks that load', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'close-'))
  const writes: any[] = [], closes: any[] = [], prompts: string[] = []
  const c = createIntentClose({
    intents: { close: async (m: any) => { closes.push(m); return { variant: { version: 1, changed: true }, names: 1, next: ['in-x'] } } } as any,
    graphWrite: async (_who, w) => { writes.push(...w); return [] }, log: () => {},
    clone: cloneWriting({ keep: true, title: 'Spend by supplier', intent: 'what was spent with each supplier in a period',
      names: [{ value: 'Acme', kind: 'supplier' }],
      concepts: { use: ['spend/net'], new: [{ name: 'spend/excludes-credit-notes', title: 'Spend excludes credit notes', text: 'Credit notes are left out of spend.', everyone: true }, { name: 'Bad Name', title: 't', text: 'x' }] },
      process: 'Sum net invoice lines by supplier.', show: 'a table, largest first', paths: [{ when: 'one supplier', how: 'show its invoices' }],
      next: [{ asked: 'spend by month for {supplier}', label: 'By month', check: 'export default async (s, ctx) => ({ label: "By month" })' }, { asked: 'top suppliers', check: 'this is not javascript (' }] }, prompts),
  })
  await c.close(closing(cwd))
  assert.match(prompts[0], /moved on from the intent "Spend"/)
  assert.deepEqual(writes.map((w) => [w.name, w.scope ?? null, w.publish ?? null]), [['spend/excludes-credit-notes', 'user:u1', null], ['spend/excludes-credit-notes', null, 'global']])
  const m = closes[0]
  assert.equal(m.owner, 'user:u1'); assert.equal(m.madeHere, true); assert.equal(m.title, 'Spend by supplier')
  assert.deepEqual(m.variant.concepts, ['spend/net', 'spend/excludes-credit-notes'])
  assert.equal(m.variant.process, 'Sum net invoice lines by supplier.')
  assert.deepEqual(m.names, [{ value: 'Acme', kind: 'supplier' }])
  assert.equal(m.next.length, 2); assert.ok(m.next[0].check); assert.equal(m.next[1].check, null)   // a check that does not load is dropped, the next intent kept
})

test('nothing kept for what was not a request; the same variant as the person answered with is not written again', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'close-'))
  const closes: any[] = []
  const intents: any = { close: async (m: any) => { closes.push(m); return { names: 0, next: [] } } }
  await createIntentClose({ intents, log: () => {}, clone: cloneWriting({ keep: false }) }).close(closing(cwd))
  assert.equal(closes.length, 0)
  const had = { concepts: ['spend/net'], process: 'Sum net invoice lines by supplier.', show: '', paths: [], whose: 'mine' }
  await createIntentClose({ intents, log: () => {}, clone: cloneWriting({ keep: true, concepts: { use: ['spend/net'], new: [] }, process: 'Sum net invoice lines by supplier.', paths: [], next: [] }) }).close(closing(cwd, had))
  assert.equal(closes[0].variant, null)
})

test('a check is a module whose default export is a function; anything else is refused', async () => {
  assert.equal(typeof (await compileCheck('export default async () => null')), 'function')
  await assert.rejects(compileCheck('export const x = 1'), /default/)
  await assert.rejects(compileCheck('nonsense ('))
})
