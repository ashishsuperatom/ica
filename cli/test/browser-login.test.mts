// sacli login --browser (src/browser-login.ts): sacli listens on 127.0.0.1 only; a callback without sacli's own state is
// ignored (it keeps waiting — no other page can sign it in); with it, the code is exchanged together with sacli's PKCE
// verifier, which matches the challenge it sent; the sign-in token comes back, and the listener is closed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { browserSignIn } from '../src/browser-login.ts'

test('only its own callback signs sacli in: state checked, PKCE verifier matches, loopback only', async () => {
  let sentUrl = '', exchanged: any = null
  // The platform's exchange, played locally.
  const platform = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => { exchanged = JSON.parse(b); res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token: 'the-token' })) })
  })
  await new Promise<void>((r) => platform.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(platform.address() as any).port}`
  const signing = browserSignIn({ httpBase: base, open: false, say: (s) => { sentUrl = s.split('\n')[1].trim() }, timeoutMs: 10_000 })
  await new Promise((r) => setTimeout(r, 50))
  const u = new URL(sentUrl)
  const redirect = new URL(u.searchParams.get('redirect_uri')!)
  assert.equal(redirect.hostname, '127.0.0.1')
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
  // a forged callback (wrong state): refused, sacli keeps waiting
  const forged = await fetch(`${redirect.origin}/callback?code=evil&state=nope`)
  assert.equal(forged.status, 400)
  assert.equal(exchanged, null)
  // its own: signed in
  const own = await fetch(`${redirect.origin}/callback?code=good&state=${u.searchParams.get('state')}`)
  assert.equal(own.status, 200)
  assert.equal(await signing, 'the-token')
  assert.equal(exchanged.code, 'good')
  assert.equal(createHash('sha256').update(exchanged.code_verifier).digest('base64url'), u.searchParams.get('code_challenge'))
  await assert.rejects(fetch(`${redirect.origin}/callback`))   // the listener is closed
  platform.close()
})
