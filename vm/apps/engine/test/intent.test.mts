// Learning from each answer (intent-learn.ts) and the checks on an intent's ways out (intent-checks.ts), the clone scripted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIntentLearn } from '../intent-learn.ts'
import { compileCheck, offeredNext } from '../intent-checks.ts'

const who = { id: 'user:u1', admin: false, email: 'u1@x.io', scopes: ['user:u1'] }
const turn = (qid: string, question: string, agent = 'analyst') => ({ qid, question, answer: `answer to ${question}`, agent })
const node = (id: string, variant: any = null) => ({ id, title: `Node ${id}`, intent: 'spend by supplier', canonical: 'x', agent: null, needs: null, allowed: true, system: false, passages: 1, variant })
// A clone that writes what it is told, per intent, into the file its prompt names — and can be held, to answer while it runs.
function cloneWriting(per: (id: string, turn: number) => unknown, o: { seen?: string[]; hold?: Promise<void> } = {}) {
  return async (of: any) => {
    let n = 0, ids: string[] = []
    return {
      async turn(prompt: string) {
        o.seen?.push(prompt)
        await o.hold
        const file = (/as JSON to (\S+):/.exec(prompt) ?? /, to (\S+)\.$/.exec(prompt))![1]
        if (!n) ids = [...prompt.matchAll(/^(in-[a-z0-9]+): "/gm)].map((m) => m[1])
        n++
        writeFileSync(join(of.cwd, file), JSON.stringify(Object.fromEntries(ids.map((id) => [id, per(id, n)]))))
        return { text: 'done', how: 'forked' as const, ms: 5 }
      },
      close() {},
    }
  }
}
const setup = (clone: any, extra: any = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'learn-')), cwd = mkdtempSync(join(tmpdir(), 'conv-'))
  const writes: any[] = [], closes: any[] = []
  const l = createIntentLearn({
    intents: { node: async (q: any) => node(q.id, extra.variant?.[q.id] ?? null), next: async () => extra.pool ?? [], close: async (m: any) => { closes.push(m); return { variant: { version: 1, changed: true }, names: (m.names ?? []).length, next: (m.next ?? []).map(() => 'in-next') } } } as any,
    graphWrite: async (_w, w) => { writes.push(...w); return [] }, conversationOf: async () => ({ harness: 'pi' as any, ref: 'f', cwd }), projectDir: home, log: () => {}, clone,
    concepts: { text: async () => '', search: (ps: any[]) => ps.map((p) => (extra.existing ?? []).filter((c: any) => c.name === p.name || c.like === p.name)) },
  })
  return { l, writes, closes }
}

test('every answer is learnt from: new concepts as the person\'s own (those for everyone suggested), the person\'s variant, the names, the next intents with checks that load', async () => {
  const seen: string[] = []
  const { l, writes, closes } = setup(cloneWriting(() => ({ keep: true, title: 'Spend by supplier', intent: 'what was spent with each supplier in a period',
    names: [{ value: 'Acme', kind: 'supplier' }],
    concepts: { use: ['spend/net'], new: [{ name: 'spend/excludes-credit-notes', title: 'Spend excludes credit notes', text: 'Credit notes are left out.', everyone: true }, { name: 'Bad Name', title: 't', text: 'x' }] },
    process: 'Sum net invoice lines by supplier.', show: 'a table', paths: [{ when: 'one supplier', how: 'its invoices' }],
    next: { interpolation: [{ asked: 'spend by month for that supplier', check: 'export default async () => ({ label: "By month" })' }, { asked: 'a second one of the same kind', check: null }], extrapolation: [{ asked: 'which suppliers raised prices', check: 'not javascript (' }], novelty: { asked: 'which contracts end soon', check: null } },
    retire: [{ id: 'in-old0001', why: 'never made sense' }] }), { seen }), { pool: [{ to: 'in-old0001', tag: 'suggested', kind: 'novelty', title: 'Old one', tried: 9, held: 0, failed: 2, taken: 0 }] })
  await l.answered({ session: 's1', who, intents: [{ node: 'in-aaaaaa1', madeHere: true, turns: [turn('q1', 'spend by supplier in march')] }] })
  assert.match(seen[0], /in-aaaaaa1: "Node in-aaaaaa1"/)
  assert.deepEqual(writes.map((w) => [w.name, w.scope ?? null, w.publish ?? null]), [['spend/excludes-credit-notes', 'user:u1', null], ['spend/excludes-credit-notes', null, 'global']])
  const m = closes[0]
  assert.equal(m.owner, 'user:u1'); assert.equal(m.madeHere, true); assert.equal(m.title, 'Spend by supplier')
  assert.deepEqual(m.variant.concepts, ['spend/net', 'spend/excludes-credit-notes'])
  assert.deepEqual(m.next.map((x: any) => [x.kind, !!x.check]), [['interpolation', true], ['interpolation', false], ['extrapolation', false]])   // never more than three new ones, of whatever kinds; a check that does not load is dropped, the question kept
  assert.match(seen[0], /belong to the intent, not to this one answer/); assert.match(seen[0], /Like a large program/)
  assert.match(seen[0], /\[novelty\] in-old0001 "Old one" — tried 9, made sense 0, failed 2, taken by people 0/)   // the pool, with its history
  assert.deepEqual(m.retire, [{ to: 'in-old0001', why: 'never made sense' }])
})

test('one learner per session: answers while a clone runs start no other; once it finishes, one more run takes everything new — every intent with turns not yet learnt, in one clone', async () => {
  let release!: () => void
  const hold = new Promise<void>((r) => { release = r })
  const seen: string[] = []
  const { l, closes } = setup(cloneWriting(() => ({ keep: true, concepts: { use: [], new: [] }, process: 'p', paths: [], next: {} }), { seen, hold }))
  const a = { node: 'in-aaaaaa1', madeHere: true, turns: [turn('q1', 'first')] }
  const first = l.answered({ session: 's1', who, intents: [a] })
  for (let i = 0; i < 100 && !seen.length; i++) await new Promise((r) => setTimeout(r, 5))   // the first clone is running
  // two more answers while the first clone runs: one at the same intent, one at another
  void l.answered({ session: 's1', who, intents: [{ ...a, turns: [...a.turns, turn('q2', 'as a table', 'composer')] }] })
  const last = l.answered({ session: 's1', who, intents: [{ ...a, turns: [...a.turns, turn('q2', 'as a table', 'composer')] }, { node: 'in-bbbbbb1', madeHere: true, turns: [turn('q3', 'second')] }] })
  assert.equal(seen.length, 1)   // still only the first clone
  release(); await first; await last
  assert.equal(seen.length, 2)   // and one more, not two
  assert.match(seen[1], /in-aaaaaa1:[\s\S]*as a table[\s\S]*in-bbbbbb1:/)
  assert.deepEqual(closes.map((c) => c.node), ['in-aaaaaa1', 'in-aaaaaa1', 'in-bbbbbb1'])
  // nothing new: no clone at all
  await l.answered({ session: 's1', who, intents: [{ ...a, turns: [...a.turns, turn('q2', 'as a table', 'composer')] }, { node: 'in-bbbbbb1', madeHere: true, turns: [turn('q3', 'second')] }] })
  assert.equal(seen.length, 2)
})

test('nothing kept for what was not a request; the same variant as the person answered with is not written again', async () => {
  const one = setup(cloneWriting(() => ({ keep: false })))
  await one.l.answered({ session: 's1', who, intents: [{ node: 'in-aaaaaa1', madeHere: true, turns: [turn('q1', 'hi')] }] })
  assert.equal(one.closes.length, 0)
  const had = { concepts: ['spend/net'], process: 'Sum net invoice lines by supplier.', show: '', paths: [], whose: 'mine' }
  const two = setup(cloneWriting(() => ({ keep: true, concepts: { use: ['spend/net'], new: [] }, process: 'Sum net invoice lines by supplier.', paths: [], next: {} })), { variant: { 'in-aaaaaa1': had } })
  await two.l.answered({ session: 's2', who, intents: [{ node: 'in-aaaaaa1', madeHere: false, turns: [turn('q1', 'spend', 'composer')] }] })
  assert.equal(two.closes[0].variant, null)
})

test('a check is a module whose default export is a function; anything else is refused', async () => {
  assert.equal(typeof (await compileCheck('export default async () => null')), 'function')
  await assert.rejects(compileCheck('export const x = 1'), /default/)
  await assert.rejects(compileCheck('nonsense ('))
})

test('what is offered next: asked ones judged follow-ups first; then per kind the most likely first, tried in order until one makes sense — at most three, one that keeps failing skipped — every try reported', async () => {
  const yes = 'export default async () => ({ label: "yes" })', no = 'export default async () => null', boom = 'export default async () => { throw new Error("x") }'
  const e = (to: string, kind: string | null, check: string | null, h: any = {}) => ({ from: 'in-a', to, owner: 'user:u1', tag: kind ? 'suggested' : 'asked', kind, count: kind ? 0 : 2, label: to, title: to, check, last: '', allowed: true, ...h })
  const reported: any[] = []
  const offered = await offeredNext([
    e('in-asked', null, null, { follows: 1 }), e('in-after', null, null),
    e('in-i-likely', 'interpolation', no, { tried: 4, held: 4, taken: 3 }), e('in-i-next', 'interpolation', yes, { tried: 2, held: 1 }), e('in-i-never', 'interpolation', yes, { tried: 10, held: 0 }),
    e('in-x-failing', 'extrapolation', yes, { failsInRow: 3 }), e('in-x-ok', 'extrapolation', boom),
    e('in-n-1', 'novelty', no), e('in-n-2', 'novelty', no), e('in-n-3', 'novelty', no), e('in-n-4', 'novelty', yes),
  ] as any, { state: {}, context: '', history: [] }, {} as any, { timeoutMs: 500, tried: (r) => reported.push(...r) })
  assert.deepEqual(offered.map((o) => [o.id, o.kind ?? o.tag]), [['in-asked', 'asked'], ['in-i-next', 'interpolation'], ['in-after', 'asked']])   // only asked after: last, to fill the places
  assert.deepEqual(reported.map((r) => [r.to, r.outcome]).sort(), [['in-i-likely', 'empty'], ['in-i-next', 'held'], ['in-n-1', 'empty'], ['in-n-2', 'empty'], ['in-n-3', 'empty'], ['in-x-ok', 'failed']].sort())
})

test('a proposed concept that already exists is checked again in the same clone and reused, never written twice', async () => {
  const seen: string[] = []
  const { l, writes, closes } = setup(cloneWriting((_id, turn) => turn === 1
    ? { keep: true, concepts: { use: [], new: [{ name: 'spend/net', title: 'Net spend', text: 'Sum of net lines.' }, { name: 'spend/in-lakh', title: 'In lakh', text: 'Amounts in lakh.' }] }, process: 'p', paths: [], next: {} }
    : { keep: true, concepts: { use: ['procurement/net-spend'], new: [{ name: 'spend/in-lakh', title: 'In lakh', text: 'Amounts in lakh.' }] }, process: 'p', paths: [], next: {} }, { seen }),
    { existing: [{ name: 'procurement/net-spend', like: 'spend/net', title: 'Net spend', text: 'Net invoice lines summed.', scope: 'global' }] })
  await l.answered({ session: 's1', who, intents: [{ node: 'in-aaaaaa1', madeHere: true, turns: [turn('q1', 'spend')] }] })
  assert.equal(seen.length, 2); assert.match(seen[1], /you proposed spend\/net[\s\S]*procurement\/net-spend/)
  assert.deepEqual(writes.map((w) => [w.name, w.scope, !!w.body?.learnt]), [['spend/in-lakh', 'user:u1', true]])   // the person's, for their intent
  assert.deepEqual(closes[0].variant.concepts, ['procurement/net-spend', 'spend/in-lakh'])   // reused, not written again
})
