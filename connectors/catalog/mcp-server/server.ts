// Any MCP server: its resources are things to read; its tools are actions — a tool the server marks read-only is a
// lookup, one it marks destructive cannot be undone and needs a person's confirmation, the rest change something.
// A read-only tool is also readable as an entity (tool:<name>), its result as rows.
import { defineConnector, ConnectorError } from '../../src/sdk'
import { mcpClient, rowsOfToolResult, type McpTool } from '../../src/mcp'
import type { Action, ConnectorContext, Field } from '../../src/contract'

const client = (ctx: ConnectorContext) => mcpClient(ctx, String(ctx.settings.url))
const typeOf = (s: any): Field['type'] => s?.type === 'integer' ? 'integer' : s?.type === 'number' ? 'number' : s?.type === 'boolean' ? 'boolean' : s?.type === 'object' || s?.type === 'array' ? 'json' : 'string'
const actionOf = (t: McpTool): Action => {
  const props = t.inputSchema?.properties ?? {}, required: string[] = t.inputSchema?.required ?? []
  const effect = t.annotations?.readOnlyHint ? 'read' : t.annotations?.destructiveHint ? 'irreversible' : 'write'
  return { name: t.name, label: t.title ?? t.annotations?.title ?? t.name, description: t.description ?? '', effect, confirm: effect !== 'read',
    input: Object.entries(props).map(([name, s]: [string, any]) => ({ name, type: typeOf(s), description: s?.description, required: required.includes(name) })) }
}

export default defineConnector({
  async test(ctx) {
    const tools = await client(ctx).tools()
    return { ok: true, message: `${tools.length} tool${tools.length === 1 ? '' : 's'}` }
  },
  async entities(ctx) {
    const c = client(ctx)
    const resources = await c.resources().catch(() => [])
    const tools = await c.tools()
    return [
      ...resources.map((r) => ({ name: r.uri, label: r.title ?? r.name, description: r.description, fields: [{ name: 'uri', type: 'string' as const }, { name: 'text', type: 'string' as const }, { name: 'mimeType', type: 'string' as const }] })),
      ...tools.filter((t) => t.annotations?.readOnlyHint && !(t.inputSchema?.required ?? []).length).map((t) => ({ name: `tool:${t.name}`, label: t.title ?? t.name, description: t.description, fields: [] as Field[] })),
    ]
  },
  async actions(ctx) { return (await client(ctx).tools()).map(actionOf) },
  read: {
    async '*'(ctx, req) {
      const c = client(ctx)
      if (req.entity.startsWith('tool:')) {
        const name = req.entity.slice(5)
        const tool = (await c.tools()).find((t) => t.name === name)
        if (!tool?.annotations?.readOnlyHint) throw new ConnectorError(`${name} is not a read-only tool; run it as an action`)
        const r = rowsOfToolResult(await c.call(name, (req.filters ?? {}) as Record<string, unknown>))
        return { rows: r.rows.length ? r.rows : [{ text: r.text }], total: r.rows.length || 1 }
      }
      const r = await c.read(req.entity)
      const rows = (r?.contents ?? []).map((x: any) => ({ uri: x.uri, mimeType: x.mimeType ?? null, text: x.text ?? (x.blob ? `(${x.blob.length} bytes of base64)` : null) }))
      return { rows, total: rows.length }
    },
  },
  act: {
    async '*'(ctx, input, action) {
      const r = await client(ctx).call(action, input)
      const out = rowsOfToolResult(r)
      return { ok: !r?.isError, result: out.rows.length ? out.rows : out.text, message: r?.isError ? out.text : undefined }
    },
  },
})
