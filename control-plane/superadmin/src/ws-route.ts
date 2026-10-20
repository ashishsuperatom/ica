// WHERE A SOCKET GOES. /_ws/<project>: a PERSON (a signed-in token, not a service identity) connects to their own UserDO —
// their home in the project's organisation, every tab and device of theirs — which links them to the project (user-hub.ts). Engines (key),
// a key's socket (agent=1&person=…) to the UserDO of the person it acts for; service identities (svc:) talk to the project directly. The Worker and the tests route the same.
import { verifyJwt } from './auth/tokens.js'
import { orgOfProject, homeOf } from './person-home.js'

export async function routeSocket(request: Request, env: Env, projectId: string): Promise<Response> {
  const url = new URL(request.url)
  const token = url.searchParams.get('token')
  if (token && !url.searchParams.get('key') && url.searchParams.get('agent') !== '1') {
    const claims = await verifyJwt(token, (env as any).JWT_SECRET).catch(() => null)
    if (claims?.userId && claims.role !== 'service' && !String(claims.userId).startsWith('svc:')) {
      const fwd = new Request(request)
      fwd.headers.set('x-sa-project', projectId)
      fwd.headers.set('x-sa-claims', JSON.stringify({ userId: claims.userId, email: claims.email, role: claims.role }))
      // Their home in the project's organisation (person-home.ts): the same email in two organisations is two people.
      return homeOf(env, await orgOfProject(env, projectId), claims.userId).fetch(fwd)
    }
  }
  // A key's socket (sacli, an agent) names the person it acts for (?agent=1&person=<personId> — not secret; the key comes in
  // its hello): it goes to that person's UserDO, which checks the key there (docs/one-door-plan.md, step 4).
  const person = url.searchParams.get('person')
  if (url.searchParams.get('agent') === '1' && person && /^[0-9a-f]{32}$/.test(person)) {
    const fwd = new Request(request)
    fwd.headers.set('x-sa-project', projectId)
    fwd.headers.set('x-sa-agent', '1')
    fwd.headers.set('x-sa-claims', JSON.stringify({ userId: person }))
    return homeOf(env, await orgOfProject(env, projectId), person).fetch(fwd)
  }
  if (url.searchParams.get('agent') === '1') return new Response('a key\'s socket names the person it acts for — use sacli 0.1.28 or later, with a key made since keys name their person', { status: 401 })
  // The engine (its key in its hello) and service identities: the project.
  return (env as any).PROJECT.get((env as any).PROJECT.idFromName(`proj:${projectId}`)).fetch(request)
}
