// Sign-in accounts are made by us, never by the person: an organisation's (or a project's) admin adds someone, and the
// platform makes their account on the production Clerk instance then, with their address already verified. Nobody can
// sign up on their own — the instance's sign-up mode is Restricted (docs/platform-architecture.md, 2026-10-13). Clerk
// is only how someone proves who they are; organisations, roles and access are ours, kept by email.
//
// They sign in with that address: an email code, or Google / Microsoft / GitHub with the same address (Clerk links it).

export type SignInAccount = 'made' | 'existed' | { problem: string }

/** The person's sign-in account exists after this — made when it did not. Never throws: a problem is returned, to log. */
export async function ensureSignInAccount(email: string, secret: string | undefined, fetchImpl: typeof fetch = fetch): Promise<SignInAccount> {
  const addr = email.trim().toLowerCase()
  if (!secret) return { problem: 'the sign-in secret (CLERK_SECRET_KEY) is not set' }
  // The development instance is only for local dev servers: accounts are made on production only.
  if (!secret.startsWith('sk_live_')) return 'existed'
  const auth = { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' }
  try {
    const found = await fetchImpl(`https://api.clerk.com/v1/users?email_address=${encodeURIComponent(addr)}&limit=1`, { headers: auth })
    if (!found.ok) return { problem: `looking the account up failed (${found.status})` }
    if (((await found.json()) as unknown[]).length) return 'existed'
    const made = await fetchImpl('https://api.clerk.com/v1/users', { method: 'POST', headers: auth,
      body: JSON.stringify({ email_address: [addr], skip_password_requirement: true }) })
    if (made.ok) return 'made'
    const why = await made.text().catch(() => '')
    // Made by someone else in the meantime: it exists, which is all that was asked.
    if (made.status === 422 && /taken|exists/i.test(why)) return 'existed'
    return { problem: `making the account failed (${made.status}) ${why.slice(0, 200)}` }
  } catch (e) { return { problem: `the sign-in service could not be reached (${(e as Error).message})` } }
}
