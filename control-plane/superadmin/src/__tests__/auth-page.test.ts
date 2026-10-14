// The platform's sign-in page for apps outside the browser (auth/app-signin.ts — /auth/app, and /mobile/auth for the iPhone
// app): what the browser receives must run. A regular expression written inside the page's template once lost its
// backslashes, the script did not parse, and the page stood at "Signing you in…" for ever.
import { describe, expect, it } from 'vitest'
import { appSignInPage } from '../auth/app-signin'

const page = async () => appSignInPage({} as Env).text()
const inline = (html: string) => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])

describe('the sign-in page for apps', () => {
  it('every script in it parses', async () => {
    const scripts = inline(await page())
    expect(scripts.length).toBeGreaterThan(0)
    for (const s of scripts) expect(() => new Function(s)).not.toThrow()
  })
  it('takes a command-line tool on this computer (127.0.0.1, /callback) — nothing else', async () => {
    const src = /const loopback = (\/.+\/)\.test\(redirectUri\);/.exec(await page())![1]
    const re = new Function(`return ${src}`)() as RegExp
    expect(re.test('http://127.0.0.1:54944/callback')).toBe(true)
    for (const bad of ['http://127.0.0.1:54944/other', 'https://evil.example/callback', 'http://127.0.0.1.evil.example:80/callback', 'http://localhost:5000/callback', 'http://127.0.0.1:54944/callback?x=1'])
      expect(re.test(bad), bad).toBe(false)
  })
})
