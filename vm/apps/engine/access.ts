// DATA ACCESS, PER READER. Whatever a program reads on someone's behalf is read under that person's (or agent's) data
// access policies: the platform resolves them (the project's DO), the datasource manager's rewrite applies them to every
// table the query reads. The reader is carried with the work (an async context), so a program never passes it and
// cannot drop it. Resolved policies are kept per reader and source until the platform says they changed. If they cannot
// be resolved, the read is refused — access fails closed.

import { AsyncLocalStorage } from 'node:async_hooks'
import { writeFile } from 'node:fs/promises'
import { whoIs, type Who } from './identity.js'
import { signTicket } from '@superatom/datasource-manager/ticket'

export class AccessRefusal extends Error {}
const context = new AsyncLocalStorage<Who>()

/** Run work as a reader: every query inside it carries their policies. */
export const asReader = <T>(who: Who, work: () => Promise<T>): Promise<T> => context.run(who, work)
/** The reader of the work running now, or null (the platform's own work: introspection, indexing). */
export const currentReader = (): Who | null => context.getStore() ?? null

export function createAccess(o: { send: (msg: Record<string, unknown>) => boolean; timeoutMs?: number; onVersion?: (v: number) => void }) {
  let version = -1
  const setVersion = (v: number) => { if (v === version) return; version = v; cache.clear(); o.onVersion?.(v) }
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
    if (p.t === 'access:changed') { if (typeof p.version === 'number') setVersion(p.version); return }
    if (p.t === 'access:resolved') {
      const w = waiting.get(p.reqId); if (!w) return
      waiting.delete(p.reqId); clearTimeout(w.timer)
      if (p.error) w.reject(new AccessRefusal(`your data access could not be checked: ${p.error}`))
      else { if (typeof p.version === 'number') setVersion(p.version); w.resolve(Array.isArray(p.policies) ? p.policies : []) }
    }
  }
  return { policiesFor, onMessage, version: () => version }
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

/** The ticket for whoever a piece of work is for (ticket.ts): their policies on every source, signed with the manager's
 *  key. 'unchecked' when their access could not be resolved — the data seam then reads nothing. */
export async function ticketFor(access: { policiesFor(who: Who, source: string): Promise<unknown[]>; version(): number }, from: any, sources: () => Promise<string[]>, key: string, session?: string | null): Promise<string> {
  const r = await readerFor(access, from, sources)
  if ('unchecked' in r) return 'unchecked'
  let email: string | null = null
  try { email = whoIs(from).email ?? null } catch { /* the platform's own work */ }
  return signTicket(key, { principal: r.principal, email, policies: r.policies, session: session ?? null, access: access.version() })
}

/** A ticket for a reader already known (a program run inside asReader). */
export async function ticketOf(access: { policiesFor(who: Who, source: string): Promise<unknown[]>; version(): number }, who: Who, sources: string[], key: string): Promise<string> {
  const policies: Record<string, unknown[]> = {}
  for (const id of sources) { const p = await access.policiesFor(who, id); if (p.length) policies[id] = p }
  return signTicket(key, { principal: who.id, email: who.email ?? null, policies, access: access.version() })
}

/** Keep a ticket in a file for as long as some work runs (an agent's turn reads it beside its folder): written now,
 *  renewed every 10 minutes (a ticket lives 15), emptied when the work ends so it never outlives it. */
export async function holdTicket(file: string, mint: () => Promise<string>): Promise<() => Promise<void>> {
  await writeFile(file, await mint().catch(() => 'unchecked'))
  const renew = setInterval(() => { void mint().then((t) => writeFile(file, t), () => writeFile(file, 'unchecked')).catch(() => {}) }, 10 * 60_000)
  renew.unref?.()
  return async () => { clearInterval(renew); await writeFile(file, '').catch(() => {}) }
}
