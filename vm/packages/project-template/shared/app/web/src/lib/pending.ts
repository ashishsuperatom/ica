// The requests waiting for a reply, each with its own clock. A clock is restarted by anything that proves the
// engine is still on it — a part of a big reply, a narrated line or an agent's own frame about the request — and
// only silence for the whole of a request's timeout gives up. A narrated line is passed on to whoever asked (the
// placeholder shows the latest) and never resolves the request. Pure, with injectable timers, so the rule can be tested without a socket.

import type { Reply } from './wire'

export interface Waiting {
  resolve: (r: Reply) => void
  reject: (e: Error) => void
  timeoutMs: number
  onBeat?: (text: string) => void
  /** A piece of the answer, as the agent says it. Never a reply. */
  onPart?: (text: string, blocks?: unknown[]) => void
}
type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void }

export class Pending {
  private map = new Map<string, Waiting & { timer?: unknown; qid?: string; last?: string }>()
  private timers: Timers
  constructor(timers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) }) { this.timers = timers }
  get size() { return this.map.size }
  has(reqId: string) { return this.map.has(reqId) }
  add(reqId: string, w: Waiting) { this.map.set(reqId, { ...w }); this.arm(reqId) }
  /** Start (or restart) a request's clock. */
  arm(reqId: string) {
    const w = this.map.get(reqId)
    if (!w) return
    if (w.timer !== undefined) this.timers.clear(w.timer)
    w.timer = this.timers.set(() => { this.map.delete(reqId); w.reject(new Error('No reply from the engine in time.')) }, w.timeoutMs)
  }
  /** The request a frame is about: by its reqId, else by the qid the request was seen with earlier (a channel copy
   * after a reconnect carries the qid alone). */
  private find(reqId?: string, qid?: string): string | undefined {
    if (reqId && this.map.has(reqId)) { if (qid) this.map.get(reqId)!.qid = qid; return reqId }
    if (qid) for (const [id, w] of this.map) if (w.qid === qid) return id
    return undefined
  }
  /** A sign of life for a request (a narrated line): the clock restarts and the words are passed on once — the
   * same line twice (the direct frame and the channel's copy) is passed on once. Nothing is resolved. */
  beat(reqId: string | undefined, text: string, qid?: string): boolean {
    const id = this.find(reqId, qid)
    if (!id) return false
    const w = this.map.get(id)!
    this.arm(id)
    const key = `${qid ?? ''}\u0000${text}`
    if (text && w.last !== key) { w.last = key; w.onBeat?.(text) }
    return true
  }
  /** Raw work on a request (an agent's own frames): the clock restarts, nothing is shown. */
  part(reqId: string | undefined, text: string, qid?: string, blocks?: unknown[]): boolean {
    const id = this.find(reqId, qid)
    if (!id) return false
    this.arm(id)
    if (text) this.map.get(id)!.onPart?.(text, blocks)
    return true
  }
  touch(reqId: string | undefined, qid?: string): boolean {
    const id = this.find(reqId, qid)
    if (!id) return false
    this.arm(id)
    return true
  }
  /** The request is answered: it leaves the table, its clock stops. */
  take(reqId: string): Waiting | undefined {
    const w = this.map.get(reqId)
    if (!w) return undefined
    this.map.delete(reqId)
    if (w.timer !== undefined) this.timers.clear(w.timer)
    return w
  }
  /** Every request fails at once (the connection went). */
  failAll(why: string) {
    for (const [id, w] of this.map) { if (w.timer !== undefined) this.timers.clear(w.timer); this.map.delete(id); w.reject(new Error(why)) }
  }
}
