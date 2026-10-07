// The graph's change log, summed up as one value both ends compute the same way — the platform from what it holds, an
// engine from its replica — so a replica that drifted is found. Pure: Web Crypto only (worker and Node alike).

/** The fingerprint of a change log: how many changes, the last one, and a SHA-256 over each change's id, name and content. */
export async function changesFingerprint(rows: { id: number; name: string; to_hash: string | null }[]): Promise<{ count: number; last: number; hash: string }> {
  const sorted = [...rows].sort((a, b) => Number(a.id) - Number(b.id))
  const bytes = new TextEncoder().encode(sorted.map((r) => `${Number(r.id)}\t${r.name}\t${r.to_hash ?? ''}`).join('\n'))
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
  return { count: sorted.length, last: sorted.length ? Number(sorted[sorted.length - 1].id) : 0, hash }
}
