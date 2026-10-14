// SIGNING IN THROUGH THE BROWSER (sacli login --browser) — OAuth 2.0 for native apps (RFC 8252) with PKCE (RFC 7636):
// sacli listens on 127.0.0.1 (a random port, one callback, five minutes), opens the platform's sign-in page, and the
// person allows it there; the page sends back a one-time code (60 s, single use, bound to sacli's PKCE challenge) and
// sacli's state, which sacli checks — a callback without it is ignored, so no other page can sign sacli in. The code is
// exchanged for the person's sign-in token, used once (to make a key of their own) and never saved.

import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

const page = (words: string) => `<!doctype html><meta charset="utf-8"><title>sacli</title><body style="font:15px/1.5 -apple-system,system-ui,sans-serif;background:#f3f1ec;color:#3a352f;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0"><p>${words}</p></body>`

/** The person's sign-in token, after they sign in and allow sacli in the browser. */
export async function browserSignIn(o: { httpBase: string; say: (s: string) => void; open?: boolean; timeoutMs?: number }): Promise<string> {
  const b64 = (b: Buffer) => b.toString('base64url')
  const verifier = b64(randomBytes(32))
  const challenge = b64(createHash('sha256').update(verifier).digest())
  const state = b64(randomBytes(24))
  const server = http.createServer()
  await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', () => res()) })
  const port = (server.address() as { port: number }).port
  const redirect = `http://127.0.0.1:${port}/callback`
  const url = `${o.httpBase}/mobile/auth?code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(redirect)}&state=${state}`
  o.say(`Sign in in your browser — if it does not open, go to:\n  ${url}`)
  if (o.open !== false) {
    const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]]
    try { spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref() } catch { /* the address is printed */ }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const code = await new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('no sign-in within 5 minutes — run sacli login --browser again')), o.timeoutMs ?? 5 * 60_000)
    server.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', redirect)
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return }
      const got = u.searchParams.get('code'), ok = !!got && u.searchParams.get('state') === state
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        .end(page(ok ? 'Signed in — back to the terminal. You can close this tab.' : 'This sign-in did not come from this sacli — nothing was done.'))
      if (ok) resolve(got!)   // anything else is ignored: sacli keeps waiting for its own
    })
  }).finally(() => { clearTimeout(timer); server.close() })
  const r = await fetch(`${o.httpBase}/api/auth/mobile/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, code_verifier: verifier }) })
  if (!r.ok) throw new Error('the sign-in could not be completed — run sacli login --browser again')
  const token = (await r.json() as { token?: string }).token
  if (!token) throw new Error('the sign-in could not be completed — run sacli login --browser again')
  return token
}

/** Who a sign-in token is for (its email), read from the token itself — for saying so, never for deciding anything. */
export function emailOf(token: string): string {
  try { return String(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).email ?? '') } catch { return '' }
}
