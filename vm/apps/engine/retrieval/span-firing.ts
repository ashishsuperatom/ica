// Span firing — §3 of CONCEPT-RETRIEVAL-SPEC. Fires the concepts a question MENTIONS.
//
// ONE replaceable segment of the retrieval system (siblings: history.ts, alias-validation.ts). The mechanism
// (foundation only — NO §5 grounding, NO §6 closure):
//   - SPANS: all n-grams n=2..4 of the UNTOUCHED question (stopwords kept). 1-grams are the noise floor, excluded.
//   - SURFACE FORMS: each concept's forms = name + aliases, embedded SEPARATELY. Concept score = MAX over forms.
//   - CENTRE: subtract a frozen global mean `mu` (built ONCE from forms + a background sample of real question
//     spans). mu is FROZEN — recomputing it as aliases/concepts are added silently rescales every score (§4).
//   - AGGREGATE: activation = best(span×form) + 0.25 · Σ(that concept's other cosines > 0.30).
//   - FIRE: rank, top 6, stop at the first gap > 0.10. Never an absolute threshold.
//   - EXACT SHORT-CIRCUIT: a span that literally equals a surface form resolves that concept at 1.000.
// fire() takes an optional `extraForms` — hypothetical surface forms embedded on the fly (never persisted) so
// alias-validation.ts can fire AS IF a candidate alias were present, against the same frozen mu.
import type { NodeStore, Embedder } from '@superatom/node-store'

const N_MIN = 2, N_MAX = 4, TOP_K = 6, GAP = 0.10, BETA = 0.25, FLOOR = 0.30

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
const tokenize = (s: string) => norm(s).split(' ').filter(Boolean)

export function spansOf(text: string): string[] {
  const t = tokenize(text)
  const out = new Set<string>()
  for (let n = N_MIN; n <= N_MAX; n++)
    for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(' '))
  return [...out]
}

const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }
const sub = (a: Float32Array, m: Float32Array) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] - m[i]; return o }
function meanNormalised(vs: Float32Array[]): Float32Array {
  const d = vs[0].length, m = new Float32Array(d)
  for (const v of vs) for (let i = 0; i < d; i++) m[i] += v[i]
  for (let i = 0; i < d; i++) m[i] /= vs.length
  const n = Math.sqrt(dot(m, m)) || 1
  for (let i = 0; i < d; i++) m[i] /= n
  return m
}
function cosineCentred(a: Float32Array, b: Float32Array, mu: Float32Array): number {
  const a2 = sub(a, mu), b2 = sub(b, mu)
  const na = Math.sqrt(dot(a2, a2)), nb = Math.sqrt(dot(b2, b2))
  return na && nb ? dot(a2, b2) / (na * nb) : 0
}

type Form = { name: string; norm: string; vec: Float32Array }
export type ExtraForm = { name: string; form: string }

export type FireResult = {
  concepts: string[]
  scored: { name: string; activation: number }[]
  unexplained: string[]
}

export type SpanFirer = ReturnType<typeof createSpanFirer>

export function createSpanFirer(store: NodeStore, embedder: Embedder) {
  let mu: Float32Array | null = null                 // FROZEN once (§4); only reindex() resets it
  const vecOf = new Map<string, Float32Array>()      // append-only cache: a form is embedded once, never again
  const spanCache = new Map<string, Float32Array[]>() // per-question span vectors (bounded) — repeated fires of the
                                                     // same question (alias validation) reuse them instead of re-embedding
  let forms: Form[] = []
  let exact = new Map<string, string>()
  let sig = ''
  const key = (name: string, form: string) => name + '\t' + form

  const surfaceForms = () => {
    const rows: { name: string; form: string }[] = []
    for (const c of store.listKind('concept') as any[]) {
      const props = typeof c.props === 'string' ? JSON.parse(c.props || '{}') : (c.props || {})
      const allForms = [c.label, ...(Array.isArray(props.aliases) ? props.aliases : [])]
      for (const f of allForms) if (f && String(f).trim()) rows.push({ name: c.label, form: String(f) })
    }
    return rows
  }

  const build = async (): Promise<boolean> => {
    const rows = surfaceForms()
    if (!rows.length) return false
    const missing = rows.filter(r => !vecOf.has(key(r.name, r.form)))
    if (missing.length) {
      const vecs = await embedder.embed(missing.map(r => r.form))
      missing.forEach((r, i) => vecOf.set(key(r.name, r.form), vecs[i]))
    }
    if (!mu) {
      const intents = (store.listKind('intent') as any[]).map(n => n.label).filter(Boolean)
      const bgSpans = [...new Set(intents.flatMap(spansOf))].slice(0, 300)
      const bgVecs = bgSpans.length ? await embedder.embed(bgSpans, { asQuery: true }) : []
      mu = meanNormalised([...rows.map(r => vecOf.get(key(r.name, r.form))!), ...bgVecs])
    }
    const newSig = rows.map(r => key(r.name, r.form)).sort().join('\n')
    if (newSig !== sig) {
      forms = rows.map(r => ({ name: r.name, norm: norm(r.form), vec: vecOf.get(key(r.name, r.form))! }))
      exact = new Map()
      for (const f of forms) if (!exact.has(f.norm)) exact.set(f.norm, f.name)
      sig = newSig
    }
    return true
  }

  const fireWith = (effForms: Form[], effExact: Map<string, string>, spanVecs: Float32Array[], qspans: string[], muv: Float32Array): FireResult => {
    const byConcept = new Map<string, number[]>()
    const spanBest = new Map<string, number>()
    for (let si = 0; si < qspans.length; si++) {
      const exactName = effExact.get(norm(qspans[si]))
      if (exactName) {
        ;(byConcept.get(exactName) ?? byConcept.set(exactName, []).get(exactName)!).push(1)
        spanBest.set(qspans[si], 1)
        continue
      }
      for (const f of effForms) {
        const cos = cosineCentred(spanVecs[si], f.vec, muv)
        ;(byConcept.get(f.name) ?? byConcept.set(f.name, []).get(f.name)!).push(cos)
        spanBest.set(qspans[si], Math.max(spanBest.get(qspans[si]) ?? -1, cos))
      }
    }
    const scored = [...byConcept.entries()].map(([name, cosses]) => {
      const sorted = cosses.slice().sort((a, b) => b - a)
      const best = sorted[0] ?? 0
      const others = sorted.slice(1).filter(c => c > FLOOR).reduce((s, c) => s + c, 0)
      return { name, activation: best + BETA * others }
    }).sort((a, b) => b.activation - a.activation)
    const head = scored.slice(0, TOP_K)
    const fired: string[] = []
    for (let i = 0; i < head.length; i++) {
      fired.push(head[i].name)
      if (i + 1 < head.length && head[i].activation - head[i + 1].activation > GAP) break
    }
    const unexplained = qspans.filter(s => (spanBest.get(s) ?? -1) < FLOOR)
    return { concepts: fired, scored, unexplained }
  }

  return {
    // Deliberate reindex (§4: model change / mu refresh) — the ONLY sanctioned way mu changes.
    reindex() { mu = null; vecOf.clear(); spanCache.clear(); forms = []; exact = new Map(); sig = '' },

    // Fire the question. `extraForms` = hypothetical surface forms (for alias validation), embedded on the fly
    // against the FROZEN mu and never persisted.
    async fire(question: string, opts?: { extraForms?: ExtraForm[] }): Promise<FireResult> {
      if (!(await build()) || !mu) return { concepts: [], scored: [], unexplained: [] }
      const qspans = spansOf(question)
      if (!qspans.length) return { concepts: [], scored: [], unexplained: [] }
      let spanVecs = spanCache.get(question)
      if (!spanVecs) {
        spanVecs = await embedder.embed(qspans, { asQuery: true })
        if (spanCache.size > 256) spanCache.clear()   // bound memory on the live fire path
        spanCache.set(question, spanVecs)
      }

      let effForms = forms, effExact = exact
      if (opts?.extraForms?.length) {
        const extraVecs = await embedder.embed(opts.extraForms.map(f => f.form))
        effForms = [...forms, ...opts.extraForms.map((f, i) => ({ name: f.name, norm: norm(f.form), vec: extraVecs[i] }))]
        effExact = new Map(exact)
        opts.extraForms.forEach(f => { const n = norm(f.form); if (!effExact.has(n)) effExact.set(n, f.name) })
      }
      return fireWith(effForms, effExact, spanVecs, qspans, mu)
    },
  }
}
