// Run:  cd vm && pnpm exec tsx --test apps/engine/retrieval/span-firing.test.ts
//
// This retriever is still being evaluated against the specificity one. So the move from "score every surface
// form in JS" to "ask the vector index" has to be EXACT — if it shifted the numbers even slightly, we could no
// longer tell a retrieval-quality difference from a refactor regression, and the A/B would be worthless.
//
// The test scores the same corpus both ways and demands the same answer. The reference implementation below is
// the old code, kept here deliberately as the thing being compared against.
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeStore, SqliteVecIndex, type Embedder } from '@superatom/node-store'
import { createSpanFirer, spansOf } from './span-firing.js'

// A deterministic stand-in for the embedding model: a hashed bag-of-characters, normalised. Real vectors are not
// needed — what is under test is the arithmetic and the retrieval path, and a fake model makes the run instant
// and the result stable. `asQuery` shifts the vector, as a real asymmetric model does.
const DIM = 64
function fakeVector(text: string, asQuery: boolean): Float32Array {
  const v = new Float32Array(DIM)
  const t = text.toLowerCase()
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i)
    v[(c * 7 + i * 3) % DIM] += 1
    v[(c * 13) % DIM] += 0.5
  }
  if (asQuery) for (let i = 0; i < DIM; i++) v[i] += 0.05 * ((i % 5) - 2)
  let n = 0; for (let i = 0; i < DIM; i++) n += v[i] * v[i]
  n = Math.sqrt(n) || 1
  for (let i = 0; i < DIM; i++) v[i] /= n
  return v
}
const embedder: Embedder = {
  id: 'fake-test-model', dim: DIM,
  async embed(texts: string[], opts?: { asQuery?: boolean }) { return texts.map(t => fakeVector(t, !!opts?.asQuery)) },
} as Embedder

// ── the OLD scoring, verbatim in behaviour: every span against every form, in JS ────────────────────────────
const N_MIN = 2, TOP_K = 6, GAP = 0.10, BETA = 0.25, FLOOR = 0.30
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }
const sub = (a: Float32Array, m: Float32Array) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] - m[i]; return o }
function cosineCentred(a: Float32Array, b: Float32Array, mu: Float32Array): number {
  const a2 = sub(a, mu), b2 = sub(b, mu)
  const na = Math.sqrt(dot(a2, a2)), nb = Math.sqrt(dot(b2, b2))
  return na && nb ? dot(a2, b2) / (na * nb) : 0
}
function meanNormalised(vs: Float32Array[]): Float32Array {
  const d = vs[0].length, m = new Float32Array(d)
  for (const v of vs) for (let i = 0; i < d; i++) m[i] += v[i]
  for (let i = 0; i < d; i++) m[i] /= vs.length
  const n = Math.sqrt(dot(m, m)) || 1
  for (let i = 0; i < d; i++) m[i] /= n
  return m
}
function bruteForce(forms: Array<{ name: string; form: string }>, intents: string[], question: string) {
  const formVecs = forms.map(f => fakeVector(f.form, false))
  const bgSpans = [...new Set(intents.flatMap(spansOf))].slice(0, 300)
  const mu = meanNormalised([...formVecs, ...bgSpans.map(s => fakeVector(s, true))])
  const exact = new Map<string, string>()
  for (const f of forms) { const n = norm(f.form); if (!exact.has(n)) exact.set(n, f.name) }

  const qspans = spansOf(question)
  const byConcept = new Map<string, number[]>()
  for (const span of qspans) {
    const hit = exact.get(norm(span))
    if (hit) { (byConcept.get(hit) ?? byConcept.set(hit, []).get(hit)!).push(1); continue }
    const qv = fakeVector(span, true)
    forms.forEach((f, i) => {
      const cos = cosineCentred(qv, formVecs[i], mu)
      ;(byConcept.get(f.name) ?? byConcept.set(f.name, []).get(f.name)!).push(cos)
    })
  }
  const scored = [...byConcept.entries()].map(([name, cs]) => {
    const sorted = cs.slice().sort((a, b) => b - a)
    return { name, activation: (sorted[0] ?? 0) + BETA * sorted.slice(1).filter(c => c > FLOOR).reduce((s, c) => s + c, 0) }
  }).sort((a, b) => b.activation - a.activation)
  const head = scored.slice(0, TOP_K)
  const fired: string[] = []
  for (let i = 0; i < head.length; i++) {
    fired.push(head[i].name)
    if (i + 1 < head.length && head[i].activation - head[i + 1].activation > GAP) break
  }
  return { fired, scored }
}

const CONCEPTS: Array<{ name: string; aliases?: string[] }> = [
  { name: 'customer invoice total', aliases: ['total invoiced per customer', 'invoice amount by customer'] },
  { name: 'vendor bill total', aliases: ['supplier bills'] },
  { name: 'invoiced revenue by department', aliases: ['revenue per department'] },
  { name: 'monthly invoice trend' },
  { name: 'customers with no recent order', aliases: ['lapsed customers'] },
  { name: 'at-risk project', aliases: ['project at risk', 'red project'] },
  { name: 'project go-live date' },
  { name: 'employee utilisation below target', aliases: ['under-utilised staff'] },
]
const INTENTS = [
  'who are our top customers by invoice total', 'which projects are at risk this quarter',
  'what is the monthly invoice trend for 2026', 'show me lapsed customers in australia',
  'invoiced revenue by department last year', 'which employees are below their utilisation target',
]

function seeded() {
  const store = new NodeStore(join(mkdtempSync(join(tmpdir(), 'sa-span-')), 'project.sqlite'))
  for (const c of CONCEPTS)
    store.putNode({ id: 'c:' + c.name, kind: 'concept', label: c.name, summary: c.name, props: { aliases: c.aliases ?? [] } } as any)
  for (const [i, q] of INTENTS.entries())
    store.putNode({ id: 'i:' + i, kind: 'intent', label: q, summary: q, props: {} } as any)
  return store
}
const allForms = () => CONCEPTS.flatMap(c => [c.name, ...(c.aliases ?? [])].map(f => ({ name: c.name, form: f })))

const QUESTIONS = [
  'who are our top customers by invoice total',
  'which projects are at risk',
  'show me revenue per department for last quarter',
  'lapsed customers',                                   // an exact alias match
  'what is the weather like today',                     // nothing should fire
]

for (const q of QUESTIONS) {
  test(`index-backed firing matches brute force exactly — "${q}"`, async () => {
    const store = seeded()
    const index = new SqliteVecIndex(store.db, embedder.id, DIM)
    const firer = createSpanFirer(store, embedder, index)
    const got = await firer.fire(q)
    const want = bruteForce(allForms(), INTENTS, q)

    assert.deepEqual(got.concepts, want.fired, 'the concepts that FIRE must be identical')

    // The RANKING must be identical, and every activation equal to within float32.
    //
    // Not bit-identical, and it cannot be: the index derives cosine from the stored L2 distance (1 - d²/2)
    // while the brute force computes the dot product directly. The same value by algebra, the last digit apart
    // in floating point — observed at 1e-6 on a ~0.8 score. That is four orders of magnitude below GAP (0.10)
    // and FLOOR (0.30), the two numbers any decision here actually turns on, so it cannot change an outcome.
    const names = (xs: Array<{ name: string; activation: number }>) => xs.filter(x => x.activation > FLOOR).map(x => x.name)
    assert.deepEqual(names(got.scored), names(want.scored), 'the ranking must be identical')
    for (const w of want.scored.filter(x => x.activation > FLOOR)) {
      const g = got.scored.find(x => x.name === w.name)!
      assert.ok(Math.abs(g.activation - w.activation) < 1e-4,
        `${w.name}: ${g.activation} vs ${w.activation} — beyond float32 noise`)
    }
  })
}

test('a second firer on the same database re-embeds nothing and agrees', async () => {
  const store = seeded()
  const index = new SqliteVecIndex(store.db, embedder.id, DIM)
  const first = await createSpanFirer(store, embedder, index).fire(QUESTIONS[0])

  // A fresh firer = a restart. It must read the frozen mean and the indexed forms, not rebuild them.
  let embedCalls = 0
  const counting: Embedder = { ...embedder, async embed(t: string[], o?: any) { embedCalls += t.length; return embedder.embed(t, o) } } as Embedder
  const second = await createSpanFirer(store, counting, index).fire(QUESTIONS[0])

  assert.deepEqual(second.concepts, first.concepts)
  // Only the question's own spans get embedded — never a surface form, never the background sample.
  assert.equal(embedCalls, spansOf(QUESTIONS[0]).length, `a restart embedded ${embedCalls} texts; it should embed only the question's spans`)
})
