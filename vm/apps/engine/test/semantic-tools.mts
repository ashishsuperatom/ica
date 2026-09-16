// The semantic graph's tools as the composer runs them: a project with a semantic model, a datasource manager serving
// its data over HTTP, the workspace the engine prepares, and each tool run as the agent runs it.
//
//   pnpm exec tsx apps/engine/test/semantic-tools.mts

import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { prepareWorkspace } from '../ica/workspace.js'
import { instance, schema } from '../../../packages/semantic-graph/test/fixtures/branches.js'
import { ModelStore } from '../../../packages/semantic-graph/src/index.js'
import { MODEL, openSemanticGraph, semanticFile } from '../graph/semantic.js'
import { toSqlite } from '../../../packages/semantic-graph/test/fixtures/sqlite.js'

// The data, in SQLite, behind a manager that speaks the manager's HTTP.
const { query, sources } = toSqlite(schema, instance)
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/sources') return res.end(JSON.stringify({ sources: [{ id: 'DB', kind: 'sql', dialect: 'sqlite' }] }))
    try { const q = JSON.parse(body); res.end(JSON.stringify({ rows: await query(q.id, q.sql, q.params ?? {}) })) }
    catch (e: any) { res.end(JSON.stringify({ error: e.message })) }
  })
})
await new Promise<void>((r) => server.listen(0, r))
const managerUrl = `http://127.0.0.1:${(server.address() as any).port}`

const root = mkdtempSync(join(tmpdir(), 'sg-tools-'))
const projectDir = join(root, 'project')
mkdirSync(projectDir, { recursive: true })
// The model, built in the project's graph store through its operations — as the semantic-graph tool builds one.
new ModelStore(semanticFile(join(root, 'p', 'db'))).import(MODEL, { schema, sources }, { by: 'test' })
void DatabaseSync

const cwd = await prepareWorkspace({ root, projectId: 'p', managerUrl, projectDir, sessionId: 's1', tools: 'conversation' })
writeFileSync(join(cwd, '.session'), 's1'); writeFileSync(join(cwd, '.turn'), 'q1')
// Run without blocking: the manager above answers the tool from this same process.
const tool = async (name: string, ...args: string[]) => {
  try { return (await promisify(execFile)(join(cwd, name), args, { cwd, encoding: 'utf8' })).stdout }
  catch (e: any) { return `EXIT ${e.code}: ${e.stderr}${e.stdout}` }
}
// The engine opens the conversation's data session before the composer's turn.
;(await openSemanticGraph({ dbDir: join(root, 'p', 'db'), projectDir, managerUrl })).openSession(null, null, 's1')

const tools = execFileSync('ls', [cwd], { encoding: 'utf8' }).split('\n').filter(Boolean)
console.log('tools:', tools.join(' '))
assert.ok([...Object.keys({'resolve-terms':1,'overview':1,'find-measure':1,'describe':1,'group-paths':1,'find-dimension':1,'find-record':1,'check-question':1,'try-question':1,'run-program':1,'commit':1,'complete-question':1,'read-question':1,'source-records':1,'trace-answer':1}), 'escalate'].every((t) => tools.includes(t)))
assert.ok(!tools.includes('define') && !tools.includes('query'))
const terms = await tool('resolve-terms', 'How many hours did each branch work in September and October 2026?')
console.log('resolve-terms:', terms.replace(/\s+/g, ' ').slice(0, 200))
assert.match(terms, /september and october 2026\s+span\s+2026-09-01 to 2026-10-31\s+\{"span": \{"from": "2026-09-01", "through": "2026-10-31"\}\}/)
assert.equal(JSON.parse(await tool('resolve-terms', '--json', 'hours in October 2026')).terms[0].phrase, 'hours')
// The agent runs tools side by side, and the engine shares their memory: none is refused for a locked database.
const together = await Promise.all(Array.from({ length: 6 }, () => tool('describe', 'Sale')))
assert.ok(together.every((x) => !x.startsWith('EXIT')), together.find((x) => x.startsWith('EXIT')))
// Graph patterns by default; the same view as JSON on asking.
assert.match(await tool('describe', 'Sale'), /^\(:Sale\) fact/)
assert.equal(JSON.parse(await tool('describe', 'Sale', '--json')).name, 'Sale')
assert.match(await tool('list-dimensions', 'Sale'), /\(:Sale\) is sliced by \d+ dimensions/)
assert.match(await tool('list-dimensions', 'Sale', 'Budget'), /share \d+ dimensions/)
console.log('help:', (await tool('check-question', '--help')).slice(0, 80))
console.log('find-measure hours:', (await tool('find-measure', 'hours')).replace(/\s+/g, ' ').slice(0, 120))
console.log('find sydney:', (await tool('find-dimension', 'sydney')).replace(/\s+/g, ' ').slice(0, 160))
console.log('paths Sale Branch:', (await tool('group-paths', 'Sale', 'Branch')).replace(/\s+/g, ' '))
const refused = (await tool('check-question', JSON.stringify({ measures: ['Sale.hours'], by: [{ to: 'Branch' }] })))
console.log('check (ambiguous):', refused.replace(/\s+/g, ' ').slice(0, 220))
assert.match(refused, /"rule": "A2"/)
const tried = (await tool('try-question', JSON.stringify({ measures: ['Sale.hours'], by: [{ to: 'Branch', via: ['project', 'branch'] }], span: { from: '2026-09-01', through: '2026-10-31' } })))
console.log('try:', tried.replace(/\s+/g, ' ').slice(0, 300))
assert.match(tried, /"Branch": "b1",\s*"Branch_label": "Sydney",\s*"hours": 21/)
assert.ok(!existsSync(join(cwd, 'out', 'q1', 'built.json')), 'trying a question is not the answer')
writeFileSync(join(cwd, 'program.mjs'), `
export const meta = { name: 'hours by branch', description: 'Hours each branch worked over a span, and its share', params: { from: 'first day', through: 'last day' } }
export default async (ctx, p) => {
  const t = await ctx.ask({ measures: ['Sale.hours'], by: [{ to: 'Branch', via: ['project', 'branch'] }], span: { from: p.from, through: p.through } }, 'hours by branch')
  const total = ctx.transform('total hours', () => t.rows.reduce((s, r) => s + r.hours, 0))
  const byBranch = ctx.transform('share of each branch', () => ({ columns: [...t.columns, { name: 'share', role: 'measure', unit: 'ratio' }], rows: t.rows.map((r) => ({ ...r, share: r.hours / total })).sort((a, b) => b.hours - a.hours) }))
  return {
    data: { byBranch },
    views: [{ id: 'table', component: 'table', data: 'byBranch', encode: { columns: ['Branch', 'hours', 'share'] } }],
    narration: [{ text: '{top} worked the most, {share} of all hours.', cites: { top: { data: 'byBranch', row: 0, column: 'Branch' }, share: { data: 'byBranch', row: 0, column: 'share' } } }],
    nextSteps: [{ label: 'See the hours by person in the top branch' }],
  }
}`)
const ran = (await tool('run-program', 'program.mjs', JSON.stringify({ from: '2026-09-01', through: '2026-10-31' })))
console.log('run-program:', ran.replace(/\s+/g, ' ').slice(0, 400))
assert.match(ran, /Sydney worked the most/)
assert.ok(!existsSync(join(cwd, 'out', 'q1', 'built.json')), 'running a program is not the answer')
const committed = await tool('commit')
console.log('commit:', committed.trim())
const stepFile = JSON.parse(readFileSync(join(cwd, 'out', 'q1', 'built.json'), 'utf8'))
assert.equal(stepFile.kind, 'program')
const { surfaceAnswer } = await import('../graph/surface-answer.js')
const g2 = await openSemanticGraph({ dbDir: join(root, 'p', 'db'), projectDir, managerUrl })
const surfaced = surfaceAnswer(g2.store.getCall(stepFile.callId)!.output as any, [])
console.log('surfaced:', JSON.stringify(surfaced).slice(0, 300))
assert.match(surfaced.answer!, /Sydney worked the most/)
console.log('members:', (await tool('find-record', 'Branch', 'Sidney')).replace(/\s+/g, ' ').slice(0, 200))
console.log('trace:', (await tool('trace-answer')).split('\n').slice(0, 4).join(' | '))
server.close()
console.log('\nall tools ran as the composer runs them')
process.exit(0)
