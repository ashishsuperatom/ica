// WHO IS ASKING — as the hub stamped it on the envelope, never as a payload says. One place, for every seam.
//   a person:  from.userId = <id>               → user:<id>
//   an agent:  from.type = 'agent', from.userId = agent:<keyId>
//   from.admin: the hub's word that this person administers the project (agents never do)

export class IdentityRefusal extends Error {}

export interface Who { id: string; admin: boolean }

export function whoIs(from: any): Who {
  const id = from?.userId
  if (!id || typeof id !== 'string') throw new IdentityRefusal('the hub did not say who is asking')
  const agent = from.type === 'agent' && id.startsWith('agent:')
  return { id: agent ? id : `user:${id}`, admin: !agent && from.admin === true }
}
