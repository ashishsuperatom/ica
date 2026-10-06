// WHERE A SOCKET GOES. /_ws/<project>: a PERSON (a signed-in token, not a service identity) connects to their own UserDO —
// every tab and device of theirs, in every project — which links them to the project (user-hub.ts). Engines (key),
// agents (agent=1) and service identities (svc:) talk to the project directly. The Worker and the tests route the same.
import { verifyJwt } from './auth/tokens.js'

export async function routeSocket(request: Request, env: Env, projectId: string): Promise<Response> {
  const url = new URL(request.url)
  const token = url.searchParams.get('token')
  if (token && !url.searchParams.get('key') && url.searchParams.get('agent') !== '1') {
    const claims = await verifyJwt(token, (env as any).JWT_SECRET).catch(() => null)
    if (claims?.userId && claims.role !== 'service' && !String(claims.userId).startsWith('svc:')) {
      const fwd = new Request(request)
      fwd.headers.set('x-sa-project', projectId)
      fwd.headers.set('x-sa-claims', JSON.stringify({ userId: claims.userId, email: claims.email, role: claims.role }))
      return (env as any).USER.get((env as any).USER.idFromName(`user:${claims.userId}`)).fetch(fwd)
    }
  }
  return (env as any).PROJECT.get((env as any).PROJECT.idFromName(`proj:${projectId}`)).fetch(request)
}
