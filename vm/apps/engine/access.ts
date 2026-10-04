// DATA ACCESS, PER READER. Whatever a program reads on someone's behalf is read under that person's (or agent's) data
// access policies: the platform resolves them (the project's DO), the datasource manager's rewrite applies them to every
// table the query reads. The reader is carried with the work (an async context), so a program never passes it and
// cannot drop it. Resolved policies are kept per reader and source until the platform says they changed. If they cannot
// be resolved, the read is refused — access fails closed.

import { AsyncLocalStorage } from 'node:async_hooks'
import { whoIs, type Who } from './identity.js'

export class AccessRefusal extends Error {}
const context = new AsyncLocalStorage<Who>()

/** Run work as a reader: every query inside it carries their policies. */
export const asReader = <T>(who: Who, work: () => Promise<T>): Promise<T> => context.run(who, work)
/** The reader of the work running now, or null (the platform's own work: introspection, indexing). */
export const currentReader = (): Who | null => context.getStore() ?? null

export function createAccess(o: { send: (msg: Record<string, unknown>) => boolean; timeoutMs?: number }) {
  let version = -1
  const cache = new Map<string, unknown[]>()
  const waiting = new Map<string, { resolve: (p: unknown[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let n = 0

  async function policiesFor(who: Who, source: string): Promise<unknown[]> {
    const key = `${who.id}|${who.email ?? ''}|${source}`
    const have = cache.get(key)
    if (have) return have
    const reqId = `acc-${++n}`
    return new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(reqId); reject(new AccessRefusal('your data access could not be checked (the platform did not answer) — nothing was read')) }, o.timeoutMs ?? 10_000)
      waiting.set(reqId, { resolve: (p) => { cache.set(key, p); resolve(p) }, reject, timer })
      if (!o.send({ type: 'access:resolve', principal: who.id, ...(who.email ? { email: who.email } : {}), source, reqId })) {
        clearTimeout(timer); waiting.delete(reqId); reject(new AccessRefusal('your data access could not be checked (not connected to the platform) — nothing was read'))
      }
    })
  }

  function onMessage(p: any): void {
    if (p.t === 'access:changed') { if (p.version !== version) { version = p.version; cache.clear() } return }
    if (p.t === 'access:resolved') {
      const w = waiting.get(p.reqId); if (!w) return
      waiting.delete(p.reqId); clearTimeout(w.timer)
      if (p.error) w.reject(new AccessRefusal(`your data access could not be checked: ${p.error}`))
      else { if (typeof p.version === 'number' && p.version !== version) { version = p.version; cache.clear() } w.resolve(Array.isArray(p.policies) ? p.policies : []) }
    }
  }
  return { policiesFor, onMessage }
}

/** The policies of whoever asked a turn, per source, for an agent's tools to send with every query (the data seam reads
 *  them). Unknown asker → none (the platform's own work); policies that cannot be resolved → unchecked (nothing read). */
export async function readerFor(access: { policiesFor(who: Who, source: string): Promise<unknown[]> }, from: any, sources: () => Promise<string[]>):
    Promise<{ principal: string; policies: Record<string, unknown[]> } | { unchecked: true }> {
  let who: Who
  try { who = whoIs(from) } catch { return { principal: 'platform', policies: {} } }
  try {
    const policies: Record<string, unknown[]> = {}
    for (const id of await sources()) { const p = await access.policiesFor(who, id); if (p.length) policies[id] = p }
    return { principal: who.id, policies }
  } catch { return { unchecked: true } }
}
