// ── What this browser keeps: one cache for every web client ─────────────────────────────────────────────────
//
// IndexedDB (localStorage holds a few MB; an index is ten), one store of values by key, least recently used out past
// a size. Two uses, both copies — what is shown from here is always asked again:
//   • parcels by hash (parcels.ts): content-addressed, so a body kept is the body; the same parcel is never fetched twice
//   • last answers (a client's `kept` call): shown at once on the next visit, then replaced if the fresh answer differs
// Where there is no IndexedDB (the engine on Node, a worker, a blocked or private browser) every call is a no-op and
// the client simply asks. Nothing secret is kept: secrets never travel as parcels or as kept answers.

const DB = 'superatom', STORE = 'kept', MAX_BYTES = 200 * 1024 * 1024

interface Entry { key: string; value: unknown; bytes: number; used: number }
// IndexedDB's own types are the DOM's, which the engine (Node) does not compile against: the few parts used, typed here.
type Req<T = unknown> = { result: T; error: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null }
type Store = { get(k: string): Req; put(v: Entry): Req; delete(k: string): Req; clear(): Req; index(n: string): { getAll(): Req<Entry[]> } }
type Db = { transaction(s: string, mode: 'readwrite'): { objectStore(s: string): Store } }
const idb = (): { open(name: string, v: number): Req<any> & { onupgradeneeded: (() => void) | null; onblocked: (() => void) | null } } | undefined => (globalThis as any).indexedDB

let opened: Promise<Db | null> | null = null
function db(): Promise<Db | null> {
  if (opened) return opened
  opened = new Promise((resolve) => {
    try {
      const i = idb(); if (!i) return resolve(null)
      const r = i.open(DB, 1)
      r.onupgradeneeded = () => { const s = r.result.createObjectStore(STORE, { keyPath: 'key' }); s.createIndex('used', 'used') }
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => resolve(null)
      r.onblocked = () => resolve(null)
    } catch { resolve(null) }
  })
  return opened
}
const done = <T>(r: Req<T>) => new Promise<T>((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) })

/** The value kept under a key, or undefined. */
export async function keptGet<T>(key: string): Promise<T | undefined> {
  try {
    const d = await db(); if (!d) return undefined
    const s = d.transaction(STORE, 'readwrite').objectStore(STORE)
    const e = await done(s.get(key)) as Entry | undefined
    if (!e) return undefined
    s.put({ ...e, used: Date.now() })   // most recently used
    return e.value as T
  } catch { return undefined }
}

/** Keep a value under a key (its size in bytes, if known; else measured). The least recently used go past the limit. */
export async function keptSet(key: string, value: unknown, bytes?: number): Promise<void> {
  try {
    const d = await db(); if (!d) return
    const size = bytes ?? (typeof value === 'string' ? value.length : JSON.stringify(value)?.length ?? 0)
    if (size > MAX_BYTES / 4) return
    await done(d.transaction(STORE, 'readwrite').objectStore(STORE).put({ key, value, bytes: size, used: Date.now() } satisfies Entry))
    void trim(d)
  } catch { /* a copy not kept is only a copy not kept */ }
}

/** Everything kept, gone (signing out). */
export async function keptClear(): Promise<void> {
  try { const d = await db(); if (d) await done(d.transaction(STORE, 'readwrite').objectStore(STORE).clear()) } catch { /* nothing kept */ }
}

async function trim(d: Db) {
  const s = d.transaction(STORE, 'readwrite').objectStore(STORE)
  const all = (await done(s.index('used').getAll())) as Entry[]   // oldest first
  let total = all.reduce((n, e) => n + e.bytes, 0)
  for (const e of all) { if (total <= MAX_BYTES) break; s.delete(e.key); total -= e.bytes }
}
