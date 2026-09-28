// "Show what you have, ask anyway." An in-memory, bounded, most-recently-used cache of answers, keyed by the
// normalised question (the JSON of the server's `question` field) and by the request that produced it — so a block
// opening on a question seen earlier can show that answer at once while the same request goes out again. The fresh
// answer replaces the shown one in place; when it is identical by JSON the shown object is kept, so nothing
// re-renders. The cache is per page session; the server is the only source of truth; nothing is ever served
// without being re-asked.

import type { Answer, Request } from './wire'

/** A bounded map that keeps the most recently used entries. A value may be reachable under several keys. */
export class LRU<V> {
  private entries = new Map<string, { keys: string[]; value: V }>()
  private order: Array<{ keys: string[]; value: V }> = []
  readonly max: number
  constructor(max: number) { this.max = max }
  get size() { return this.order.length }
  get(key: string): V | undefined {
    const e = this.entries.get(key)
    if (!e) return undefined
    this.order = [...this.order.filter((x) => x !== e), e] // touched: now the most recent
    return e.value
  }
  has(key: string) { return this.entries.has(key) }
  set(keys: string[], value: V) {
    for (const k of keys) { const old = this.entries.get(k); if (old) this.drop(old) }
    const e = { keys, value }
    for (const k of keys) this.entries.set(k, e)
    this.order.push(e)
    while (this.order.length > this.max) this.drop(this.order[0])
  }
  private drop(e: { keys: string[]; value: V }) {
    this.order = this.order.filter((x) => x !== e)
    for (const k of e.keys) if (this.entries.get(k) === e) this.entries.delete(k)
  }
}

export const questionKey = (q: unknown) => `q:${JSON.stringify(q)}`
export const requestKey = (r: Request) => `r:${JSON.stringify(r)}`

export interface Cached { answer: Answer; at: string }

export class AnswerCache {
  private lru: LRU<Cached>
  constructor(max = 40) { this.lru = new LRU<Cached>(max) }
  get size() { return this.lru.size }
  /** An answer seen earlier for this request, or for this question — to show at once while asking again. */
  lookup(request: Request, question?: unknown): Cached | undefined {
    return this.lru.get(requestKey(request)) ?? (question !== undefined ? this.lru.get(questionKey(question)) : undefined)
  }
  remember(request: Request, answer: Answer, at = new Date().toISOString()) {
    this.lru.set([requestKey(request), questionKey(answer.question)], { answer, at })
  }
}

/** The fresh answer, or the shown one when they are the same by JSON — so an unchanged answer does not re-render. */
export const reconcile = (shown: Answer | undefined, fresh: Answer): Answer => (shown && JSON.stringify(shown) === JSON.stringify(fresh) ? shown : fresh)

/** The members cache: per (dimension, typed text), the same serve-then-revalidate. */
export class MembersCache<M> {
  private lru = new LRU<M[]>(200)
  key(dim: string, typed: string) { return `${dim}\u0000${typed.trim().toLowerCase()}` }
  get(dim: string, typed: string) { return this.lru.get(this.key(dim, typed)) }
  set(dim: string, typed: string, matches: M[]) { this.lru.set([this.key(dim, typed)], matches) }
}
