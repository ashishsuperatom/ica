// Sign-in accounts are made by the platform when an admin adds someone (auth/clerk-users.ts), against a fake Clerk:
// made once with the address verified and no password, never twice, only on the production instance, and a failure
// is returned to log — never thrown, never hiding that the person was added.
import { describe, expect, it } from 'vitest'
import { ensureSignInAccount } from '../auth/clerk-users'

function clerk(existing: string[] = [], failMake = 0) {
  const users = new Set(existing), calls: { method: string; url: string; body?: any; auth?: string }[] = []
  const f = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: (init?.headers as any)?.Authorization })
    if (method === 'GET') return Response.json(users.has(new URL(url).searchParams.get('email_address')!) ? [{ id: 'u' }] : [])
    if (failMake) return new Response('{"errors":[{"message":"boom"}]}', { status: failMake })
    const b = JSON.parse(String(init!.body)); users.add(b.email_address[0]); return Response.json({ id: 'new' })
  }) as unknown as typeof fetch
  return { f, calls, users }
}

describe('a sign-in account for someone an admin adds', () => {
  it('is made once, with the address given and no password; a second time it already exists', async () => {
    const c = clerk()
    expect(await ensureSignInAccount('Mia@Acme.io ', 'sk_live_x', c.f)).toBe('made')
    expect(c.calls[1]).toMatchObject({ method: 'POST', url: 'https://api.clerk.com/v1/users', body: { email_address: ['mia@acme.io'], skip_password_requirement: true }, auth: 'Bearer sk_live_x' })
    expect(await ensureSignInAccount('mia@acme.io', 'sk_live_x', c.f)).toBe('existed')
    expect(c.calls.filter((x) => x.method === 'POST')).toHaveLength(1)
  })
  it('is made only on the production instance; without a secret it says so', async () => {
    const c = clerk()
    expect(await ensureSignInAccount('a@b.io', 'sk_test_x', c.f)).toBe('existed')
    expect(c.calls).toHaveLength(0)
    expect(await ensureSignInAccount('a@b.io', undefined, c.f)).toEqual({ problem: expect.stringMatching(/CLERK_SECRET_KEY/) })
  })
  it('a failure is returned to log, not thrown; one made meanwhile counts as there', async () => {
    expect(await ensureSignInAccount('a@b.io', 'sk_live_x', clerk([], 500).f)).toEqual({ problem: expect.stringMatching(/failed \(500\)/) })
    const taken = (async (_u: string, i?: RequestInit) => (i?.method === 'POST' ? new Response('{"errors":[{"code":"form_identifier_exists","message":"That email address is taken."}]}', { status: 422 }) : Response.json([]))) as unknown as typeof fetch
    expect(await ensureSignInAccount('a@b.io', 'sk_live_x', taken)).toBe('existed')
    const down = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await ensureSignInAccount('a@b.io', 'sk_live_x', down)).toEqual({ problem: expect.stringMatching(/offline/) })
  })
})
