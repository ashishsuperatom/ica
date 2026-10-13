// superatom.site/ — the public home page: one screen, says what Superatom is, leads to sign-in and install, and shows
// nothing of ours (no hosts, internal names or client names).
import { describe, expect, it } from 'vitest'
import { homePage } from '../site'

describe('the home page', () => {
  it('is one screen that leads to sign-in and install', async () => {
    const r = homePage()
    expect(r.headers.get('content-type')).toContain('text/html')
    const html = await r.text()
    expect(html).toContain('<title>Superatom</title>')
    expect(html).toContain('overflow:hidden')
    expect(html).toContain('https://admin.superatom.site')
    expect(html).toContain('href="/install"')
    for (const s of ['registry.', 'get.superatom', 'Clerk', 'R2', 'Durable', 'box-shadow']) expect(html).not.toContain(s)
  })
})
