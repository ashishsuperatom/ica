// WHO IS ASKING — as the hub stamped it on the envelope, never as a payload says. One place, for every seam.
//   a person:  from.userId = <id>               → user:<id>
//   an agent:  from.type = 'agent', from.userId = agent:<keyId>
//   from.admin: the hub's word that this person administers the project (agents never do)
//   from.email: the person's address (their data access policies can name it)
//   from.scopes: the scopes they see with — user:<id> and group:<name> for each of their groups

export class IdentityRefusal extends Error {}

export interface Who { id: string; admin: boolean; email?: string; /** What they see with: their own scope and their groups' (the hub's stamp). */ scopes: string[] }

/** Who a turn is for, as usage is attributed: their email when known (`email:…`, what budgets name), else their id. */
export function personOf(from: any): string | undefined {
  try { const w = whoIs(from); return w.email ? `email:${w.email.toLowerCase()}` : w.id } catch { return undefined }
}

export function whoIs(from: any): Who {
  const id = from?.userId
  if (!id || typeof id !== 'string') throw new IdentityRefusal('the hub did not say who is asking')
  const agent = from.type === 'agent' && id.startsWith('agent:')
  const scopes = Array.isArray(from.scopes) ? from.scopes.filter((x: unknown) => typeof x === 'string' && /^(user|group):\S+$/.test(x)) : []
  return { id: agent ? id : `user:${id}`, admin: !agent && from.admin === true, ...(!agent && typeof from.email === 'string' ? { email: from.email } : {}), scopes: agent || scopes.length ? scopes : [`user:${id}`] }
}
