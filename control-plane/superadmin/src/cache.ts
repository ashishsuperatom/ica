// THE CONSOLE'S CACHE — the data the admin console shows, kept in this browser so moving between places is instant.
//
// Every read is shown from here first (if it was read before) AND asked of the server every time; when the server's
// answer differs, it replaces what was shown. So nothing stale stays on screen — the cache only makes the first look
// immediate. Least recently used goes first, within a size and a count; if the browser's storage is full, the whole cache
// is dropped (it is only a copy). It holds data only: the sign-in token and small settings are kept elsewhere, apart.
//
// A key says who is looking, in which organisation, at what: `<who>|<org>|<path>`.

/** This browser's storage (the file is the console's; the Worker's typecheck reads it too, without a DOM). */
const localStorage = (globalThis as unknown as { localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void; [k: string]: unknown } }).localStorage
const PREFIX = 'sa.admin-cache:'
const INDEX = `${PREFIX}index`
const MAX_ENTRIES = 300
const MAX_BYTES = 4_000_000
const MAX_ENTRY = 500_000

function index(): string[] {
  try { const v = JSON.parse(localStorage.getItem(INDEX) ?? '[]'); return Array.isArray(v) ? v.map(String) : [] } catch { return [] }
}
function saveIndex(keys: string[]) { try { localStorage.setItem(INDEX, JSON.stringify(keys)) } catch { clear() } }

/** Everything the cache holds, gone (storage full, or asked for). */
export function clear() {
  try { for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k) } catch { /* nothing to clear */ }
}

/** What was last read for this key, or null — and it becomes the most recently used. */
export function cached(key: string): string | null {
  try {
    const v = localStorage.getItem(PREFIX + key)
    if (v === null) return null
    const keys = index().filter((k) => k !== key); keys.push(key); saveIndex(keys)
    return v
  } catch { return null }
}

/** Keep what was read; the least recently used go when there are too many or too much. */
export function keep(key: string, body: string) {
  if (body.length > MAX_ENTRY) return
  try {
    localStorage.setItem(PREFIX + key, body)
    let keys = index().filter((k) => k !== key); keys.push(key)
    let bytes = keys.reduce((n, k) => n + (localStorage.getItem(PREFIX + k)?.length ?? 0), 0)
    while (keys.length > MAX_ENTRIES || bytes > MAX_BYTES) {
      const old = keys.shift()!
      bytes -= localStorage.getItem(PREFIX + old)?.length ?? 0
      localStorage.removeItem(PREFIX + old)
    }
    saveIndex(keys)
  } catch {
    clear()   // the browser's storage is full: the cache is only a copy, so it goes
  }
}

/** Forget what one person read in one organisation (after they changed something there). */
export function forget(prefix: string) {
  const keys = index()
  const left = keys.filter((k) => !k.startsWith(prefix))
  try { for (const k of keys) if (k.startsWith(prefix)) localStorage.removeItem(PREFIX + k) } catch { /* nothing */ }
  saveIndex(left)
}

// A fresh answer that differs from what was shown: everything reading through the console's api reads again (and gets
// the fresh copy at once). One revision, listened to by every useApi.
let rev = 0
const listeners = new Set<() => void>()
let pending = 0 as unknown as ReturnType<typeof setTimeout>
// An answer that differs every time it is asked (it carries the time, say) would otherwise refresh the screen for ever: a
// key that changes again within a minute of its last change is volatile — its newest copy is kept, but it no longer makes
// everything read again.
const lastFor = new Map<string, number>()
const volatile = new Set<string>()
export function changed(key: string) {
  const now = Date.now()
  if (volatile.has(key)) return
  if (now - (lastFor.get(key) ?? 0) < 60_000) { volatile.add(key); return }
  lastFor.set(key, now)
  clearTimeout(pending); pending = setTimeout(() => { rev++; for (const l of listeners) l() }, 50)
}
export const revision = () => rev
export function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } }
