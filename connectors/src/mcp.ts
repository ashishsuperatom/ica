// An MCP client over Streamable HTTP, small enough to run inside a connector's sandbox: initialize (keeping the session
// id the server gives), list and call tools, list and read resources. Replies come as JSON or as a server-sent event
// stream; both are read. Any connector that reaches an MCP server uses this one.

import type { ConnectorContext } from './contract'
import { ConnectorError } from './sdk'

export interface McpTool { name: string; title?: string; description?: string; inputSchema?: any; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; title?: string } }
export interface McpResource { uri: string; name: string; title?: string; description?: string; mimeType?: string }

export function mcpClient(ctx: ConnectorContext, url: string) {
  let session: string | null = null
  let ready: Promise<void> | null = null
  let id = 0
  const post = async (body: unknown) => {
    const r = await ctx.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}), 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify(body) })
    const sid = r.headers.get('mcp-session-id'); if (sid) session = sid
    if (r.status === 202 || r.status === 204) return null
    const text = await r.text()
    if (!r.ok) throw new ConnectorError(r.status === 401 ? 'the MCP server refused the credentials' : `the MCP server answered ${r.status}: ${text.slice(0, 200)}`, r.status)
    const ct = r.headers.get('content-type') ?? ''
    // A stream: the JSON-RPC reply is the data of an event (the last one that carries an id).
    const messages = ct.includes('text/event-stream')
      ? text.split(/\r?\n\r?\n/).map((ev) => ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')).filter(Boolean).map((d) => { try { return JSON.parse(d) } catch { return null } }).filter(Boolean)
      : [JSON.parse(text)]
    return messages
  }
  const rpc = async (method: string, params?: unknown) => {
    if (method !== 'initialize') await init()
    const reqId = ++id
    const msgs = await post({ jsonrpc: '2.0', id: reqId, method, ...(params !== undefined ? { params } : {}) })
    const reply = (msgs ?? []).find((m: any) => m && m.id === reqId) ?? (msgs ?? []).at(-1)
    if (!reply) throw new ConnectorError(`the MCP server gave no reply to ${method}`)
    if (reply.error) throw new ConnectorError(`the MCP server refused ${method}: ${reply.error.message ?? JSON.stringify(reply.error)}`)
    return reply.result
  }
  const init = () => (ready ??= (async () => {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'superatom', version: '1' } })
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  })().catch((e) => { ready = null; throw e }))

  /** Every page of a list method (MCP lists page with nextCursor). */
  const all = async <T>(method: string, key: string): Promise<T[]> => {
    const out: T[] = []; let cursor: string | undefined
    for (let n = 0; n < 50; n++) { const r = await rpc(method, cursor ? { cursor } : {}); out.push(...(r?.[key] ?? [])); cursor = r?.nextCursor; if (!cursor) break }
    return out
  }
  return {
    init,
    tools: () => all<McpTool>('tools/list', 'tools'),
    resources: () => all<McpResource>('resources/list', 'resources'),
    call: (name: string, args: Record<string, unknown>) => rpc('tools/call', { name, arguments: args }),
    read: (uri: string) => rpc('resources/read', { uri }),
  }
}

/** What a tool's result says, as rows when it is structured (structuredContent, or JSON text), else as text. */
export function rowsOfToolResult(r: any): { rows: Record<string, unknown>[]; text: string } {
  const text = (r?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
  const structured = r?.structuredContent ?? (() => { try { return JSON.parse(text) } catch { return null } })()
  const arr = Array.isArray(structured) ? structured : Array.isArray(structured?.items) ? structured.items : Array.isArray(structured?.results) ? structured.results : structured && typeof structured === 'object' ? [structured] : []
  return { rows: arr.filter((x: unknown) => x && typeof x === 'object'), text }
}
