// The verbs on the answer on screen, driven as the engine drives them but without a hub: a program answered in a
// conversation, then view:, run:, check:, program:, explain: and edit: on it — and the ids its tables carry.
//
//   pnpm exec tsx apps/engine/test/semantic-verbs.mts

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { prepareWorkspace } from '../ica/workspace.js'
import { instance, schema } from '../../../packages/semantic-graph/test/fixtures/branches.js'
import { toSqlite } from '../../../packages/semantic-graph/test/fixtures/sqlite.js'
import { openSemanticGraph } from '../graph/semantic.js'
import { createSemanticTurns } from '../graph/semantic-turns.js'
import { parseVerb } from '../graph/semantic-verbs.js'

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

const root = mkdtempSync(join(tmpdir(), 'sg-verbs-'))
const projectDir = join(root, 'project')
mkdirSync(join(projectDir, 'semantic'), { recursive: true })
writeFileSync(join(projectDir, 'semantic', 'schema.json'), JSON.stringify(schema))
writeFileSync(join(projectDir, 'semantic', 'sources.json'), JSON.stringify(sources))
const dbDir = join(root, 'p', 'db')
const cwd = await prepareWorkspace({ root, projectId: 'p', managerUrl, projectDir, sessionId: 's1', tools: 'conversation' })
writeFileSync(join(cwd, '.session'), 's1'); writeFileSync(join(cwd, '.turn'), 'q1')
const graph = await openSemanticGraph({ dbDir, projectDir, managerUrl })
graph.openSession(null, null, 's1')

// The first answer: a program the composer would write and run.
const PROGRAM = `
export const meta = { name: 'hours by branch', description: 'Hours each branch worked over a span', params: { from: 'first day', through: 'last day' } }
export default async (ctx, p) => {
  const t = await ctx.ask({ measures: ['Sale.hours'], by: [{ to: 'Branch', via: ['project', 'branch'] }], span: { from: p.from, through: p.through } }, 'hours by branch')
  return { data: { t }, views: [{ id: 'table', component: 'table', data: 't', title: 'Hours by branch', encode: { columns: ['Branch', 'hours'] } }],
    narration: [{ text: '{b} worked {h}.', cites: { b: { data: 't', row: 0, column: 'Branch' }, h: { data: 't', row: 0, column: 'hours' } } }], nextSteps: [] }
}`
writeFileSync(join(cwd, 'program.mjs'), PROGRAM)
const ran = await promisify(execFile)(join(cwd, 'run-program'), ['program.mjs', JSON.stringify({ from: '2026-09-01', through: '2026-10-31' })], { cwd, encoding: 'utf8' })
assert.match(ran.stdout, /Sydney worked 21 h/)

// The engine's side, captured.
const told: Array<{ qid: string; answer: any; followups?: string[] }> = []
const turns = createSemanticTurns({
  graph: () => openSemanticGraph({ dbDir, projectDir, managerUrl }), emit: () => {},
  tell: (_r, _c, _s, qid, _t, answer, followups) => told.push({ qid, answer, followups }),
  viewsDir: join(root, 'views'), today: () => '2026-09-15',
})
const turn = (text: string, qid: string) => turns.semanticVerb(parseVerb(text)!, { sid: 's1', qid, reply: null, channel: '', t0: Date.now(), cwd, question: text })
const last = () => told.at(-1)!.answer

// Ids: the answer's table says which kind each name column holds, and each cell carries its record's id.
await turns.deliverSemanticStep({ sid: 's1', qid: 'q1', step: JSON.parse((await import('node:fs')).readFileSync(join(cwd, 'out', 'q1', 'step.json'), 'utf8')).step, kind: 'program', reply: null, channel: '', timing: { ms: 1 }, by: 'composer', question: 'hours by branch' })
const table = last().sections.find((s: any) => s.kind === 'table')
assert.deepEqual(table.columns[0], { label: 'Branch', entity: 'Branch' })
assert.deepEqual(table.rows[0][0], { value: 'Sydney', display: 'Sydney', id: 'b1' })
console.log('ids:', JSON.stringify(table.columns), JSON.stringify(table.rows[0]))

// program: the source and the parameters it ran with.
assert.deepEqual(await turn('program:', 'q2'), { done: true })
assert.deepEqual(last().sections[0].files.map((f: any) => f.path), ['program.mjs', 'params.json'])
assert.match(last().sections[0].files[1].text, /"through": "2026-10-31"/)

// run: the same program, same parameters, no model — the conversation's next step.
assert.deepEqual(await turn('run:', 'q3'), { done: true })
assert.equal(last().category, 'answer')
assert.match(last().answer, /Sydney worked 21 h/)
// run: <qid> names an earlier answer.
assert.deepEqual(await turn('rerun: q1', 'q4'), { done: true })
assert.match(last().answer, /Sydney worked 21 h/)

// check: run again and say what moved — nothing did.
assert.deepEqual(await turn('check:', 'q5'), { done: true })
assert.equal(last().category, 'check')
assert.match(last().sections[0].body, /Unchanged/)
assert.ok(last().sections.some((s: any) => s.kind === 'table'), 'the fresh answer follows the report')

// explain: and edit: go to the composer with what to do.
const ex = await turn('explain: why Sydney', 'q6') as any
assert.ok(ex.prompt && ex.explain, 'explain goes to the composer')
assert.match(ex.prompt, /out\/q5\/program\.mjs/)
const ed = await turn('edit: show it as a bar chart', 'q7') as any
assert.match(ed.prompt, /Copy it to program\.mjs/)

// view: a kind of record with no view yet is built by the composer; once kept, it runs with {id} and no model.
const build = await turn('view: branch b1', 'q8') as any
assert.equal(build.view.entity, 'Branch')
const VIEW = `
export const meta = { name: 'branch', description: 'One branch', params: { id: 'the branch' } }
export default async (ctx, p) => {
  const t = await ctx.ask({ measures: ['Sale.hours'], by: [{ to: 'Branch', via: ['project', 'branch'] }], where: [{ to: 'Branch', via: ['project', 'branch'], in: [p.id] }] }, 'hours of the branch')
  return { data: { t }, views: [], narration: [{ text: '{b} has worked {h}.', cites: { b: { data: 't', row: 0, column: 'Branch' }, h: { data: 't', row: 0, column: 'hours' } } }], nextSteps: [] }
}`
mkdirSync(join(cwd, 'out', 'q8'), { recursive: true })
writeFileSync(join(cwd, 'out', 'q8', 'program.mjs'), VIEW)
await turns.keepView(build.view, join(cwd, 'out', 'q8', 'program.mjs'))
assert.deepEqual(await turn('view: Branch b3', 'q9'), { done: true })
assert.equal(last().category, 'view')
assert.match(last().answer, /Perth has worked 8 h/)
assert.deepEqual(await turn('view: Planet 7', 'q10'), { done: true })
assert.match(last().answer, /kind is one of/)

// Not verbs: ordinary questions that happen to have a colon.
assert.equal(parseVerb('Q1: revenue by region'), null)
assert.equal(parseVerb('edit:'), null)

server.close()
console.log('\nall verbs ran as the engine runs them')
process.exit(0)
