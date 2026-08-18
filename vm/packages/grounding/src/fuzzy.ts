// Dependency-free fuzzy matching for the value index: trigram similarity + edit distance, over a BOUNDED
// entity set (thousands). Good enough for name→entity resolution and deterministic everywhere; swap in FTS5
// or sqlite-vec for scale/semantics later without changing the interface.

export function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

function trigrams(s: string): Set<string> {
  const t = '  ' + normalize(s) + ' '
  const g = new Set<string>()
  for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3))
  return g
}

/** Jaccard similarity of trigram sets — robust to typos/insertions in longer strings. */
export function trigramSim(a: string, b: string): number {
  const A = trigrams(a), B = trigrams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return inter / (A.size + B.size - inter)
}

/** Levenshtein edit distance (for a precise short-string re-rank). */
export function levenshtein(a: string, b: string): number {
  a = normalize(a); b = normalize(b)
  const m = a.length, n = b.length
  if (!m) return n; if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  const cur = new Array(n + 1)
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    [prev, cur[0]] = [cur.slice(), i + 1] as any
  }
  return prev[n]
}

/** A single fuzzy score in [0,1] combining exactness, containment, trigrams and edit distance. */
export function fuzzyScore(query: string, candidate: string): number {
  const q = normalize(query), c = normalize(candidate)
  if (!q || !c) return 0
  if (q === c) return 1
  const tri = trigramSim(q, c)
  // Containment weighted by how much of the longer string is covered: a near-complete overlap
  // ("reliance industries" in "reliance industries limited") scores high; a tiny fragment ("indu")
  // scores far lower, so the full name outranks an incidental substring instead of tying at a flat 0.85.
  const contain = c.includes(q) || q.includes(c) ? 0.6 + 0.35 * (Math.min(q.length, c.length) / Math.max(q.length, c.length)) : 0
  const lev = 1 - levenshtein(q, c) / Math.max(q.length, c.length)
  // weight: containment and trigrams carry most; edit distance nudges short strings.
  return Math.max(contain, 0.7 * tri + 0.3 * lev)
}
