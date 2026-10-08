// An object instance on older code restarts when a request from newer code reaches it — never for older or equal code
// (a rollout overlaps old and new worker instances for seconds), never where no version is known (tests, local).

import { describe, expect, it } from 'vitest'
import { stampedEnv, restartIfOlder, CODE_STAMP } from '../code-version'

const at = (iso: string) => ({ CF_VERSION_METADATA: { id: 'v', timestamp: iso } })
const ctx = () => { const c = { aborted: '' as string, abort(r: string) { c.aborted = r } }; return c }
const req = (stamp?: number) => new Request('http://do/x', { headers: stamp ? { [CODE_STAMP]: String(stamp) } : {} })

describe('a Durable Object on the deployed code', () => {
  it('restarts for a request from newer code only', () => {
    const now = Date.parse('2026-10-08T10:00:00Z')
    for (const [stamp, restarts] of [[now + 60_000, true], [now, false], [now - 60_000, false], [undefined, false]] as const) {
      const c = ctx(); restartIfOlder(c as any, at('2026-10-08T10:00:00Z'), req(stamp)); expect(!!c.aborted).toBe(restarts)
    }
    const c = ctx(); restartIfOlder(c as any, {}, req(now)); expect(c.aborted).toBe('')   // no version known: nothing
  })

  it('the worker\'s stubs stamp every request with when its code was deployed; their other methods pass through', async () => {
    let seen: string | null = null
    const ns = { idFromName: (n: string) => n, get: (_id: string) => ({ fetch: async (r: Request) => { seen = r.headers.get(CODE_STAMP); return new Response('ok') }, rpc: () => 'rpc' }) }
    const env = stampedEnv({ PROJECT: ns, ...at('2026-10-08T10:00:00Z') } as any, ['PROJECT'])
    const stub = env.PROJECT.get(env.PROJECT.idFromName('proj:x'))
    expect(await (await stub.fetch('http://do/y')).text()).toBe('ok')
    expect(seen).toBe(String(Date.parse('2026-10-08T10:00:00Z')))
    expect(stub.rpc()).toBe('rpc')
    expect(stampedEnv({ PROJECT: ns } as any, ['PROJECT']).PROJECT).toBe(ns)   // no version: unchanged
  })
})
