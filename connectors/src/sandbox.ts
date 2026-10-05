// What runs inside a connector's sandbox: one operation (test, introspect, read, act) of the connector's server module,
// with its settings and the gateway as fetch, returned as JSON with the connector's own log lines. The platform loads
// this as the Dynamic Worker's main module beside the connector's code (connector.js); tests call runOp directly.

import type { ConnectorContext, ConnectorServer } from './contract'

export type Op = 'test' | 'introspect' | 'read' | 'act'
export interface OpResult { ok: boolean; result?: unknown; error?: string; status?: number | null; logs: { message: string; detail?: Record<string, unknown> }[] }

export async function runOp(connector: ConnectorServer, op: Op, settings: Record<string, any>, req: any, fetcher: typeof fetch): Promise<OpResult> {
  const logs: OpResult['logs'] = []
  const ctx: ConnectorContext = { settings, fetch: fetcher, log: (message, detail) => { if (logs.length < 200) logs.push({ message: String(message).slice(0, 500), ...(detail ? { detail } : {}) }) } }
  try {
    const result = op === 'test' ? await connector.test(ctx) : op === 'introspect' ? await connector.introspect(ctx) : op === 'read' ? await connector.read(ctx, req) : op === 'act' ? await connector.act(ctx, req) : undefined
    if (result === undefined) throw new Error(`there is no operation "${op}"`)
    return { ok: true, result, logs }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e), status: typeof e?.status === 'number' ? e.status : null, logs }
  }
}
