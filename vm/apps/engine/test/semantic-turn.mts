// Questions through the composer answering with the semantic graph: the real agent and its tools, a project whose
// semantic model is the branches fixture, and a datasource manager serving that data over HTTP.
//
//   pnpm exec tsx apps/engine/test/semantic-turn.mts "<question>" ["<follow-up>" …]

import { createServer } from 'node:http'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSemanticTurns } from '../graph/semantic-turns.js'
import { parseVerb } from '../graph/semantic-verbs.js'
import { createComposer } from '../agents/composer/index.js'
import { MODEL, openSemanticGraph, semanticFile } from '../graph/semantic.js'
import { instance, schema } from '../../../packages/semantic-graph/test/fixtures/branches.js'
import { ModelStore } from '../../../packages/semantic-graph/src/index.js'
import { toSqlite } from '../../../packages/semantic-graph/test/fixtures/sqlite.js'

const questions = process.argv.slice(2)
if (!questions.length) { console.error('usage: semantic-turn.mts "<question>" ["<follow-up>" …]'); process.exit(1) }

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

const root = process.env.STATE ?? mkdtempSync(join(tmpdir(), 'sg-turn-'))
const projectDir = join(root, 'project')
mkdirSync(projectDir, { recursive: true })
// The model, built in the project's graph store through its operations — as the semantic-graph tool builds one.
new ModelStore(semanticFile(join(root, 'branches', 'db'))).import(MODEL, { schema, sources }, { by: 'test' })
writeFileSync(join(projectDir, 'settings.json'), JSON.stringify({ timezone: 'Australia/Sydney', currency: 'AUD' }))

const sid = `trial-${Date.now().toString(36)}`
const graph = await openSemanticGraph({ dbDir: join(root, 'branches', 'db'), projectDir, managerUrl })
graph.openSession(null, null, sid)
const log = join(root, `${sid}.log`)
const composer = await createComposer({ root, projectId: 'branches', managerUrl, projectDir, sessionId: sid })
console.log(`state ${root} · log ${log}`)
const told: any[] = []
const turns = createSemanticTurns({ graph: () => openSemanticGraph({ dbDir: join(root, 'branches', 'db'), projectDir, managerUrl }), emit: () => {},
  tell: (_r, _c, _s, _q, _t, answer) => told.push(answer), viewsDir: join(root, 'views'), today: () => '2026-09-15' })

for (const [i, question] of questions.entries()) {
  const qid = `q${i + 1}-${Date.now().toString(36)}`
  const t0 = Date.now()
  console.log(`\n── ${question}`)
  // A verb turn as the engine takes it: answered without a model, or the composer's with what to do.
  const verb = parseVerb(question)
  let asked = question
  if (verb) {
    const v = await turns.semanticVerb(verb, { sid, qid, reply: null, channel: '', t0, cwd: composer.cwd, question })
    if ('done' in v) { console.log(`  ${verb.verb}: ${JSON.stringify(told.at(-1)).slice(0, 300)}`); continue }
    asked = v.prompt
  }
  const r = await composer.ask(asked, {
    onEvent: (ev: any) => {
      appendFileSync(log, JSON.stringify(ev) + '\n')
      if (ev.kind === 'command' && ev.command && !ev.done && ev.status !== 'completed') console.log(`  $ ${String(ev.command).replace(/\s+/g, ' ').slice(0, 220)}`)
    },
  }, { qid, sessionId: sid })
  const g = await openSemanticGraph({ dbDir: join(root, 'branches', 'db'), projectDir, managerUrl })
  const steps = g.store.steps(sid)
  const last = steps.filter((s) => s.callId).at(-1)
  const call = last?.callId ? g.store.getCall(last.callId) : null
  console.log(`  ${r.escalate ? `escalated: ${r.escalate.reason}` : r.explained ? 'explained' : `step ${r.step}`} · ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  if (r.explained) console.log((await import('node:fs')).readFileSync(join(composer.cwd, 'out', qid, 'explain.md'), 'utf8'))
  if (call) { console.log(`  question ${JSON.stringify(call.question)}`); const o = call.output as any; console.log(`  answer ${JSON.stringify(o?.narration ?? o?.rows)}`); if (o?.views) console.log(`  views ${JSON.stringify(o.views)} · next ${JSON.stringify(o.nextSteps)}`) }
  void MODEL
}
composer.session.stop?.()
server.close()
process.exit(0)
