// Who a person is, on the platform (decided 2026-10-13): their email, lower-cased, hashed — never the sign-in provider's
// id, which changes when the provider does (switching Clerk instances gave everyone a new one). A person belongs to an
// organisation, and the same email in two organisations is two people: their own Durable Object is named by both.
//
//   personId(email)            the id in every token, owner, scope and session: `user:<personId>` inside a project
//   personHome(org, personId)  their Durable Object (UserDO): `person:<org>:<personId>` — one per person per organisation

// A person's id from their email: one formula for the platform and the engine (a cell names its person by it).
export { personId } from '../../vm/packages/platform-types/src/index.js'

/** The name of a person's own Durable Object in an organisation. */
export function personHome(org: string | null, id: string): string {
  const o = org ?? 'none'   // a project made without an organisation (tests); every real project has one
  if (!/^[\w-]{1,80}$/.test(o) || !/^[\w.-]{1,80}$/.test(id)) throw new Error('a person\'s home is named by their organisation and their id')
  return `person:${o}:${id}`
}

/** The token generation that carries these ids; a token without it was minted before, with the provider's id. */
export const IDENTITY_VERSION = 2
