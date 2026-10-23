// ── Exactly-once delivery state machine ──────────────────────────────────────
// A delivery is keyed by HMAC(MAIL_DEDUPE_KEY, project:id). The LEDGER holds
// only that key, a status, a timestamp and Cloudflare's message id — no
// recipient, subject, body or attachment ever reaches storage. The project is
// enough scope: the id is unique per app, and adding a recipient domain must not
// change the idempotency key of an email already in flight.
//
//   claim ──▶ sending ──▶ sent        (success; retries return the same id)
//                  │
//                  ├──▶ deleted       (definite pre-send failure; safe to retry)
//                  └──▶ sending       (ambiguous; never resend automatically)
//
// The rule that matters: an ambiguous result (timeout, E_DELIVERY_FAILED, an
// exception after send()) leaves `sending` in place. A later request gets 409
// and does not send again. Losing a possible duplicate is better than sending a
// report twice.

import type { DeliveryLedger, DeliverResult, MailEnv, OutboundEmail, SendResult } from './types.js'
import type { MailDelivery } from './delivery-do.js'

export const DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MIN_DEDUPE_KEY_BYTES = 32

let dedupeKey: { secret: string; key: CryptoKey } | undefined

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function decodeSecret(value: string): Uint8Array {
  const normalised = value.trim().replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalised)) throw new Error('MAIL_DEDUPE_KEY is not base64')
  return base64ToBytes(normalised + '='.repeat((4 - (normalised.length % 4)) % 4))
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (dedupeKey?.secret === secret) return dedupeKey.key
  const raw = decodeSecret(secret)
  if (raw.length < MIN_DEDUPE_KEY_BYTES) throw new Error('MAIL_DEDUPE_KEY must be at least 32 bytes')
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  dedupeKey = { secret, key }
  return key
}

/** A stable, opaque key for the delivery ledger. */
export async function deliveryKey(
  secret: string | undefined,
  project: string,
  id: string,
): Promise<string> {
  if (!secret) throw new Error('MAIL_DEDUPE_KEY not configured')
  const key = await hmacKey(secret)
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${project}:${id}`),
  )
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Definite pre-send failures. Email did not leave Cloudflare, so the claim can
 * be deleted and a later retry may send. Anything not listed here is treated as
 * ambiguous and keeps the claim.
 */
export function isDefinitePreSend(code: string): boolean {
  return (
    code.startsWith('E_HEADER_') ||
    code === 'E_VALIDATION_ERROR' ||
    code === 'E_FIELD_MISSING' ||
    code === 'E_TOO_MANY_RECIPIENTS' ||
    code === 'E_TOO_MANY_ATTACHMENTS' ||
    code === 'E_CONTENT_TOO_LARGE' ||
    code === 'E_RECIPIENT_NOT_ALLOWED' ||
    code === 'E_RECIPIENT_SUPPRESSED' ||
    code === 'E_SENDER_NOT_VERIFIED' ||
    code === 'E_SENDER_DOMAIN_NOT_AVAILABLE' ||
    code === 'E_ACCOUNT_SUSPENDED' ||
    code === 'E_RATE_LIMIT_EXCEEDED' ||
    code === 'E_DAILY_LIMIT_EXCEEDED'
  )
}

/** The state machine, independent of Durable Object or SQLite. */
export async function deliverWith(
  ledger: DeliveryLedger,
  key: string,
  send: () => Promise<SendResult>,
  now = Date.now(),
): Promise<DeliverResult> {
  await ledger.prune(now - DELIVERY_TTL_MS)

  const claim = await ledger.claim(key, now)
  if (claim.state === 'sent') {
    return { ok: true, id: claim.messageId ?? 'duplicate', duplicate: true }
  }
  if (claim.state === 'pending') {
    return { ok: false, reason: 'pending' }
  }

  let result: SendResult
  try {
    result = await send()
  } catch {
    // The send may have left Cloudflare; keep `sending` and report unknown.
    return { ok: false, reason: 'unknown', code: 'E_UNKNOWN' }
  }

  if (result.ok) {
    try {
      await ledger.markSent(key, result.messageId, now)
    } catch {
      // The message was sent. Do not turn a sent message into a retry; the row
      // stays `sending`, so a later request will get 409 rather than a second copy.
    }
    return { ok: true, id: result.messageId }
  }

  if (isDefinitePreSend(result.code)) {
    try {
      await ledger.release(key)
    } catch {
      return { ok: false, reason: 'unknown', code: result.code }
    }
    return { ok: false, reason: 'rejected', code: result.code }
  }

  return { ok: false, reason: 'unknown', code: result.code }
}

/** One Durable Object per project; its name is the project in the registry. */
export async function deliverToObject(
  env: MailEnv,
  project: string,
  key: string,
  email: OutboundEmail,
): Promise<DeliverResult> {
  const stub = env.MAIL_DELIVERY.get(env.MAIL_DELIVERY.idFromName(project)) as DurableObjectStub<MailDelivery>
  return stub.deliver(key, email)
}
