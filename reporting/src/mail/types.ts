// ── The mail relay's own types ───────────────────────────────────────────────
// This module is deliberately standalone. It knows how to authenticate one
// caller, validate one fully-formed email and hand it to Cloudflare Email
// Sending. It knows nothing about reports, R2, HTML rendering or PDF creation.
//
// There is no content in any of these types that is ever stored: a request is
// validated, sent, and dropped. The only surviving value is the dedupe key and
// Cloudflare's message id in the per-project ledger.

export interface MailAddress {
  email: string
  name: string
}

export interface MailAttachment {
  filename: string
  type: string
  /** Decoded file bytes, never the base64 text from the request. */
  content: Uint8Array
  disposition: 'attachment'
}

export interface OutboundEmail {
  from: MailAddress
  to: string[]
  cc?: string[]
  subject: string
  html?: string
  text?: string
  attachments?: MailAttachment[]
  replyTo?: MailAddress
}

export interface SigningKeyEntry {
  /** base64 or base64url HMAC key, at least 32 bytes. */
  key: string
  /** Stable project name. Also the Durable Object name, so one app = one DO. */
  project: string
  /** The only recipient domains this project may send to. Lower-case, exact. */
  domains: string[]
  /** Display name for the From header; the token cannot change it. */
  fromName: string
}

export type SigningRegistry = Record<string, SigningKeyEntry>

export interface TokenClaims {
  /** key id, looked up in MAIL_SIGNING_KEYS */
  k: string
  /** expiry, Unix seconds; 0 means the token never expires */
  e: number
  /** project */
  p: string
  /** allowed recipient domains */
  d: string[]
  /** From display name */
  n: string
}

export interface ValidatedMail {
  id: string
  to: string[]
  cc?: string[]
  subject: string
  html?: string
  text?: string
  attachments: MailAttachment[]
}

export type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; code: string }

export type Claim =
  | { state: 'claimed' }
  | { state: 'sent'; messageId?: string }
  | { state: 'pending' }

export interface DeliveryLedger {
  /** Prune rows older than `before` (a Unix ms timestamp). */
  prune(before: number): Promise<void>
  /** Atomically claim `key`; the caller may send only on `claimed`. */
  claim(key: string, at: number): Promise<Claim>
  markSent(key: string, messageId: string, at: number): Promise<void>
  /** A definite pre-send failure: allow a future attempt to try again. */
  release(key: string): Promise<void>
}

export type DeliverResult =
  | { ok: true; id: string; duplicate?: boolean }
  | { ok: false; reason: 'pending' | 'rejected' | 'unknown'; code?: string }

export interface MailEnv {
  EMAIL: SendEmail
  MAIL_DELIVERY: DurableObjectNamespace
  /** JSON object: { "<kid>": { key, project, domain, fromName } } */
  MAIL_SIGNING_KEYS?: string
  /** base64/base64url HMAC key, at least 32 bytes. */
  MAIL_DEDUPE_KEY?: string
  MAIL_FROM?: string
  MAIL_REPLY_TO?: string
  /** Comma-separated exact recipient domains. Defaults to dabur.com. */
  MAIL_ALLOWED_DOMAINS?: string
}
