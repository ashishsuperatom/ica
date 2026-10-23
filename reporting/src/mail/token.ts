// ── Per-app mail tokens ──────────────────────────────────────────────────────
// A token is `v1.<payload>.<hmac>`, where payload is base64url JSON:
//
//   { k: kid, e: expiry, p: project, d: recipient domains, n: From display name }
//
// The registry lives in the MAIL_SIGNING_KEYS secret and is authoritative: the
// token's project/domains/name are checked against it, so a token cannot widen
// its own scope. One key per app, not one shared key. Rotate by adding a new kid,
// issuing a new token, then removing the old kid.

import type { SigningKeyEntry, SigningRegistry, TokenClaims } from './types.js'

const TOKEN_VERSION = 'v1'
const MAX_TOKEN_CHARS = 4096
const MAX_CLOCK_SKEW_SECONDS = 60

export type VerifyResult =
  | { ok: true; claims: TokenClaims; entry: SigningKeyEntry }
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' | 'unknown_kid' | 'config' }

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('not base64url')
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  return base64ToBytes(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
}

/** Secrets are usually base64url, but accept ordinary base64 too. */
function decodeKey(value: string): Uint8Array {
  const normalised = value.trim().replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalised)) throw new Error('not base64')
  return base64ToBytes(normalised + '='.repeat((4 - (normalised.length % 4)) % 4))
}

function isDomain(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(value)
}

function cleanDomains(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return null
  if (!value.every((domain) => typeof domain === 'string' && isDomain(domain.toLowerCase()))) return null
  const domains = [...new Set(value.map((domain) => (domain as string).toLowerCase()))].sort()
  return domains.length === value.length ? domains : null
}

function isEntry(value: unknown): value is SigningKeyEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  if (typeof entry.key !== 'string' || entry.key.length < 43 || entry.key.length > 256) return false
  if (typeof entry.project !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(entry.project)) return false
  if (!cleanDomains(entry.domains)) return false
  if (typeof entry.fromName !== 'string' || entry.fromName.length < 1 || entry.fromName.length > 100) return false
  if (/[\u0000-\u001F\u007F]/.test(entry.fromName)) return false
  try {
    const bytes = decodeKey(entry.key)
    return bytes.length >= 32 && bytes.length <= 64
  } catch {
    return false
  }
}

/** Parse the MAIL_SIGNING_KEYS secret. Returns null on any malformed entry. */
export function parseRegistry(secret: string | undefined): SigningRegistry | null {
  if (!secret) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(secret)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const registry: SigningRegistry = {}
  for (const [kid, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(kid) || !isEntry(raw)) return null
    registry[kid] = {
      key: raw.key,
      project: raw.project,
      domains: cleanDomains(raw.domains) ?? [],
      fromName: raw.fromName,
    }
  }
  return Object.keys(registry).length ? registry : null
}

function isClaims(value: unknown): value is TokenClaims {
  if (!value || typeof value !== 'object') return false
  const claims = value as Record<string, unknown>
  return (
    typeof claims.k === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(claims.k) &&
    Number.isInteger(claims.e) && (claims.e as number) >= 0 &&
    typeof claims.p === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(claims.p) &&
    Array.isArray(claims.d) && claims.d.length > 0 && claims.d.length <= 20 &&
    claims.d.every((domain) => typeof domain === 'string' && isDomain(domain)) &&
    new Set(claims.d).size === claims.d.length &&
    typeof claims.n === 'string' && claims.n.length > 0 && claims.n.length <= 100 &&
    !/[\u0000-\u001F\u007F]/.test(claims.n)
  )
}

async function importHmac(raw: Uint8Array, usages: string[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, usages)
}

async function signPayload(key: CryptoKey, payload: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${TOKEN_VERSION}.${payload}`))
  return base64UrlEncode(new Uint8Array(signature))
}

/** Mint a token. Used by scripts/mint-mail-token.mjs and by tests. */
export async function mintToken(
  registry: SigningRegistry,
  kid: string,
  ttlSeconds = 90 * 86400,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const entry = registry[kid]
  if (!entry) throw new Error(`unknown kid: ${kid}`)
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 366 * 86400) {
    throw new Error('ttlSeconds must be a positive integer no longer than 366 days')
  }
  if (!Number.isInteger(nowSeconds) || nowSeconds < 0) throw new Error('nowSeconds must be a non-negative integer')

  const domains = cleanDomains(entry.domains)
  if (!domains) throw new Error('entry has no valid domains')

  const claims: TokenClaims = {
    k: kid,
    e: nowSeconds + ttlSeconds,
    p: entry.project,
    d: domains,
    n: entry.fromName,
  }
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)))
  const key = await importHmac(decodeKey(entry.key), ['sign'])
  return `${TOKEN_VERSION}.${payload}.${await signPayload(key, payload)}`
}

/**
 * Verify the Authorization header and every claim against the registry.
 * `nowMs` is injectable so expiry can be tested without sleeping.
 */
export async function verifyAuthorization(
  header: string | null | undefined,
  secret: string | undefined,
  nowMs = Date.now(),
): Promise<VerifyResult> {
  if (!header) return { ok: false, reason: 'missing' }
  const registry = parseRegistry(secret)
  if (!registry) return { ok: false, reason: 'config' }

  const match = /^Bearer[ \t]+(\S+)$/i.exec(header)
  if (!match) return { ok: false, reason: 'invalid' }
  const token = match[1]
  if (token.length > MAX_TOKEN_CHARS) return { ok: false, reason: 'invalid' }

  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return { ok: false, reason: 'invalid' }
  const [, payload, signature] = parts
  if (!payload || !signature) return { ok: false, reason: 'invalid' }

  let claims: unknown
  try {
    claims = JSON.parse(decoder.decode(base64UrlDecode(payload)))
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (!isClaims(claims)) return { ok: false, reason: 'invalid' }

  const entry = registry[claims.k]
  if (!entry) return { ok: false, reason: 'unknown_kid' }

  let valid = false
  try {
    const key = await importHmac(decodeKey(entry.key), ['verify'])
    valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlDecode(signature),
      encoder.encode(`${TOKEN_VERSION}.${payload}`),
    )
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (!valid) return { ok: false, reason: 'invalid' }

  if (claims.e + MAX_CLOCK_SKEW_SECONDS < Math.floor(nowMs / 1000)) return { ok: false, reason: 'expired' }

  // The registry is authoritative. A correctly signed token still cannot change
  // its project, recipient domains or display name.
  const sameDomains =
    claims.d.length === entry.domains.length &&
    claims.d.every((domain) => entry.domains.includes(domain))
  if (claims.p !== entry.project || !sameDomains || claims.n !== entry.fromName) {
    return { ok: false, reason: 'invalid' }
  }

  return { ok: true, claims, entry }
}
