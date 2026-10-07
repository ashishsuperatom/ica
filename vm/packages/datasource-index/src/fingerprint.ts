// A source's index, summed up as one value both ends compute the same way — the platform from what it holds, an engine
// from its replica — so a replica that drifted (a damaged file, a hand edit) is found, and only that source pulled again.
// Pure: Web Crypto only, so it runs in a worker (the platform) and in Node (the engine) alike.

/** One item as both ends hold it (a table when field is ''). */
export interface FingerprintItem { table: string; field: string; type: string | null; descSource: string | null; descHuman: string | null; descAi: string | null
  optional: boolean | null; key: boolean | null; references: string | null; rows: number | null; enabled: boolean; gone: boolean }

const line = (i: FingerprintItem) => JSON.stringify([i.table, i.field, i.type ?? null, i.descSource ?? null, i.descHuman ?? null, i.descAi ?? null, i.optional ?? null, i.key ?? null, i.references ?? null, i.rows ?? null, !!i.enabled, !!i.gone])

/** The fingerprint of one source's items: how many, and a SHA-256 over them in one order. */
export async function fingerprintOf(items: FingerprintItem[]): Promise<{ count: number; hash: string }> {
  const lines = items.map(line).sort()
  const bytes = new TextEncoder().encode(lines.join('\n'))
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
  return { count: items.length, hash }
}
