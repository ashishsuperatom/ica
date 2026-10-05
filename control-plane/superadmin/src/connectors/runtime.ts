// RUNNING A CLOUD CONNECTOR (connectors/): its code, built and kept by hash, loaded into a Dynamic Worker whose only way
// out is the ConnectorGateway below — the hosts its manifest names, with the connection's credentials added there (the
// connector's code never holds them), every call recorded with the project. One isolate per connector version and
// connection, kept warm by the loader; a changed connection (new secrets) is a new isolate.

import { WorkerEntrypoint } from 'cloudflare:workers'
import CODE from '../../../../connectors/dist/code.json'
import CATALOG from '../../../../connectors/dist/catalog.json'
import { gatewayFetch, type CallRecord } from '../../../../connectors/src/gateway'
import type { Manifest } from '../../../../connectors/src/contract'
import type { Op, OpResult } from '../../../../connectors/src/sandbox'

export const CLOUD_CONNECTORS = CATALOG as unknown as (Manifest & { hash: string })[]
/** The sandbox's runtime date: what connector code and programs may rely on (nothing newer is needed). */
const SANDBOX_DATE = '2026-06-01'
const code = CODE as unknown as { sandbox: string; connectors: Record<string, { hash: string; server: string }> }
export const manifestOf = (id: string) => CLOUD_CONNECTORS.find((m) => m.id === id) ?? null

interface GatewayProps { projectId: string; connection: string; connector: string; settings: Record<string, unknown>; secrets: Record<string, string> }

/** The Dynamic Worker's only way out: hosts checked, credentials added, each call recorded on the project. */
export class ConnectorGateway extends WorkerEntrypoint<Env, GatewayProps> {
  async fetch(request: Request): Promise<Response> {
    const p = this.ctx.props
    const manifest = manifestOf(p.connector)
    if (!manifest) return new Response('this connector is not known to the platform', { status: 502 })
    const calls: CallRecord[] = []
    const g = gatewayFetch({ manifest, settings: p.settings, secrets: p.secrets, record: (c) => calls.push(c) })
    try { return await g(request) }
    catch (e: any) { return new Response(String(e?.message ?? e), { status: 403 }) }
    finally {
      const project = this.env.PROJECT.get(this.env.PROJECT.idFromName(`proj:${p.projectId}`))
      this.ctx.waitUntil(project.fetch('http://do/connector-calls', { method: 'POST', headers: { 'x-sa-project': p.projectId }, body: JSON.stringify({ connection: p.connection, calls }) }).then(() => {}, () => {}))
    }
  }
}

export interface RunConnection { id: string; connector: string; settings: Record<string, unknown>; secrets: Record<string, string>; version: string }

/** One operation of a connection's connector, in its sandbox. */
export async function runConnector(env: Env, exports: any, projectId: string, c: RunConnection, op: Op, req: unknown): Promise<OpResult> {
  const built = code.connectors[c.connector]
  if (!built) throw new Error(`${c.connector} is not a cloud connector`)
  const loader = (env as any).LOADER as WorkerLoader | undefined
  if (!loader) throw new Error('connectors cannot run on this platform yet (no Worker Loader binding)')
  if (!exports?.ConnectorGateway) throw new Error('the connector gateway is not exported by this Worker')
  const worker = loader.get(`${built.hash.slice(0, 16)}:${projectId}:${c.id}:${c.version}`, () => ({
    compatibilityDate: SANDBOX_DATE,
    mainModule: 'main.js',
    modules: { 'main.js': code.sandbox, 'connector.js': built.server },
    globalOutbound: exports.ConnectorGateway({ props: { projectId, connection: c.id, connector: c.connector, settings: c.settings, secrets: c.secrets } satisfies GatewayProps }),
    limits: { cpuMs: 30_000 },
  }))
  const res = await worker.getEntrypoint().fetch('https://connector.invalid/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, settings: c.settings, req }) })
  if (!res.ok) throw new Error(`the connector's sandbox answered ${res.status}`)
  return await res.json() as OpResult
}

// ── CODE MODE: a program an agent writes runs in a sandbox with no network at all; its only reach is `connectors`, a
//    proxy that runs each operation as the person (or agent) who asked — the same checks, the same record, an action
//    that changes something still waiting for a person. Many reads and steps in one program instead of many turns.

interface ProxyProps { projectId: string; sender: { type: string; userId?: string; email?: string; admin: boolean; scopes: string[] } }

/** What the program's `connectors` reaches: the project's connections, as the caller may use them. */
export class ConnectorProxy extends WorkerEntrypoint<Env, ProxyProps> {
  private async op(op: string, payload: Record<string, unknown>) {
    const p = this.ctx.props
    const r = await this.env.PROJECT.get(this.env.PROJECT.idFromName(`proj:${p.projectId}`)).fetch('http://do/connector-op', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sa-project': p.projectId }, body: JSON.stringify({ sender: { wsId: 'code-mode', ...p.sender }, op, payload }) })
    const out: any = await r.json()
    if (!r.ok) throw new Error(out.error ?? `the connector answered ${r.status}`)
    return out.result
  }
  async introspect(connection: string) { return this.op('introspect', { connection }) }
  async read(connection: string, req: { entity: string; filters?: Record<string, unknown>; cursor?: string | null; limit?: number }) { return this.op('read', { connection, ...req }) }
  async act(connection: string, action: string, input: Record<string, unknown>) { return this.op('act', { connection, action, input }) }
}

/** Wrap a program's body: `connectors` and `console` in scope, its value returned with what it logged. */
const programModule = (body: string) => `
export default {
  async fetch(request, env) {
    const logs = []
    const console = { log: (...a) => { if (logs.length < 200) logs.push(a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ').slice(0, 2000)) } }
    console.error = console.log; console.warn = console.log
    const connectors = { introspect: (c) => env.CONNECTORS.introspect(c), read: (c, r) => env.CONNECTORS.read(c, r), act: (c, a, i) => env.CONNECTORS.act(c, a, i ?? {}) }
    try {
      const result = await (async () => {
${body}
      })()
      return Response.json({ ok: true, result: result === undefined ? null : result, logs })
    } catch (e) {
      return Response.json({ ok: false, error: String(e && e.message || e), logs })
    }
  }
}`

/** Run a program in code mode: no network, the caller's connections through the proxy, at most 30 s of CPU. */
export async function runCode(env: Env, exports: any, projectId: string, sender: ProxyProps['sender'], body: string): Promise<{ ok: boolean; result?: unknown; error?: string; logs: string[] }> {
  const loader = (env as any).LOADER as WorkerLoader | undefined
  if (!loader) throw new Error('code mode cannot run on this platform yet (no Worker Loader binding)')
  if (!exports?.ConnectorProxy) throw new Error('the connector proxy is not exported by this Worker')
  const worker = loader.load({
    compatibilityDate: SANDBOX_DATE,
    mainModule: 'program.js',
    modules: { 'program.js': programModule(body) },
    env: { CONNECTORS: exports.ConnectorProxy({ props: { projectId, sender } satisfies ProxyProps }) },
    globalOutbound: null,
    limits: { cpuMs: 30_000 },
  })
  const res = await worker.getEntrypoint().fetch('https://program.invalid/', { method: 'POST' })
  return await res.json() as { ok: boolean; result?: unknown; error?: string; logs: string[] }
}
