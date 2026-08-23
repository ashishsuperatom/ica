// ── Storage ──────────────────────────────────────────────────────────────────
// R2, not KV, and not a Durable Object.
//
//  • Not a DO: a report is written once, never mutated, and read from everywhere.
//    A DO would pin every read to the one region that owns the object, buying
//    coordination we don't need and paying latency for it.
//  • Not KV: KV is eventually consistent, and our flow is *POST → share the URL →
//    a CDN fetches it a second later from another region*. That is precisely where
//    KV can 404 on a report that definitely exists. R2 is strongly consistent
//    read-after-write, stores binary natively (base64 would inflate every PNG by
//    a third), and has no 25MB value cap.
//
// Everything lives under one prefix inside a SHARED bucket, so nothing here may
// ever list or delete outside it.

const PREFIX = 'reporting'

export const jsonKey = (projectId: string, id: string) => `${PREFIX}/${projectId}/${id}.json`
export const pngKey = (projectId: string, id: string, scale: number, theme: string) =>
  `${PREFIX}/${projectId}/${id}@${scale}x-${theme}.png`

export interface Stored<T> { body: T; uploaded: number }

export async function putJson(bucket: R2Bucket, key: string, value: unknown, expiresAt: number): Promise<void> {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: 'application/json' },
    // Kept as metadata rather than relying on a bucket lifecycle rule: this bucket is
    // shared with unrelated artefacts, so a rule written for those must never be able
    // to reach these, and vice versa. Expiry is enforced on read.
    customMetadata: { expiresAt: String(expiresAt) },
  })
}

export async function getJson<T>(bucket: R2Bucket, key: string): Promise<{ value: T; expiresAt: number } | null> {
  const obj = await bucket.get(key)
  if (!obj) return null
  const expiresAt = Number(obj.customMetadata?.expiresAt ?? 0)
  return { value: await obj.json<T>(), expiresAt }
}

export async function putBytes(bucket: R2Bucket, key: string, bytes: Uint8Array, contentType: string, expiresAt: number): Promise<void> {
  await bucket.put(key, bytes as unknown as ArrayBuffer, {
    httpMetadata: { contentType },
    customMetadata: { expiresAt: String(expiresAt) },
  })
}

export async function getBytes(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  return await bucket.get(key)
}
