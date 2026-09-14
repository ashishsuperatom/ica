// ── WHAT EXISTS, AND WHICH MEMBER WAS MEANT ───────────────────────────────────────────────────────────────
//
// Two questions an agent asks before it can ask the real one.
//
//   catalog   what programs exist, and for each relation its measures, dimensions, entities and time — so a
//             question is built from what is defined, not from what the agent guesses is there
//   members   which member of a dimension someone meant by what they typed — "netsuit", "Acme" — found by the
//             source (exact, starting with, containing), and failing that, within a few typing mistakes; and
//             said to be ambiguous when more than one fits equally, rather than one being picked
//
// Both read only through the graph, so what they show is what a question could use, and a members search is a
// call like any other: recorded, under the asker's access.

import type { Contract } from './contract.js'
import type { Coordinates } from './coordinates.js'
import type { CallOptions } from './runtime.js'
import { isDerived, kindOf } from './shape.js'
import type { GraphStore } from './store.js'

export interface CatalogEntry {
  name: string
  kind: Contract['kind']
  returns: Contract['returns']
  description: string
  params: Contract['params']
  assumes?: Contract['assumes']
  relation?: {
    holds: 'flow' | 'stock'
    grain?: string
    time?: string
    measures: Record<string, { unit: string; kind: string; how: string; description?: string }>
    dimensions: Record<string, { entity?: string; history: string; labelled: boolean; description?: string }>
  }
}

export function catalog(store: GraphStore): CatalogEntry[] {
  return store.current().map(({ name, hash }) => {
    const c = store.getProgram(hash)!.contract
    const entry: CatalogEntry = { name, kind: c.kind, returns: c.returns, description: c.description, params: c.params, ...(c.assumes ? { assumes: c.assumes } : {}) }
    if (c.returns === 'relation' && c.shape) {
      const s = c.shape
      entry.relation = {
        holds: kindOf(s),
        ...(s.grain ? { grain: s.grain } : {}),
        ...(s.time ? { time: s.time } : {}),
        measures: Object.fromEntries(Object.entries(s.measures).map(([m, d]) =>
          [m, { unit: d.unit, kind: d.kind, how: isDerived(d) ? d.expression : `${d.aggregate}${d.column ? ` of ${d.column}` : ''}`, ...(d.description ? { description: d.description } : {}) }])),
        dimensions: Object.fromEntries(Object.entries(s.dimensions).map(([n, d]) =>
          [n, { ...(d.entity ? { entity: d.entity } : {}), history: d.history, labelled: !!d.label, ...(d.description ? { description: d.description } : {}) }])),
      }
    }
    return entry
  })
}

export interface MemberMatch { member: string | null; label: string | null; match: 'exact' | 'starts' | 'contains' | 'close'; distance?: number }
export interface Members { relation: string; dimension: string; search?: string; matches: MemberMatch[]; ambiguous: boolean; callIds: string[] }

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}

type Call = <T>(name: string, request: Record<string, unknown>, options?: CallOptions) => Promise<{ value: T; callId: string }>

export async function members(store: GraphStore, call: Call, relation: string,
                              ask: { dimension: string; search?: string; at?: Coordinates['at']; during?: Coordinates['during']; limit?: number },
                              options: CallOptions = {}): Promise<Members> {
  const hash = store.resolve(relation)
  const c = hash ? store.getProgram(hash)!.contract : null
  if (!c || c.returns !== 'relation' || !c.shape) throw new Error(`"${relation}" is not a relation`)
  const dim = c.shape.dimensions[ask.dimension] ?? (() => { throw new Error(`"${relation}" has no dimension "${ask.dimension}"`) })()
  const measure = Object.entries(c.shape.measures).find(([, m]) => !isDerived(m))![0]
  const text = dim.label ? `${ask.dimension}_label` : ask.dimension
  const when = kindOf(c.shape) === 'flow'
    ? { during: ask.during ?? (() => { throw new Error(`"${relation}" holds flows: say which span its members are looked for in (during)`) })() }
    : { at: ask.at ?? 'today' }
  const limit = ask.limit ?? 20
  const callIds: string[] = []
  const read = async (where: Record<string, unknown>, n: number) => {
    const r = await call<any>(relation, { measures: [measure], by: [ask.dimension], where, ...when, order: [{ by: text }], limit: n }, { ...options, checks: 'light' })
    callIds.push(r.callId)
    return r.value.rows as Array<Record<string, any>>
  }
  const toMatch = (r: Record<string, any>, match: MemberMatch['match'], d?: number): MemberMatch =>
    ({ member: r[ask.dimension] ?? null, label: dim.label ? r[`${ask.dimension}_label`] ?? null : null, match, ...(d != null ? { distance: d } : {}) })

  if (!ask.search) {
    const rows = await read({}, limit)
    return { relation, dimension: ask.dimension, matches: rows.map((r) => toMatch(r, 'exact')), ambiguous: false, callIds }
  }
  const typed = norm(ask.search)
  let matches = (await read({ [text]: { contains: ask.search } }, limit)).map((r) => {
    const t = norm(r[text])
    return toMatch(r, t === typed ? 'exact' : t.startsWith(typed) ? 'starts' : 'contains')
  })
  if (!matches.length && typed.length >= 3) {
    // Nothing contains what was typed: look for it within a few typing mistakes, among every member.
    const tolerance = Math.max(1, Math.floor(typed.length / 4))
    matches = (await read({}, 5000))
      .map((r) => ({ r, d: distance(typed, norm(r[text])) }))
      .filter(({ d }) => d <= tolerance)
      .sort((a, b) => a.d - b.d)
      .slice(0, limit)
      .map(({ r, d }) => toMatch(r, 'close', d))
  }
  const rank = { exact: 0, starts: 1, contains: 2, close: 3 }
  matches.sort((a, b) => rank[a.match] - rank[b.match] || (a.distance ?? 0) - (b.distance ?? 0))
  const best = matches[0]
  const tied = best ? matches.filter((m) => m.match === best.match && (m.distance ?? 0) === (best.distance ?? 0)) : []
  return { relation, dimension: ask.dimension, search: ask.search, matches, ambiguous: tied.length > 1, callIds }
}
