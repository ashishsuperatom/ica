// ── POST /send ───────────────────────────────────────────────────────────────
// A narrow HTTP front door for one mail path: authenticate a project, validate
// the request against that project's registry entry, and hand it to the project's
// delivery object. There is no render, no R2 access, no report lookup and no
// content logging in this file or anything it imports.
//
// Responses contain only an id or a generic error token. They never echo the
// request, a recipient, a subject or a Cloudflare error message.

import type { DeliverResult, MailEnv, OutboundEmail } from './types.js'
import { verifyAuthorization } from './token.js'
import { validateMail } from './validate.js'
import { deliveryKey, deliverToObject } from './delivery.js'

const MAX_BODY_BYTES = 8 * 1024 * 1024
const DEFAULT_FROM = 'reports@superatom.ai'
const DEFAULT_DOMAIN = 'dabur.com'

export interface MailDeps {
  deliver: (env: MailEnv, project: string, key: string, email: OutboundEmail) => Promise<DeliverResult>
}

const defaultDeps: MailDeps = { deliver: deliverToObject }

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  })
}

const error = (status: number, code: string, headers?: Record<string, string>) =>
  json({ error: code }, status, headers)

function allowedDomains(env: MailEnv): string[] {
  const configured = (env.MAIL_ALLOWED_DOMAINS ?? DEFAULT_DOMAIN)
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  return configured.length ? configured : [DEFAULT_DOMAIN]
}

function mapResult(result: DeliverResult): Response {
  if (result.ok) {
    return json(result.duplicate ? { id: result.id, duplicate: true } : { id: result.id }, 200)
  }
  if (result.reason === 'pending' || result.reason === 'unknown') {
    // Ambiguous: a previous attempt may have been delivered. The caller must not
    // retry this id automatically.
    return error(409, 'unknown')
  }

  switch (result.code) {
    case 'E_RECIPIENT_SUPPRESSED':
      return error(422, 'recipient_suppressed')
    case 'E_CONTENT_TOO_LARGE':
      return error(413, 'too_large')
    case 'E_TOO_MANY_RECIPIENTS':
    case 'E_TOO_MANY_ATTACHMENTS':
      return error(422, 'too_large')
    case 'E_RATE_LIMIT_EXCEEDED':
    case 'E_DAILY_LIMIT_EXCEEDED':
      return error(429, 'rate_limited', { 'retry-after': '60' })
    case 'E_SENDER_NOT_VERIFIED':
    case 'E_SENDER_DOMAIN_NOT_AVAILABLE':
    case 'E_ACCOUNT_SUSPENDED':
      return error(503, 'sender_not_ready')
    default:
      return error(422, 'rejected')
  }
}

export async function handleMail(
  request: Request,
  env: MailEnv,
  deps: MailDeps = defaultDeps,
): Promise<Response> {
  try {
    if (request.method !== 'POST') return error(405, 'method_not_allowed', { allow: 'POST' })
    // The VM is a server-to-server caller: no Origin. A browser should never be
    // able to turn a stolen token into a cross-site POST.
    if (request.headers.get('origin')) return error(403, 'forbidden')

    const contentType = request.headers.get('content-type') ?? ''
    if (!/^application\/json\s*(?:;|$)/i.test(contentType)) return error(415, 'unsupported_media_type')

    const declaredLength = Number(request.headers.get('content-length') ?? '')
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return error(413, 'too_large')

    const auth = await verifyAuthorization(request.headers.get('authorization'), env.MAIL_SIGNING_KEYS)
    if (!auth.ok) {
      if (auth.reason === 'config') return error(500, 'misconfigured')
      return error(401, 'unauthorized', { 'www-authenticate': 'Bearer' })
    }
    const allowed = new Set(allowedDomains(env))
    if (!auth.entry.domains.every((domain) => allowed.has(domain))) return error(500, 'misconfigured')

    const raw = await request.text()
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return error(413, 'too_large')

    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return error(400, 'bad_request')
    }

    const validated = validateMail(body, auth.entry)
    if (!validated.ok) return error(validated.status, validated.error)

    if (!env.MAIL_DEDUPE_KEY) return error(500, 'misconfigured')
    const key = await deliveryKey(env.MAIL_DEDUPE_KEY, auth.entry.project, validated.mail.id)

    const from = (env.MAIL_FROM || DEFAULT_FROM).trim()
    const replyTo = env.MAIL_REPLY_TO?.trim()
    const email: OutboundEmail = {
      from: { email: from, name: auth.entry.fromName },
      to: validated.mail.to,
      ...(validated.mail.cc?.length ? { cc: validated.mail.cc } : {}),
      subject: validated.mail.subject,
      ...(validated.mail.html ? { html: validated.mail.html } : {}),
      ...(validated.mail.text ? { text: validated.mail.text } : {}),
      ...(validated.mail.attachments.length ? { attachments: validated.mail.attachments } : {}),
      ...(replyTo ? { replyTo: { email: replyTo, name: auth.entry.fromName } } : {}),
    }

    return mapResult(await deps.deliver(env, auth.entry.project, key, email))
  } catch {
    // Never log or return the caught value: it can contain a recipient or content.
    return error(500, 'internal')
  }
}
