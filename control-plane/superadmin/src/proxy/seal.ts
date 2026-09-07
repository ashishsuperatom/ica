// ── SEALING CREDENTIALS ──────────────────────────────────────────────────────────────────────────────────
// Values live in KV, so KV should not be able to give them up on its own. One master key, held where KV is
// not — a Worker secret — and everything in the store is ciphertext. Someone who obtains a dump of the
// namespace gets nothing usable without also obtaining the secret, which lives in a different system with
// different access.
//
// AES-256-GCM via WebCrypto, which is native in Workers and in Node 18+. That choice is not sophistication,
// it is the opposite: it is less code than anything hand-rolled, and it is authenticated — a tampered value
// fails to decrypt instead of silently becoming a different credential. Writing our own would be more work
// and worse.
//
// SPEED. AES-GCM is hardware-accelerated and a credential is a short string, so this is microseconds. The key
// is imported once per isolate and reused; importKey is the only part with any cost, and it happens on the
// first decrypt of an isolate's life, not per call.
//
// FORMAT: `v1.<base64url iv>.<base64url ciphertext+tag>`. Versioned from the start, because changing a format
// with no version means guessing later what an old value was.

const VERSION = 'v1'
const enc = new TextEncoder()
const dec = new TextDecoder()

const b64u = (b: ArrayBuffer | Uint8Array): string => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b)
  let s = ''
  for (const x of bytes) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const unb64u = (s: string): Uint8Array => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(t + '='.repeat((4 - (t.length % 4)) % 4))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

// One import per isolate, keyed by the master so a rotated key is not served from a stale handle.
let cached: { master: string; key: CryptoKey } | null = null
async function keyFor(master: string): Promise<CryptoKey> {
  if (cached?.master === master) return cached.key
  const raw = unb64u(master)
  if (raw.length !== 32) throw new Error('master key must be 32 bytes, base64url — generate with sealKeygen()')
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  cached = { master, key }
  return key
}

/** A fresh master key, base64url. Store it as a Worker secret; it is the only thing that must not be in KV. */
export function sealKeygen(): string {
  return b64u(crypto.getRandomValues(new Uint8Array(32)))
}

export async function seal(plaintext: string, master: string): Promise<string> {
  const key = await keyFor(master)
  // A NEW iv every time. Reusing one with the same key breaks GCM badly — this is the single rule that
  // matters here, so it is done in the one place that can enforce it.
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext))
  return `${VERSION}.${b64u(iv)}.${b64u(ct)}`
}

export async function unseal(blob: string, master: string): Promise<string> {
  const key = await keyFor(master)
  const [v, iv, ct] = blob.split('.')
  if (v !== VERSION) throw new Error(`sealed value has version ${v}, this build understands ${VERSION}`)
  const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, key, unb64u(ct))
  return dec.decode(out)
}

/** Is this a sealed value, or something written before sealing existed? Lets a store hold both while values
 *  are migrated, instead of needing every credential re-entered on the day this shipped. */
export const isSealed = (s: string): boolean => s.startsWith(VERSION + '.') && s.split('.').length === 3
