// Span firing — §3 of CONCEPT-RETRIEVAL-SPEC. Fires the concepts a question MENTIONS.
//
// The mechanism (foundation only — NO §5 grounding, NO §6 closure; those are separate so we can tell which
// change moved the needle):
//   - SPANS: all n-grams n=2..4 of the UNTOUCHED question (stopwords kept). 1-grams are the noise floor, excluded.
//   - SURFACE FORMS: each concept's forms = name + aliases, embedded SEPARATELY. Concept score = MAX over forms.
//   - CENTRE: subtract a frozen global mean `mu` (built from the forms + a background sample of real question
//     spans) from every vector before cosine — so activations are comparable. mu is computed once per concept-set
//     and cached (a fixed reference set, never recomputed per query).
//   - AGGREGATE: activation = best(span×form) + 0.25 · Σ(that concept's other cosines > 0.30).
//   - FIRE: rank by activation, take top 6, walk down, STOP at the first gap > 0.10. Never an absolute threshold.
//   - EXACT SHORT-CIRCUIT: a span that literally equals a surface form resolves that concept at 1.000.
// Returns the fired concepts AND the unexplained spans (§7) — content that matched nothing known.
import type { NodeStore, Embedder } from '@superatom/node-store'

const N_MIN = 2, N_MAX = 4, TOP_K = 6, GAP = 0.10, BETA = 0.25, FLOOR = 0.30

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
const tokenize = (s: string) => norm(s).split(' ').filter(Boolean)

function spansOf(text: string): string[] {
  const t = tokenize(text)
  const out = new Set<string>()
  for (let n = N_MIN; n <= N_MAX; n++)
    for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(' '))
  return [...out]
}

// ── vector math (centred cosine) ──────────────────────────────────────────────
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
type Index = { sig: string; forms: Form[]; mu: Float32Array; exact: Map<string, string> }

export type FireResult = {
  concepts: string[]                               // the fired concept names
  scored: { name: string; activation: number }[]   // every candidate, ranked (for logging/comparison)
  unexplained: string[]                            // spans that matched nothing known (the discovery queue)
}

export function createSpanFirer(store: NodeStore, embedder: Embedder) {
  let idx: Index | null = null

  const surfaceForms = () => {
    const rows: { name: string; form: string }[] = []
    for (const c of store.listKind('concept') as any[]) {
      const props = typeof c.props === 'string' ? JSON.parse(c.props || '{}') : (c.props || {})
      const forms = [c.label, ...(Array.isArray(props.aliases) ? props.aliases : [])]
      for (const f of forms) if (f && String(f).trim()) rows.push({ name: c.label, form: String(f) })
    }
    return rows
  }

  // Build (or reuse) the frozen form index + mu. Rebuilds only when the concept-set signature changes.
  const build = async (): Promise<Index | null> => {
    const rows = surfaceForms()
    if (!rows.length) return null
    const sig = rows.map(r => r.name + '' + r.form).sort().join('\n')
    if (idx && idx.sig === sig) return idx

    const formVecs = await embedder.embed(rows.map(r => r.form))                 // forms = passages
    const forms: Form[] = rows.map((r, i) => ({ name: r.name, norm: norm(r.form), vec: formVecs[i] }))

    // mu reference set = the form vectors + a background sample of REAL question spans (from intent history).
    const intents = (store.listKind('intent') as any[]).map(n => n.label).filter(Boolean)
    const bgSpans = [...new Set(intents.flatMap(spansOf))].slice(0, 300)
    const bgVecs = bgSpans.length ? await embedder.embed(bgSpans, { asQuery: true }) : []
    const mu = meanNormalised([...forms.map(f => f.vec), ...bgVecs])

    const exact = new Map<string, string>()
    for (const f of forms) if (!exact.has(f.norm)) exact.set(f.norm, f.name)     // normalised form → concept name

    idx = { sig, forms, mu, exact }
    return idx
  }

  return {
    async fire(question: string): Promise<FireResult> {
      const ix = await build()
      if (!ix) return { concepts: [], scored: [], unexplained: [] }
      const qspans = spansOf(question)
      if (!qspans.length) return { concepts: [], scored: [], unexplained: [] }
      const spanVecs = await embedder.embed(qspans, { asQuery: true })

      const byConcept = new Map<string, number[]>()      // concept name → all its (span×form) centred cosines
      const spanBest = new Map<string, number>()         // span → best cosine to any form (for unexplained spans)
      for (let si = 0; si < qspans.length; si++) {
        const exactName = ix.exact.get(norm(qspans[si]))
        if (exactName) {                                  // literal surface form → 1.000, no embedding needed
          ;(byConcept.get(exactName) ?? byConcept.set(exactName, []).get(exactName)!).push(1)
          spanBest.set(qspans[si], 1)
          continue
        }
        for (const f of ix.forms) {
          const cos = cosineCentred(spanVecs[si], f.vec, ix.mu)
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

      // Fire by rank + gap: take the top-k, stop at the first gap larger than GAP.
      const head = scored.slice(0, TOP_K)
      const fired: string[] = []
      for (let i = 0; i < head.length; i++) {
        fired.push(head[i].name)
        if (i + 1 < head.length && head[i].activation - head[i + 1].activation > GAP) break
      }
      const unexplained = qspans.filter(s => (spanBest.get(s) ?? -1) < FLOOR)
      return { concepts: fired, scored, unexplained }
    },
  }
}
