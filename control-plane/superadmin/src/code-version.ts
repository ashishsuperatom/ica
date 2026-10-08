// A DURABLE OBJECT ON THE CODE THAT IS DEPLOYED. After a deploy, Cloudflare keeps an object instance that is busy — a
// connected engine, an open browser tab — on the code it started with, for as long as anything holds it. It cannot know a
// newer version exists. The worker always runs the newest code and every new connection and request passes through it,
// so the worker stamps what it forwards with when its code was deployed (stampedEnv), and an object that sees a stamp
// newer than its own restarts (restartIfOlder): its clients drop and reconnect, and land on the new code. Newer, never
// just different: while a deploy rolls out, old and new worker instances overlap for seconds, and an object restarting on
// every difference would bounce between them.

export const CODE_STAMP = 'x-sa-code'

/** When the code this runs was deployed (ms), from the version metadata binding; null where there is none (tests). */
export function deployedAt(env: unknown): number | null {
  const t = (env as any)?.CF_VERSION_METADATA?.timestamp
  const ms = t ? Date.parse(String(t)) : NaN
  return Number.isFinite(ms) ? ms : null
}

/** The worker's env with each named Durable Object namespace stamping every request its stubs send. */
export function stampedEnv<E extends object>(env: E, names: string[]): E {
  const at = deployedAt(env)
  if (at === null) return env
  const stamp = (ns: any) => new Proxy(ns, {
    get(t, p) {
      if (p !== 'get') { const v = t[p]; return typeof v === 'function' ? v.bind(t) : v }
      return (...args: any[]) => {
        const stub = t.get(...args)
        return new Proxy(stub, {
          get(s, q) {
            if (q === 'fetch') return (input: RequestInfo | URL, init?: RequestInit) => { const req = new Request(input as any, init); req.headers.set(CODE_STAMP, String(at)); return s.fetch(req) }
            const v = s[q]; return typeof v === 'function' ? v.bind(s) : v
          },
        })
      }
    },
  })
  const out: any = { ...env }
  for (const n of names) if ((env as any)[n]) out[n] = stamp((env as any)[n])
  return out
}

/** In an object's fetch: a request from newer code than this instance runs restarts it (the request fails; its client
 *  retries, onto the new code). */
export function restartIfOlder(ctx: DurableObjectState, env: unknown, request: Request): void {
  const caller = Number(request.headers.get(CODE_STAMP)), mine = deployedAt(env)
  if (!caller || mine === null || caller <= mine) return
  console.warn(`[code] this instance runs code deployed ${new Date(mine).toISOString()}; a request came from code deployed ${new Date(caller).toISOString()} — restarting onto it`)
  ctx.abort('the platform was deployed: restarting on its new code')
}
