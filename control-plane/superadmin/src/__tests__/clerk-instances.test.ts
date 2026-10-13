// Sign-in from either Clerk instance (shared/clerk.ts): production sessions are checked with CLERK_SECRET_KEY, a local
// dev server's (development instance) with CLERK_DEV_SECRET_KEY — or CLERK_SECRET_KEY while that still holds the
// development secret, so the switch needs no exact timing — and a session from any other issuer is refused.
import { describe, expect, it } from 'vitest'
import { clerkSecretFor } from '../auth/tokens'
import { CLERK_DEVELOPMENT_KEY, CLERK_PRODUCTION_KEY, clerkHost } from '../../../shared/clerk'

const env = (o: Record<string, string>) => o as unknown as Env

describe('which instance a session came from', () => {
  it('the keys name their hosts', () => {
    expect(clerkHost(CLERK_PRODUCTION_KEY)).toBe('clerk.superatom.site')
    expect(clerkHost(CLERK_DEVELOPMENT_KEY)).toMatch(/\.clerk\.accounts\.dev$/)
  })
  it('production with the production secret, development with its own (or the main one before the switch)', () => {
    const both = env({ CLERK_SECRET_KEY: 'sk_live_x', CLERK_DEV_SECRET_KEY: 'sk_test_y' })
    expect(clerkSecretFor('https://clerk.superatom.site', both)).toBe('sk_live_x')
    expect(clerkSecretFor(`https://${clerkHost(CLERK_DEVELOPMENT_KEY)}`, both)).toBe('sk_test_y')
    expect(clerkSecretFor(`https://${clerkHost(CLERK_DEVELOPMENT_KEY)}`, env({ CLERK_SECRET_KEY: 'sk_test_old' }))).toBe('sk_test_old')
  })
  it('any other issuer is refused', () => {
    const both = env({ CLERK_SECRET_KEY: 'sk_live_x', CLERK_DEV_SECRET_KEY: 'sk_test_y' })
    expect(clerkSecretFor('https://evil.clerk.accounts.dev', both)).toBeNull()
    expect(clerkSecretFor(undefined, both)).toBeNull()
  })
})
