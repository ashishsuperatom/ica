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
import type { NodeStore, Embedder, VectorIndex } from '@superatom/node-store'
import { createRetrievalState } from '@superatom/node-store'
import { createHash } from 'node:crypto'

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

export type ExtraForm = { name: string; form: string }

export type FireResult = {
  concepts: string[]
  scored: { name: string; activation: number }[]
  unexplained: string[]
}

export type SpanFirer = ReturnType<typeof createSpanFirer>

// CENTRING, FOLDED INTO THE STORED VECTOR. cosineCentred(a,b,mu) = cos(a-mu, b-mu), and mu is frozen — so
// centre-then-normalise is a FIXED transform. Store c(form) and query with c(span) and the index's own cosine
// IS the centred cosine, exactly, computed in C over the whole corpus instead of in JS one form at a time.
const centre = (v: Float32Array, mu: Float32Array): Float32Array => {
  const o = sub(v, mu)
  const n = Math.sqrt(dot(o, o)) || 1
  for (let i = 0; i < o.length; i++) o[i] /= n
  return o
}
const FORM_PREFIX = 'form:'
const formId = (name: string, form: string) =>
  FORM_PREFIX + createHash('sha1').update(name + '\t' + form).digest('hex').slice(0, 20)

export function createSpanFirer(store: NodeStore, embedder: Embedder, index: VectorIndex | null) {
  // ONE vector store. Surface forms are indexed in sqlite-vec exactly like everything else, pre-centred, so a
  // fire is a nearest-neighbour query rather than a full scan in JavaScript. They persist, so a restart
  // re-embeds nothing.
  const state = createRetrievalState(store.db, embedder.id)
  let mu: Float32Array | null = null                 // FROZEN (§4) — persisted, so frozen across restarts too
  const spanCache = new Map<string, Float32Array[]>() // per-question span vectors (bounded) — repeated fires of the
                                                     // same question (alias validation) reuse them instead of re-embedding
  let nameById = new Map<string, string>()           // indexed form id → the concept it belongs to (strings only)
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
    // Without the vector index there is no span firing at all — the same guard the rest of semantic search
    // already has: a host lacking sqlite-vec loses this retriever rather than failing to start.
    if (!index) return false
    const rows = surfaceForms()
    if (!rows.length) return false

    // The cheap half — ids, names, the exact-match table — is strings from the database, rebuilt whenever the
    // concept set changes. It costs a millisecond and is never what made this slow.
    const newSig = rows.map(r => key(r.name, r.form)).sort().join('\n')
    if (newSig !== sig) {
      nameById = new Map(rows.map(r => [formId(r.name, r.form), r.name]))
      exact = new Map()
      for (const r of rows) { const n = norm(r.form); if (!exact.has(n)) exact.set(n, r.name) }
      sig = newSig
    }

    if (!mu) mu = state.getVector('mu:background')

    if (!mu) {
      // ONCE, EVER, for this project and model. mu is the mean of every surface form plus a background sample
      // of real question spans, so computing it needs the raw vectors — the only time they are all held at once.
      // After this they are centred, written to the index, and dropped; nothing recomputes them again.
      const formVecs = await embedder.embed(rows.map(r => r.form))
      const intents = (store.listKind('intent') as any[]).map(n => n.label).filter(Boolean)
      const bgSpans = [...new Set(intents.flatMap(spansOf))].slice(0, 300)
      const bgVecs = bgSpans.length ? await embedder.embed(bgSpans, { asQuery: true }) : []
      mu = meanNormalised([...formVecs, ...bgVecs])
      state.putVector('mu:background', mu)
      rows.forEach((r, i) => index.upsert(formId(r.name, r.form), centre(formVecs[i], mu!)))
    } else {
      // Steady state: index only forms it has never seen. A restart with no new concepts embeds nothing.
      const missing = rows.filter(r => !index.has(formId(r.name, r.form)))
      if (missing.length) {
        const vecs = await embedder.embed(missing.map(r => r.form))
        missing.forEach((r, i) => index.upsert(formId(r.name, r.form), centre(vecs[i], mu!)))
      }
    }

    // Retire forms that no longer exist. A renamed concept or a deleted alias would otherwise keep firing from
    // the index for ever, and a stale concept surfacing is worse than a missing one — it looks like an answer.
    for (const id of index.idsWithPrefix(FORM_PREFIX)) if (!nameById.has(id)) index.remove(id)
    return true
  }

  /** Every indexed form whose centred cosine to `qc` exceeds FLOOR, plus the nearest few regardless — the exact
   *  input the aggregation needs. K expands while the tail is still above the floor, so nothing above it is
   *  missed; without that, a question matching many forms would silently lose the ones past K. */
  const above = (qc: Float32Array): Array<{ id: string; sim: number }> => {
    const keep = (id: string) => nameById.has(id)
    for (let k = 64; ; k *= 4) {
      const hits = index.search(qc, { limit: k, keep })
      const last = hits[hits.length - 1]
      if (hits.length < k || (last && last.sim <= FLOOR) || k >= 4096) return hits.map(h => ({ id: h.id, sim: h.sim }))
    }
  }

  /** The aggregation, over per-span candidate lists. Identical arithmetic to scoring every form by hand — the
   *  only difference is that pairs the index did not return are ones that could not have counted: `others` sums
   *  cosines above FLOOR, and `best` is a maximum, so anything below the floor and below the best changes
   *  nothing. `extra` carries hypothetical forms (alias validation), scored directly since they are not indexed. */
  const aggregate = (
    perSpan: Array<{ span: string; hits: Array<{ name: string; sim: number }> }>,
    effExact: Map<string, string>,
  ): FireResult => {
    const byConcept = new Map<string, number[]>()
    const spanBest = new Map<string, number>()
    for (const { span, hits } of perSpan) {
      const exactName = effExact.get(norm(span))
      if (exactName) {
        ;(byConcept.get(exactName) ?? byConcept.set(exactName, []).get(exactName)!).push(1)
        spanBest.set(span, 1)
        continue
      }
      for (const h of hits) {
        ;(byConcept.get(h.name) ?? byConcept.set(h.name, []).get(h.name)!).push(h.sim)
        spanBest.set(span, Math.max(spanBest.get(span) ?? -1, h.sim))
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
    const unexplained = perSpan.map(p => p.span).filter(sp => (spanBest.get(sp) ?? -1) < FLOOR)
    return { concepts: fired, scored, unexplained }
  }

  return {
    // Build off the critical path. On a project that has never been indexed this embeds everything once; after
    // that it is a handful of existence checks. It is called at boot because the first question should not be
    // the one that pays — that cost 26 seconds of silence, on whichever question happened to come first.
    async warm(): Promise<boolean> { return build() },

    // Deliberate reindex (§4: model change / mu refresh) — the ONLY sanctioned way mu changes.
    // Deliberate reindex (§4: model change / mu refresh) — the ONLY sanctioned way mu changes. Everything
    // derived from it goes too: the centred vectors in the index are meaningless against a different mean.
    reindex() {
      mu = null; spanCache.clear(); nameById = new Map(); exact = new Map(); sig = ''
      state.clear()
      for (const id of index.idsWithPrefix(FORM_PREFIX)) index.remove(id)
    },

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

      // Hypothetical forms are NOT indexed — they are a question being asked of the model ("would this alias
      // fire?"), not part of the library. Scored here against the same frozen mu, so the comparison is fair.
      let effExact = exact
      let extra: Array<{ name: string; vec: Float32Array }> = []
      if (opts?.extraForms?.length) {
        const extraVecs = await embedder.embed(opts.extraForms.map(f => f.form))
        extra = opts.extraForms.map((f, i) => ({ name: f.name, vec: extraVecs[i] }))
        effExact = new Map(exact)
        opts.extraForms.forEach(f => { const n = norm(f.form); if (!effExact.has(n)) effExact.set(n, f.name) })
      }

      const perSpan = qspans.map((span, si) => {
        const qc = centre(spanVecs![si], mu!)
        const hits = above(qc).map(h => ({ name: nameById.get(h.id)!, sim: h.sim }))
        for (const e of extra) hits.push({ name: e.name, sim: cosineCentred(spanVecs![si], e.vec, mu!) })
        return { span, hits }
      })
      return aggregate(perSpan, effExact)
    },
  }
}
