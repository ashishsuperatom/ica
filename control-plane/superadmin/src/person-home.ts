// A person's own Durable Object — their home in an organisation (shared/identity.ts): `person:<org>:<personId>`. Every
// route to it goes through here, so the organisation is always part of it: a project's organisation is asked of the
// project once (it never changes) and remembered in this isolate.
import { personHome } from '../../shared/identity.js'

const orgs = new Map<string, string>()

/** The organisation a project belongs to (null: made without one — tests; the project itself decides who may in). */
export async function orgOfProject(env: Env, projectId: string): Promise<string | null> {
  const known = orgs.get(projectId)
  if (known) return known
  const r: any = await env.PROJECT.get(env.PROJECT.idFromName(`proj:${projectId}`)).fetch('https://do/org-id').then((x) => x.json()).catch(() => null)
  if (typeof r?.org === 'string' && r.org) { orgs.set(projectId, r.org); return r.org }
  return null
}

/** A person's own Durable Object in an organisation. */
export const homeOf = (env: Env, org: string | null, personId: string) => (env as any).USER.get((env as any).USER.idFromName(personHome(org, personId)))
