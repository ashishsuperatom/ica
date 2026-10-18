// WHAT THE WORLD MODEL NEEDS FROM WHOEVER RUNS IT — and nothing else (DESIGN.md "A core of its own"). The host implements
// these: Superatom keeps the journal on the platform and the cache on the engine; a test or a standalone use passes the
// in-memory ones below (or the files of ./node.ts).
//
//   Journal  the record — append-only, the truth. Every model's entries in one journal, each naming its model.
//   Cache    what is computed from the journal — disposable, always rebuildable from the journal alone.
//   Clock    the time.

/** One entry of the journal. `seq` is given by the journal when it is stored, in order, never reused. */
export interface Entry<D = unknown> {
  seq: number
  /** When it happened (milliseconds since the epoch). */
  at: number
  /** The model it belongs to. */
  model: string
  /** What kind of entry it is, as its model names it ("decision", "outcome", …). */
  kind: string
  data: D
}

export type NewEntry<D = unknown> = Omit<Entry<D>, 'seq'>

export interface Journal {
  /** Store entries, in order, all or none; resolves with the last one's seq once they are stored. */
  append(entries: NewEntry[]): Promise<number>
  /** Entries after `since` (0: from the start), in order — at most `limit`; `next` is the cursor to read on from. */
  read(since: number, limit?: number): Promise<{ entries: Entry[]; next: number }>
}

export interface Cache {
  get<T>(key: string): Promise<T | null>
  put(key: string, value: unknown): Promise<void>
}

export interface Clock {
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }

/** A journal kept in memory: for tests, and for a model that need not outlive its process. */
export function memoryJournal(): Journal & { entries: Entry[] } {
  const entries: Entry[] = []
  return {
    entries,
    async append(batch) {
      for (const e of batch) entries.push({ ...e, seq: entries.length + 1 })
      return entries.length
    },
    async read(since, limit = 1000) {
      const slice = entries.slice(since, since + limit)
      return { entries: slice, next: since + slice.length }
    },
  }
}

/** A cache kept in memory. */
export function memoryCache(): Cache & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>()
  return {
    values,
    async get<T>(key: string) { return (values.has(key) ? structuredClone(values.get(key)) : null) as T | null },
    async put(key, value) { values.set(key, structuredClone(value)) },
  }
}

/** Every entry of a journal after `since`, page by page. */
export async function* readAll(journal: Journal, since = 0, page = 1000): AsyncGenerator<Entry> {
  let at = since
  for (;;) {
    const { entries, next } = await journal.read(at, page)
    for (const e of entries) yield e
    if (!entries.length || next === at) return
    at = next
  }
}
