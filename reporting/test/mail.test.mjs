// The mail relay has four things worth testing without Cloudflare:
// token scope, request validation, the HTTP result mapping, and the exactly-once
// state machine. The Durable Object's SQL is a thin wrapper around the latter.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mintToken, parseRegistry, verifyAuthorization } from '../src/mail/token.ts'
import { validateMail } from '../src/mail/validate.ts'
import { sendMail } from '../src/mail/transport.ts'
import { DELIVERY_TTL_MS, deliverWith } from '../src/mail/delivery.ts'
import { handleMail } from '../src/mail/handler.ts'

const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64url')
const dedupeKey = Buffer.from(Array.from({ length: 32 }, (_, i) => 255 - i)).toString('base64url')
const entry = {
  key,
  project: 'slob-prod',
  domains: ['dabur.com', 'superatom.ai'],
  fromName: 'SLOB Action Planning',
}
const registry = { 'slob-prod': entry }
const secret = JSON.stringify(registry)
const token = await mintToken(registry, 'slob-prod', 3600)

const validBody = (overrides = {}) => ({
  id: 'slob-1',
  tag: 'test',
  from_name: entry.fromName,
  to: ['qa@dabur.com'],
  subject: 'Weekly action update',
  html: '<p>Hello</p>',
  text: 'Hello',
  attachments: [
    { filename: 'report.pdf', type: 'application/pdf', content: Buffer.from('%PDF-1.4').toString('base64') },
  ],
  ...overrides,
})

const handlerEnv = (overrides = {}) => ({
  EMAIL: { send: async () => ({ messageId: 'unused' }) },
  MAIL_DELIVERY: {},
  MAIL_SIGNING_KEYS: secret,
  MAIL_DEDUPE_KEY: dedupeKey,
  MAIL_FROM: 'reports@superatom.ai',
  MAIL_ALLOWED_DOMAINS: 'dabur.com,superatom.ai',
  ...overrides,
})

const mailRequest = (body, accessToken = token, headers = {}) =>
  new Request('https://mail.superatom.ai/send', {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

// ── Tokens ───────────────────────────────────────────────────────────────────

test('a minted token verifies and carries the registry scope', async () => {
  const result = await verifyAuthorization(`Bearer ${token}`, secret)
  assert.equal(result.ok, true)
  assert.equal(result.claims.p, 'slob-prod')
  assert.deepEqual(result.claims.d, ['dabur.com', 'superatom.ai'])
  assert.equal(result.claims.n, entry.fromName)
  assert.equal(result.entry.project, 'slob-prod')
})

test('a missing or malformed Authorization header is rejected', async () => {
  assert.equal((await verifyAuthorization(null, secret)).reason, 'missing')
  assert.equal((await verifyAuthorization('Basic abc', secret)).reason, 'invalid')
  assert.equal((await verifyAuthorization('Bearer not-a-token', secret)).reason, 'invalid')
})

test('a tampered payload fails the signature', async () => {
  const [version, payload, signature] = token.split('.')
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  claims.p = 'other-project'
  const tampered = `${version}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`
  assert.equal((await verifyAuthorization(`Bearer ${tampered}`, secret)).reason, 'invalid')
})

test('an expired token is rejected', async () => {
  const expired = await mintToken(registry, 'slob-prod', 1, 1000)
  assert.equal((await verifyAuthorization(`Bearer ${expired}`, secret, 10_000_000)).reason, 'expired')
})

test('a token minted with 0 ttl never expires', async () => {
  const forever = await mintToken(registry, 'slob-prod', 0, 1000)
  const result = await verifyAuthorization(`Bearer ${forever}`, secret, 4_102_444_800_000)
  assert.equal(result.ok, true)
  assert.equal(result.claims.e, 0)
})

test('a 10-year token is accepted for 10 years and then expires', async () => {
  const tenYears = 3650 * 86400
  const token = await mintToken(registry, 'slob-prod', tenYears, 1000)
  assert.equal((await verifyAuthorization(`Bearer ${token}`, secret, (1000 + 9 * 365 * 86400) * 1000)).ok, true)
  assert.equal(
    (await verifyAuthorization(`Bearer ${token}`, secret, (1000 + 11 * 365 * 86400) * 1000)).reason,
    'expired',
  )
})

test('an unknown kid is rejected', async () => {
  const other = await mintToken({ other: { ...entry, key } }, 'other', 3600)
  assert.equal((await verifyAuthorization(`Bearer ${other}`, secret)).reason, 'unknown_kid')
})

test('a correctly signed token cannot change project, domains or name', async () => {
  const wider = { 'slob-prod': { ...entry, project: 'other-project' } }
  const widerToken = await mintToken(wider, 'slob-prod', 3600)
  assert.equal((await verifyAuthorization(`Bearer ${widerToken}`, secret)).reason, 'invalid')

  const wrongDomain = { 'slob-prod': { ...entry, domains: ['gmail.com'] } }
  const wrongDomainToken = await mintToken(wrongDomain, 'slob-prod', 3600)
  assert.equal((await verifyAuthorization(`Bearer ${wrongDomainToken}`, secret)).reason, 'invalid')
})

test('a malformed registry is a configuration error, not an auth failure', async () => {
  assert.equal((await verifyAuthorization(`Bearer ${token}`, undefined)).reason, 'config')
  assert.equal((await verifyAuthorization(`Bearer ${token}`, '{"x":{}}')).reason, 'config')
  assert.deepEqual(parseRegistry(secret)['slob-prod'].domains, ['dabur.com', 'superatom.ai'])
})

// ── Validation ───────────────────────────────────────────────────────────────

test('a valid request becomes a fully formed outbound message', () => {
  const result = validateMail(validBody(), entry)
  assert.equal(result.ok, true)
  assert.equal(result.mail.id, 'slob-1')
  assert.deepEqual(result.mail.to, ['qa@dabur.com'])
  assert.equal(result.mail.attachments[0].disposition, 'attachment')
  assert.equal(result.mail.attachments[0].type, 'application/pdf')
})

test('only bare addresses on the registry domains are accepted', () => {
  const good = [
    'qa@dabur.com',
    'QA@DABUR.COM',
    'qa+reports@dabur.com',
    'first.last@dabur.com',
    'ashish@superatom.ai',
    'ASHISH@SUPERATOM.AI',
  ]
  for (const address of good) {
    assert.equal(validateMail(validBody({ to: [address] }), entry).ok, true, address)
  }

  const bad = [
    'qa@gmail.com',
    'qa@sub.dabur.com',
    'ashish@sub.superatom.ai',
    'ashish@superatom.ai.evil.com',
    'qa@dabur.com.evil.com',
    'qa@dabur.com.',
    'qa@dabur.com ',
    ' qa@dabur.com',
    '"qa"@dabur.com',
    'qa..x@dabur.com',
    '.qa@dabur.com',
    'qa@dabur.com\r\nBcc: other@dabur.com',
    'qa@dabur.com, other@dabur.com',
    'qa@dabur.com; other@dabur.com',
    'QA <qa@dabur.com>',
    'qa',
  ]
  for (const address of bad) {
    const result = validateMail(validBody({ to: [address] }), entry)
    assert.equal(result.ok, false, address)
    assert.equal(result.error, 'invalid_recipient', address)
  }
})

test('to and cc are deduplicated, keeping the first occurrence', () => {
  const result = validateMail(validBody({ to: ['A@dabur.com'], cc: ['a@dabur.com', 'b@dabur.com'] }), entry)
  assert.equal(result.ok, true)
  assert.deepEqual(result.mail.to, ['a@dabur.com'])
  assert.deepEqual(result.mail.cc, ['b@dabur.com'])
})

test('the recipient cap applies before deduplication', () => {
  const many = Array.from({ length: 51 }, (_, i) => `person${i}@dabur.com`)
  const result = validateMail(validBody({ to: many }), entry)
  assert.equal(result.ok, false)
  assert.equal(result.status, 422)
  assert.equal(result.error, 'too_many_recipients')
})

test('from_name must match the registry, and cannot be used as a header injection', () => {
  assert.equal(validateMail(validBody({ from_name: 'Someone Else' }), entry).error, 'from_name_mismatch')
  assert.equal(validateMail(validBody({ from_name: 'SLOB\r\nBcc: x@dabur.com' }), entry).error, 'from_name_mismatch')
  assert.equal(validateMail(validBody({ from_name: undefined }), entry).ok, true)
})

test('the subject is bounded and has no control characters', () => {
  assert.equal(validateMail(validBody({ subject: '' }), entry).error, 'invalid_subject')
  assert.equal(validateMail(validBody({ subject: 'x\r\nBcc: y@dabur.com' }), entry).error, 'invalid_subject')
  assert.equal(validateMail(validBody({ subject: 'x'.repeat(999) }), entry).error, 'invalid_subject')
})

test('at least one body part is required, and each is bounded', () => {
  assert.equal(validateMail(validBody({ html: undefined, text: undefined }), entry).error, 'missing_body')
  const tooLarge = validateMail(validBody({ html: `<p>${'x'.repeat(513 * 1024)}</p>` }), entry)
  assert.equal(tooLarge.ok, false)
  assert.equal(tooLarge.status, 413)
})

test('attachments are allowlisted by type and extension, with safe filenames', () => {
  const base = { filename: 'report.pdf', type: 'application/pdf', content: 'JVBERi0=' }
  assert.equal(validateMail(validBody({ attachments: [base] }), entry).ok, true)
  assert.equal(validateMail(validBody({ attachments: [{ ...base, type: 'text/html' }] }), entry).error, 'attachment_type_not_allowed')
  assert.equal(validateMail(validBody({ attachments: [{ ...base, type: 'image/svg+xml' }] }), entry).error, 'attachment_type_not_allowed')
  assert.equal(validateMail(validBody({ attachments: [{ ...base, filename: 'notes.txt', type: 'text/plain' }] }), entry).error, 'attachment_type_not_allowed')
  assert.equal(validateMail(validBody({ attachments: [{ ...base, filename: 'report.html' }] }), entry).error, 'attachment_type_mismatch')
  assert.equal(validateMail(validBody({ attachments: [{ ...base, filename: '../report.pdf' }] }), entry).error, 'invalid_attachment')
  assert.equal(validateMail(validBody({ attachments: [{ ...base, filename: '.report.pdf' }] }), entry).error, 'invalid_attachment')
  assert.equal(validateMail(validBody({ attachments: [{ ...base, content: 'not base64!' }] }), entry).error, 'invalid_attachment')
  assert.equal(validateMail(validBody({ attachments: [{ ...base, content: 'abc' }] }), entry).error, 'invalid_attachment')
})

test('the attachment count is bounded', () => {
  const one = { filename: 'x.csv', type: 'text/csv', content: 'YSxi' }
  const result = validateMail(validBody({ attachments: Array.from({ length: 33 }, () => one) }), entry)
  assert.equal(result.ok, false)
  assert.equal(result.status, 422)
  assert.equal(result.error, 'too_many_attachments')
})

test('ids and tags are deliberately narrow', () => {
  assert.equal(validateMail(validBody({ id: 'slob 1' }), entry).error, 'invalid_id')
  assert.equal(validateMail(validBody({ tag: 'Bad Tag' }), entry).error, 'invalid_tag')
})

// ── HTTP handler ─────────────────────────────────────────────────────────────

test('POST /send authenticates, builds the message and returns the provider id', async () => {
  let seen
  const deps = {
    deliver: async (_env, project, deliveryKey, email) => {
      seen = { project, deliveryKey, email }
      return { ok: true, id: 'message-1' }
    },
  }
  const response = await handleMail(mailRequest(validBody()), handlerEnv(), deps)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { id: 'message-1' })
  assert.equal(seen.project, 'slob-prod')
  assert.match(seen.deliveryKey, /^[a-f0-9]{64}$/)
  assert.equal(seen.email.from.email, 'reports@superatom.ai')
  assert.equal(seen.email.from.name, entry.fromName)
  assert.deepEqual(seen.email.to, ['qa@dabur.com'])
  assert.equal(seen.email.attachments[0].disposition, 'attachment')
})

test('the SLOB allowlist accepts both dabur.com and superatom.ai recipients', async () => {
  let seen
  const deps = {
    deliver: async (_env, _project, _key, email) => {
      seen = email
      return { ok: true, id: 'message-2' }
    },
  }
  const response = await handleMail(
    mailRequest(validBody({ to: ['ashish@superatom.ai'], cc: ['qa@dabur.com'] })),
    handlerEnv(),
    deps,
  )
  assert.equal(response.status, 200)
  assert.deepEqual(seen.to, ['ashish@superatom.ai'])
  assert.deepEqual(seen.cc, ['qa@dabur.com'])
})

test('the dedupe key is stable for the same project/id and changes with the id', async () => {
  const keys = []
  const deps = { deliver: async (_env, _project, key) => { keys.push(key); return { ok: true, id: 'm' } } }

  await handleMail(mailRequest(validBody()), handlerEnv(), deps)
  await handleMail(mailRequest(validBody()), handlerEnv(), deps)
  await handleMail(mailRequest(validBody({ id: 'slob-2' })), handlerEnv(), deps)

  assert.equal(keys[0], keys[1])
  assert.notEqual(keys[0], keys[2])
})

test('a duplicate delivery returns 200 with the original id', async () => {
  const deps = { deliver: async () => ({ ok: true, id: 'message-1', duplicate: true }) }
  const response = await handleMail(mailRequest(validBody()), handlerEnv(), deps)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { id: 'message-1', duplicate: true })
})

test('authentication and transport guards reject before reading content', async () => {
  let called = false
  const deps = { deliver: async () => { called = true; return { ok: true, id: 'm' } } }

  const missing = await handleMail(mailRequest(validBody(), null), handlerEnv(), deps)
  assert.equal(missing.status, 401)

  const origin = await handleMail(mailRequest(validBody(), token, { origin: 'https://evil.example' }), handlerEnv(), deps)
  assert.equal(origin.status, 403)

  const wrongType = await handleMail(
    mailRequest(validBody(), token, { 'content-type': 'text/plain' }),
    handlerEnv(),
    deps,
  )
  assert.equal(wrongType.status, 415)

  const badToken = await handleMail(mailRequest(validBody(), 'v1.nope.nope'), handlerEnv(), deps)
  assert.equal(badToken.status, 401)

  const get = await handleMail(
    new Request('https://mail.superatom.ai/send', { method: 'GET' }),
    handlerEnv(),
    deps,
  )
  assert.equal(get.status, 405)
  assert.equal(called, false)
})

test('bad JSON and a bad payload get generic 4xx responses', async () => {
  const deps = { deliver: async () => ({ ok: true, id: 'm' }) }

  const badJson = await handleMail(mailRequest('{not json', token), handlerEnv(), deps)
  assert.equal(badJson.status, 400)
  assert.deepEqual(await badJson.json(), { error: 'bad_request' })

  const badRecipient = await handleMail(
    mailRequest(validBody({ to: ['qa@gmail.com'] }), token),
    handlerEnv(),
    deps,
  )
  assert.equal(badRecipient.status, 400)
  assert.equal((await badRecipient.json()).error, 'invalid_recipient')
})

test('a token whose registry domains are not all in MAIL_ALLOWED_DOMAINS is a misconfiguration', async () => {
  const otherSecret = JSON.stringify({ 'slob-prod': { ...entry, domains: ['gmail.com'] } })
  const otherToken = await mintToken({ 'slob-prod': { ...entry, domains: ['gmail.com'] } }, 'slob-prod', 3600)
  const response = await handleMail(
    mailRequest(validBody(), otherToken),
    handlerEnv({ MAIL_SIGNING_KEYS: otherSecret }),
    { deliver: async () => ({ ok: true, id: 'm' }) },
  )
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), { error: 'misconfigured' })
})

test('missing secrets are configuration errors, not content errors', async () => {
  const deps = { deliver: async () => ({ ok: true, id: 'm' }) }
  const noSigning = await handleMail(mailRequest(validBody()), handlerEnv({ MAIL_SIGNING_KEYS: undefined }), deps)
  assert.equal(noSigning.status, 500)

  const noDedupe = await handleMail(mailRequest(validBody()), handlerEnv({ MAIL_DEDUPE_KEY: undefined }), deps)
  assert.equal(noDedupe.status, 500)
  assert.deepEqual(await noDedupe.json(), { error: 'misconfigured' })
})

test('ambiguous and definite provider failures map to safe app errors', async () => {
  const cases = [
    [{ ok: false, reason: 'pending' }, 409, 'unknown'],
    [{ ok: false, reason: 'unknown', code: 'E_DELIVERY_FAILED' }, 409, 'unknown'],
    [{ ok: false, reason: 'rejected', code: 'E_RECIPIENT_SUPPRESSED' }, 422, 'recipient_suppressed'],
    [{ ok: false, reason: 'rejected', code: 'E_CONTENT_TOO_LARGE' }, 413, 'too_large'],
    [{ ok: false, reason: 'rejected', code: 'E_DAILY_LIMIT_EXCEEDED' }, 429, 'rate_limited'],
    [{ ok: false, reason: 'rejected', code: 'E_SENDER_NOT_VERIFIED' }, 503, 'sender_not_ready'],
  ]

  for (const [result, status, error] of cases) {
    const response = await handleMail(mailRequest(validBody()), handlerEnv(), { deliver: async () => result })
    assert.equal(response.status, status)
    const body = await response.json()
    assert.equal(body.error, error)
    assert.equal(JSON.stringify(body).includes('dabur.com'), false)
    assert.equal(JSON.stringify(body).includes('Weekly action update'), false)
  }
})

test('an unexpected handler failure is generic and does not leak content', async () => {
  const response = await handleMail(mailRequest(validBody()), handlerEnv(), {
    deliver: async () => { throw new Error('secret detail qa@dabur.com') },
  })
  assert.equal(response.status, 500)
  const body = await response.json()
  assert.deepEqual(body, { error: 'internal' })
  assert.equal(JSON.stringify(body).includes('qa@dabur.com'), false)
})

// ── Exactly-once state machine ───────────────────────────────────────────────

class MemoryLedger {
  rows = new Map()
  async prune(before) {
    for (const [key, row] of this.rows) if (row.at < before) this.rows.delete(key)
  }
  async claim(key, at) {
    const row = this.rows.get(key)
    if (!row) {
      this.rows.set(key, { status: 'sending', at, messageId: undefined })
      return { state: 'claimed' }
    }
    if (row.status === 'sent') return { state: 'sent', messageId: row.messageId }
    return { state: 'pending' }
  }
  async markSent(key, messageId, at) {
    this.rows.set(key, { status: 'sent', at, messageId })
  }
  async release(key) {
    if (this.rows.get(key)?.status === 'sending') this.rows.delete(key)
  }
}

test('a key is sent once; retries return the same id without calling send again', async () => {
  const ledger = new MemoryLedger()
  let calls = 0
  const send = async () => { calls++; return { ok: true, messageId: 'message-1' } }

  assert.deepEqual(await deliverWith(ledger, 'k', send, 1000), { ok: true, id: 'message-1' })
  assert.deepEqual(await deliverWith(ledger, 'k', send, 2000), { ok: true, id: 'message-1', duplicate: true })
  assert.equal(calls, 1)
})

test('a definite pre-send failure releases the claim for a later retry', async () => {
  const ledger = new MemoryLedger()
  let calls = 0
  const send = async () => {
    calls++
    if (calls === 1) return { ok: false, code: 'E_RECIPIENT_SUPPRESSED' }
    return { ok: true, messageId: 'message-2' }
  }

  assert.deepEqual(await deliverWith(ledger, 'k', send, 1000), {
    ok: false, reason: 'rejected', code: 'E_RECIPIENT_SUPPRESSED',
  })
  assert.equal(ledger.rows.size, 0)
  assert.deepEqual(await deliverWith(ledger, 'k', send, 2000), { ok: true, id: 'message-2' })
  assert.equal(calls, 2)
})

test('an ambiguous failure keeps the claim and is never resent automatically', async () => {
  const ledger = new MemoryLedger()
  let calls = 0
  const send = async () => { calls++; return { ok: false, code: 'E_DELIVERY_FAILED' } }

  assert.deepEqual(await deliverWith(ledger, 'k', send, 1000), {
    ok: false, reason: 'unknown', code: 'E_DELIVERY_FAILED',
  })
  assert.equal(ledger.rows.get('k').status, 'sending')
  assert.deepEqual(await deliverWith(ledger, 'k', send, 2000), { ok: false, reason: 'pending' })
  assert.equal(calls, 1)
})

test('an exception during send leaves the claim pending', async () => {
  const ledger = new MemoryLedger()
  const send = async () => { throw new Error('timeout after bytes left') }

  assert.deepEqual(await deliverWith(ledger, 'k', send, 1000), {
    ok: false, reason: 'unknown', code: 'E_UNKNOWN',
  })
  assert.equal(ledger.rows.get('k').status, 'sending')
  assert.deepEqual(await deliverWith(ledger, 'k', send, 2000), { ok: false, reason: 'pending' })
})

test('sent records expire after the retention window and may be sent again', async () => {
  const ledger = new MemoryLedger()
  let calls = 0
  const send = async () => { calls++; return { ok: true, messageId: `message-${calls}` } }

  await deliverWith(ledger, 'k', send, 1000)
  assert.deepEqual(await deliverWith(ledger, 'k', send, 1000 + DELIVERY_TTL_MS + 1), {
    ok: true, id: 'message-2',
  })
  assert.equal(calls, 2)
})

// ── Transport ────────────────────────────────────────────────────────────────

test('transport passes the message through and preserves Cloudflare error codes', async () => {
  const sent = []
  const env = { EMAIL: { send: async (message) => { sent.push(message); return { messageId: 'm-1' } } } }
  const email = {
    from: { email: 'reports@superatom.ai', name: entry.fromName },
    to: ['qa@dabur.com'],
    subject: 'Hello',
    text: 'Hello',
  }

  assert.deepEqual(await sendMail(env, email), { ok: true, messageId: 'm-1' })
  assert.deepEqual(sent[0], email)

  const failure = {
    EMAIL: { send: async () => { throw Object.assign(new Error('provider detail'), { code: 'E_RECIPIENT_SUPPRESSED' }) } },
  }
  assert.deepEqual(await sendMail(failure, email), { ok: false, code: 'E_RECIPIENT_SUPPRESSED' })

  const unknown = { EMAIL: { send: async () => { throw new Error('provider detail') } } }
  assert.deepEqual(await sendMail(unknown, email), { ok: false, code: 'E_UNKNOWN' })
})
