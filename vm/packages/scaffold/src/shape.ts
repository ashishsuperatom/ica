// SHAPE HASH — the structural signature of a unit's output, and the cache key for its UI.
//
// A generated UI reads values from the data by key, so the SAME component renders ANY data of the SAME
// shape. UI is therefore regenerated only when the SHAPE changes — not when a value changes:
//   revenue 2000 → 4000                          → same shape → reuse UI
//   { byCat: [ {cat,val}, {cat,val} ] } new vals → same shape → reuse UI
//   a new KEY appears on an object               → shape CHANGED → re-author UI
//   array LENGTH 2 → 3                            → SAME shape (a table renders any row count)
//
// Rules:
//   primitive (number/string/boolean) → its TYPE only (value ignored)
//   object   → its set of keys (sorted) + the shape of each value (recursive)
//   array    → the shape of its elements, MERGED across elements. Length is intentionally excluded:
//              a different row count (a filter, a day, a branch) must reuse the SAME UI. A genuinely
//              new "category" shows up as a new object KEY (caught above), not a longer array.
//   null/undefined → a distinct marker (null vs a value is a real shape difference)

import { createHash } from 'node:crypto'

function sig(v: any): any {
  if (v === null || v === undefined) return 0 // null marker
  if (Array.isArray(v)) {
    let el: any = 0
    for (const x of v) el = merge(el, sig(x))
    return ['a', el]
  }
  if (typeof v === 'object') {
    const o: Record<string, any> = {}
    for (const k of Object.keys(v).sort()) o[k] = sig(v[k])
    return ['o', o]
  }
  return typeof v // 'number' | 'string' | 'boolean'
}

// Merge two element shapes into the most general one. Differing object keys union together (so a field
// present on only some rows is still caught); otherwise keep both signals so the difference shows.
function merge(a: any, b: any): any {
  if (a === 0) return b
  if (b === 0) return a
  const ja = JSON.stringify(a), jb = JSON.stringify(b)
  if (ja === jb) return a
  if (Array.isArray(a) && Array.isArray(b) && a[0] === 'o' && b[0] === 'o') {
    const o: Record<string, any> = { ...a[1] }
    for (const k of Object.keys(b[1])) o[k] = k in o ? merge(o[k], b[1][k]) : b[1][k]
    return ['o', o]
  }
  return ['|', ja < jb ? [a, b] : [b, a]] // union of two distinct shapes
}

/** The readable shape tree (for inspection / diffing). */
export function shapeOf(v: any): any {
  return sig(v)
}

/** The stable shape key: same structure → same hash, regardless of values or row count. */
export function shapeHash(v: any): string {
  return createHash('sha1').update(JSON.stringify(sig(v))).digest('hex').slice(0, 16)
}
