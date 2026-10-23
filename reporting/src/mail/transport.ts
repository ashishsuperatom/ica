// ── The only place mail leaves this worker ───────────────────────────────────
// Cloudflare's binding is the transport. We map its error code into a small
// result and never log, echo or store the error message: a binding error can
// mention a recipient or content, and the relay must not retain either.

import type { MailEnv, OutboundEmail, SendResult } from './types.js'

export async function sendMail(env: MailEnv, email: OutboundEmail): Promise<SendResult> {
  try {
    const result = await env.EMAIL.send(email)
    return { ok: true, messageId: result.messageId }
  } catch (e: unknown) {
    const code =
      e && typeof e === 'object' && 'code' in e && typeof (e as { code?: unknown }).code === 'string'
        ? (e as { code: string }).code
        : 'E_UNKNOWN'
    return { ok: false, code }
  }
}
