// Who a person is, on the platform (decided 2026-10-13): their email, lower-cased, hashed — never the sign-in provider's
// id, which changes when the provider does (switching Clerk instances gave everyone a new one). A person belongs to an
// organisation, and the same email in two organisations is two people: their own Durable Object is named by both.
//
//   personId(email)            the id in every token, owner, scope and session: `user:<personId>` inside a project
//   personHome(org, personId)  their Durable Object (UserDO): `person:<org>:<personId>` — one per person per organisation

/** A person's id from their email: the first 32 hex of SHA-256 over the lower-cased address. */
export async function personId(email: string): Promise<string> {
  const e = email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+$/.test(e)) throw new Error('a person is known by their email')
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(e)))
  return [...d].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The name of a person's own Durable Object in an organisation. */
export function personHome(org: string | null, id: string): string {
  const o = org ?? 'none'   // a project made without an organisation (tests); every real project has one
  if (!/^[\w-]{1,80}$/.test(o) || !/^[\w.-]{1,80}$/.test(id)) throw new Error('a person\'s home is named by their organisation and their id')
  return `person:${o}:${id}`
}

/** The token generation that carries these ids; a token without it was minted before, with the provider's id. */
export const IDENTITY_VERSION = 2
