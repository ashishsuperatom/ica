// A CACHE IN THIS BROWSER, least recently used first out: a named space of answers kept in localStorage, within a count
// and a size. It is only a copy — what is shown from it is always asked again — so when storage is full or blocked the
// whole space is dropped and the page simply asks. Each space is its own (the warehouse's, say), apart from settings.

export interface Lru { get<T>(key: string): T | undefined; set(key: string, value: unknown): void; clear(): void }

export function lru(space: string, { maxEntries = 400, maxBytes = 3_000_000, maxEntry = 400_000 } = {}): Lru {
  const prefix = `sa.lru.${space}:`
  const indexKey = `${prefix}#index`
  const store = (): Storage | null => { try { return globalThis.localStorage ?? null } catch { return null } }
  const index = (): string[] => { try { const v = JSON.parse(store()?.getItem(indexKey) ?? '[]'); return Array.isArray(v) ? v.map(String) : [] } catch { return [] } }
  const clear = () => { try { const s = store(); if (!s) return; for (const k of Object.keys(s)) if (k.startsWith(prefix)) s.removeItem(k) } catch { /* nothing to clear */ } }
  return {
    get<T>(key: string): T | undefined {
      try {
        const s = store(); const raw = s?.getItem(prefix + key)
        if (raw == null || !s) return undefined
        const keys = index().filter((k) => k !== key); keys.push(key); s.setItem(indexKey, JSON.stringify(keys))
        return JSON.parse(raw) as T
      } catch { return undefined }
    },
    set(key: string, value: unknown) {
      try {
        const s = store(); if (!s) return
        const body = JSON.stringify(value)
        if (body.length > maxEntry) return
        s.setItem(prefix + key, body)
        const keys = index().filter((k) => k !== key); keys.push(key)
        let bytes = keys.reduce((n, k) => n + (s.getItem(prefix + k)?.length ?? 0), 0)
        while (keys.length > maxEntries || bytes > maxBytes) { const old = keys.shift()!; bytes -= s.getItem(prefix + old)?.length ?? 0; s.removeItem(prefix + old) }
        s.setItem(indexKey, JSON.stringify(keys))
      } catch { clear() }
    },
    clear,
  }
}
