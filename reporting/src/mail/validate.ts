// ── Validate one fully-formed email ──────────────────────────────────────────
// Everything the relay sends arrives in the request. There is no rendering here,
// no report lookup, and no reading of anything a caller did not send.
//
// The important rule is not "valid email"; it is "the exact emails this project
// is allowed to send": bare recipients at the registry's exact domains, a bounded
// number of allowlisted attachment types, and no header-injection characters.

import type { MailAttachment, SigningKeyEntry, ValidatedMail } from './types.js'

const MAX_RECIPIENTS = 50
const MAX_ATTACHMENTS = 32
const MAX_SUBJECT_CHARS = 998
const MAX_BODY_PART_BYTES = 512 * 1024
const MAX_ATTACHMENT_ENCODED_BYTES = 4 * 1024 * 1024
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024
const HEADER_ALLOWANCE_BYTES = 64 * 1024

const ATTACHMENT_TYPES: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'text/csv': ['.csv'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
}

export type ValidationResult =
  | { ok: true; mail: ValidatedMail }
  | { ok: false; status: 400 | 413 | 422; error: string }

const encoder = new TextEncoder()
const bytes = (value: string) => encoder.encode(value).byteLength

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*$/

function recipient(value: string, domains: string[]): string | null {
  if (value.length === 0 || value.length > 254) return null
  if (/[\s\u0000-\u001F\u007F]/.test(value)) return null
  const at = value.indexOf('@')
  if (at <= 0 || at !== value.lastIndexOf('@')) return null
  const local = value.slice(0, at)
  const host = value.slice(at + 1).toLowerCase()
  if (local.length > 64 || !LOCAL_PART.test(local)) return null
  if (!domains.includes(host)) return null
  return `${local.toLowerCase()}@${host}`
}

function attachment(
  value: unknown,
): { ok: true; attachment: MailAttachment; encodedBytes: number } | { ok: false; error: string; status: 400 | 413 | 422 } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'invalid_attachment', status: 400 }
  }
  const raw = value as Record<string, unknown>
  if (typeof raw.filename !== 'string' || typeof raw.type !== 'string' || typeof raw.content !== 'string') {
    return { ok: false, error: 'invalid_attachment', status: 400 }
  }

  const filename = raw.filename
  if (filename.length < 1 || filename.length > 200) return { ok: false, error: 'invalid_attachment', status: 400 }
  if (filename.startsWith('.') || filename === '.' || filename === '..') {
    return { ok: false, error: 'invalid_attachment', status: 400 }
  }
  if (/[\/\\\u0000-\u001F\u007F]/.test(filename)) return { ok: false, error: 'invalid_attachment', status: 400 }

  const type = raw.type.split(';', 1)[0].trim().toLowerCase()
  const allowedExtensions = ATTACHMENT_TYPES[type]
  if (!allowedExtensions) return { ok: false, error: 'attachment_type_not_allowed', status: 422 }

  const dot = filename.lastIndexOf('.')
  const extension = dot >= 0 ? filename.slice(dot).toLowerCase() : ''
  if (!allowedExtensions.includes(extension)) return { ok: false, error: 'attachment_type_mismatch', status: 422 }

  const content = raw.content
  if (content.length === 0 || content.length % 4 !== 0) return { ok: false, error: 'invalid_attachment', status: 400 }
  if (content.length > MAX_ATTACHMENT_ENCODED_BYTES) return { ok: false, error: 'too_large', status: 413 }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(content)) return { ok: false, error: 'invalid_attachment', status: 400 }

  let decoded: Uint8Array
  try {
    // Cloudflare attaches a string exactly as text. The caller sends base64 in
    // JSON, so decode it here and hand Cloudflare the actual file bytes.
    decoded = base64ToBytes(content)
  } catch {
    return { ok: false, error: 'invalid_attachment', status: 400 }
  }

  return {
    ok: true,
    attachment: { filename, type, content: decoded, disposition: 'attachment' },
    encodedBytes: content.length,
  }
}

/**
 * `entry` is the verified registry entry, never the request. Its domains and
 * display name are therefore authoritative.
 */
export function validateMail(body: unknown, entry: SigningKeyEntry): ValidationResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'bad_request' }
  }
  const raw = body as Record<string, unknown>

  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(raw.id)) {
    return { ok: false, status: 400, error: 'invalid_id' }
  }

  if (raw.tag !== undefined && (typeof raw.tag !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw.tag))) {
    return { ok: false, status: 400, error: 'invalid_tag' }
  }

  if (raw.from_name !== undefined) {
    if (typeof raw.from_name !== 'string' || raw.from_name !== entry.fromName) {
      return { ok: false, status: 400, error: 'from_name_mismatch' }
    }
  }

  if (!Array.isArray(raw.to) || raw.to.length === 0) {
    return { ok: false, status: 400, error: 'recipient_required' }
  }
  const ccRaw = raw.cc === undefined || raw.cc === null ? [] : raw.cc
  if (!Array.isArray(ccRaw)) return { ok: false, status: 400, error: 'invalid_recipient' }
  if (raw.to.length + ccRaw.length > MAX_RECIPIENTS) {
    return { ok: false, status: 422, error: 'too_many_recipients' }
  }

  const seen = new Set<string>()
  const collect = (values: unknown[], field: 'to' | 'cc'): { ok: true; list: string[] } | { ok: false } => {
    const list: string[] = []
    for (const value of values) {
      if (typeof value !== 'string') return { ok: false }
      const address = recipient(value, entry.domains)
      if (!address) return { ok: false }
      if (!seen.has(address)) {
        seen.add(address)
        list.push(address)
      }
    }
    return { ok: true, list }
  }

  const to = collect(raw.to, 'to')
  if (!to.ok) return { ok: false, status: 400, error: 'invalid_recipient' }
  if (to.list.length === 0) return { ok: false, status: 400, error: 'recipient_required' }

  const cc = collect(ccRaw, 'cc')
  if (!cc.ok) return { ok: false, status: 400, error: 'invalid_recipient' }

  if (typeof raw.subject !== 'string' || raw.subject.length === 0 || raw.subject.length > MAX_SUBJECT_CHARS) {
    return { ok: false, status: 400, error: 'invalid_subject' }
  }
  if (/[\u0000-\u001F\u007F]/.test(raw.subject)) {
    return { ok: false, status: 400, error: 'invalid_subject' }
  }
  const subject = raw.subject

  if (raw.html !== undefined && typeof raw.html !== 'string') {
    return { ok: false, status: 400, error: 'invalid_body' }
  }
  if (raw.text !== undefined && typeof raw.text !== 'string') {
    return { ok: false, status: 400, error: 'invalid_body' }
  }
  const html = typeof raw.html === 'string' ? raw.html : undefined
  const text = typeof raw.text === 'string' ? raw.text : undefined
  if (!html && !text) return { ok: false, status: 400, error: 'missing_body' }
  if (html && bytes(html) > MAX_BODY_PART_BYTES) return { ok: false, status: 413, error: 'too_large' }
  if (text && bytes(text) > MAX_BODY_PART_BYTES) return { ok: false, status: 413, error: 'too_large' }

  const attachmentsRaw = raw.attachments === undefined || raw.attachments === null ? [] : raw.attachments
  if (!Array.isArray(attachmentsRaw)) return { ok: false, status: 400, error: 'invalid_attachment' }
  if (attachmentsRaw.length > MAX_ATTACHMENTS) {
    return { ok: false, status: 422, error: 'too_many_attachments' }
  }

  const attachments: MailAttachment[] = []
  let encodedAttachmentBytes = 0
  for (const value of attachmentsRaw) {
    const result = attachment(value)
    if (!result.ok) return result
    attachments.push(result.attachment)
    encodedAttachmentBytes += result.encodedBytes
  }

  const total = encodedAttachmentBytes + bytes(html ?? '') + bytes(text ?? '') + HEADER_ALLOWANCE_BYTES
  if (total > MAX_MESSAGE_BYTES) return { ok: false, status: 413, error: 'too_large' }

  return {
    ok: true,
    mail: {
      id: raw.id,
      to: to.list,
      ...(cc.list.length ? { cc: cc.list } : {}),
      subject,
      ...(html !== undefined ? { html } : {}),
      ...(text !== undefined ? { text } : {}),
      attachments,
    },
  }
}
