// The decision memory's core: cues from a step, the world check, recognition (learned · similar / changed, not
// learned), and the named operations that alone change a decision state.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cuesOf, worldOf, checkWorld, observe, recognise, plan, takenOf, samePath, DecisionRefusal, type Candidate, type DecisionBody, type DecisionVersion } from '../src/index.ts'

const body = (over: Partial<DecisionBody> = {}): DecisionBody => ({
  title: 'Overrun projects', description: 'Projects running over budget, reviewed for action',
  cues: ['overrun', 'budget', 'projects over budget'], seen: { overrun: { min: 10, max: 14, n: 5 } },
  paths: [{ id: 'flag', label: 'Flag to the PMO', reasoning: 'overruns above budget need a PMO review', intent: { call: { package: 'pmo', fn: 'flag' } } },
          { id: 'by-pillar', label: 'Break down by pillar', reasoning: 'see where the overrun sits', intent: { ops: [{ op: 'set', path: 'pmo.by', value: 'pillar' }] } }],
  ...over,
})
const cand = (over: Partial<Candidate> = {}): Candidate => ({ id: 'overrun', scope: 'global', body: body(), supports: 4, contradicts: 0, paths: { flag: { taken: 4, succeeded: 3, failed: 0 } }, ...over })

test('cues come from the agent, the question and the STATE\'s own values — never from a vocabulary', () => {
  const c = cuesOf({ agent: 'portfolio', question: 'Which projects are over budget?', state: { packages: { pmo: 'sha:1' }, pmo: { pillar: 'Retail', red: true } } as any })
  for (const x of ['portfolio', 'projects', 'budget', 'projects over budget', 'pmo', 'pillar retail', 'retail', 'red true']) assert.ok(c.includes(x), x)
  assert.ok(!c.includes('which') && !c.includes('are'))
})

test('the world an answer showed: named figures and the plain numbers of its KPI blocks', () => {
  assert.deepEqual(worldOf({ world: { overrun: 12 }, blocks: { k: { type: 'kpis', items: [{ label: 'red', value: 9 }, { label: 'note', value: 'n/a' }] } } } as any), { overrun: 12, red: 9 })
})

test('the world check: within the range seen (with a margin), what moved, thin when seen few times', () => {
  assert.equal(checkWorld({ overrun: 14.5 }, { overrun: { min: 10, max: 14, n: 5 } }).similar, true)
  const moved = checkWorld({ overrun: 31 }, { overrun: { min: 10, max: 14, n: 5 } })
  assert.equal(moved.similar, false); assert.deepEqual(moved.drift[0], { figure: 'overrun', now: 31, min: 10, max: 14 })
  assert.equal(checkWorld({ overrun: 12 }, { overrun: { min: 12, max: 12, n: 1 } }).thin, true)
  assert.deepEqual(observe({ a: { min: 1, max: 2, n: 2 } }, { a: 5, b: 3 }), { a: { min: 1, max: 5, n: 3 }, b: { min: 3, max: 3, n: 1 } })
})

test('learned and the world is similar: its paths, best record first', () => {
  const r = recognise(['overrun', 'budget', 'projects over budget'], { overrun: 12 }, [cand()], { overrun: 1, budget: 1, 'projects over budget': 1 }, 10)
  assert.equal(r.mode, 'learned-similar')
  assert.equal(r.matches[0].paths[0].id, 'flag')
})

test('learned but the world moved: still its paths, flagged with what moved', () => {
  const r = recognise(['overrun', 'budget', 'projects over budget'], { overrun: 31 }, [cand()], {}, 10)
  assert.equal(r.mode, 'learned-changed'); assert.match(r.why, /overrun seen 10–14, now 31/)
})

test('not learned: no match, a weak match, or thin evidence — explore', () => {
  assert.equal(recognise(['inventory'], {}, [cand()], {}, 10).mode, 'not-learned')
  assert.equal(recognise(['overrun', 'budget', 'projects over budget'], {}, [cand({ supports: 1 })], {}, 10).mode, 'not-learned')
  assert.equal(recognise(['budget'], {}, [cand()], {}, 10).mode, 'not-learned')   // one cue of three: low coverage
})

test('competing states scoring close are a reason to check, not to pick', () => {
  const a = cand({ body: body({ competes: ['overrun-b'] }) }), b = cand({ id: 'overrun-b', body: body({ title: 'Overrun (finance view)', competes: ['overrun'] }) })
  assert.equal(recognise(['overrun', 'budget', 'projects over budget'], { overrun: 12 }, [a, b], {}, 10).mode, 'learned-changed')
})

test('operations: create, reinforce widens the world seen, specialise, split keeps the general one, refusals in words', () => {
  const store = new Map<string, DecisionVersion>()
  const cur = (id: string) => store.get(id) ?? null
  const apply = (op: any, worlds: Record<string, any> = {}) => { for (const w of plan(op, cur, (e) => worlds[e] ?? null)) store.set(w.id, { ...w, version: (store.get(w.id)?.version ?? 0) + 1, at: '', by: 't', why: '', op: op.op }) }
  apply({ op: 'create', id: 'overrun', scope: 'global', body: body({ seen: {} }), supports: ['e1'] }, { e1: { overrun: 11 } })
  assert.deepEqual(store.get('overrun')!.body.seen, { overrun: { min: 11, max: 11, n: 1 } })
  apply({ op: 'reinforce', id: 'overrun', supports: ['e2'] }, { e2: { overrun: 15 } })
  assert.deepEqual(store.get('overrun')!.body.seen.overrun, { min: 11, max: 15, n: 2 })
  apply({ op: 'specialise', parent: 'overrun', id: 'overrun.retail', body: body({ title: 'Overrun in Retail', cues: ['overrun', 'retail'] }) })
  assert.equal(store.get('overrun.retail')!.body.parent, 'overrun')
  assert.throws(() => apply({ op: 'create', id: 'overrun', scope: 'global', body: body() }), DecisionRefusal)
  assert.throws(() => apply({ op: 'reinforce', id: 'nope', supports: ['e'] }), /there is no decision state nope/)
  assert.throws(() => apply({ op: 'create', id: 'x', scope: 'global', body: { ...body(), paths: [{ id: 'p', label: 'P', intent: {} }] } }), /says why|intent is ops/)
  apply({ op: 'invalidate', id: 'overrun.retail' })
  assert.equal(store.get('overrun.retail')!.status, 'invalidated')
  assert.throws(() => apply({ op: 'reinforce', id: 'overrun.retail', supports: ['e3'] }), /is invalidated/)
})

test('a taken path is described from the intent, and matched to a state\'s path', () => {
  const t = takenOf({ kind: 'structured', call: { package: 'pmo', fn: 'flag' } })
  assert.equal(t.label, 'ran pmo.flag')
  assert.equal(samePath(t, body().paths[0]), true)
  assert.equal(samePath(takenOf({ kind: 'structured', ops: [{ op: 'set', path: 'pmo.by', value: 'pillar' }] as any }), body().paths[1]), true)
})
