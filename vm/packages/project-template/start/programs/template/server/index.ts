// The program's Node side: its functions. Each gets the whole STATE (frozen) and a context whose set() changes only this
// program's slice; data comes only through ctx.services.query (the reader's data access is applied for you).
import { exampleQuery } from './query.js'

type Row = { key: string; value: number }
type Ctx = { set(patch: Record<string, unknown>): void; params: Record<string, unknown>; services: { query(source: string, sql: string, params?: Record<string, unknown>): Promise<any[]> } }

export async function run(state: { example: { filter: string | null } }, ctx: Ctx) {
  const { sql, params } = exampleQuery(state.example.filter)
  const rows: Row[] = (await ctx.services.query('SOURCE', sql, params)).map((r) => ({ key: String(r.key), value: Number(r.value) }))
  const total = rows.reduce((a, r) => a + r.value, 0)
  ctx.set({ rows: rows.slice(0, 100), total })
  const table = { title: 'Example', columns: [{ key: 'key', label: 'Key' }, { key: 'value', label: 'Value' }], rows: rows.slice(0, 100) }
  return { answer: { markdown: `${rows.length} keys${state.example.filter ? ` for ${state.example.filter}` : ''}; ${total} in total.\n:::table example.json`, blocks: { 'example.json': table } } }
}
