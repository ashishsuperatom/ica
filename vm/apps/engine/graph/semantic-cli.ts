// ── THE AGENTS' TOOLS FOR THE SEMANTIC GRAPH ────────────────────────────────────────────────────────────────
//
// Answering is SUBGRAPH MATCHING: a question names some things, the schema is a graph, and the answer is the
// subgraph the question picks out — checked by the rules, then evaluated. So there are four moments, and a tool
// for each, rather than a tool for each step of each moment.
//
//   ./match '<the question, as asked>'   the subgraphs it could be: words resolved, records looked up at their
//                                        sources, every route built, ranked, each said back in the graph's words,
//                                        the best few tried against the data so it can separate them
//   ./look [<node>] [<to>|<text>]        the graph itself: everything, or one node — its measures, what it links
//                                        to, what links to it, its dimensions — or the way from one node to
//                                        another, or which record a typed name means
//   ./ask '<question>'                   evaluate a subgraph: its answer, or the rule that refuses it and what to
//                                        change. Checking is what asking already does.
//   ./run-program [file] [params]        run the answer program and read its answer, as often as it takes
//   ./commit                             give that answer as this conversation's next step
//   ./behind ['<group>'|<call>]          what is under the answer on screen: the rows of one group, or its steps
//
// Each wrapper is generated into the agent's workspace with the paths it needs; the agent passes only the arguments.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fragmentOf, tied, revisions, judgedText, judge, completions, catalog, catalogText, conformedDimensions, dimensions, dimensionsText, termsText, check, nodeText, pathsText, find, nextMoves, node, paths, runProgram, tableOf, type Result } from '@superatom/semantic-graph'
import { MODEL, openSemanticGraph } from './semantic.js'

const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v }
const env = { dbDir: flag('db')!, projectDir: flag('project')!, managerUrl: flag('manager')!, home: flag('home')! }
// Each tool is named for what it does to what: the wrapper passes its own name.
const TOOLS: Record<string, string> = { match: 'match', look: 'look', ask: 'ask', 'run-program': 'program', commit: 'commit', behind: 'behind' }
// How nodes connect reads as graph patterns; --json (or SEMANTIC_TOOL_FORMAT=json) gives the same views as JSON.
const asJson = argv.includes('--json') ? (argv.splice(argv.indexOf('--json'), 1), true) : process.env.SEMANTIC_TOOL_FORMAT === 'json'
const [tool, ...args] = argv
const command = TOOLS[tool] ?? ''

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex')
const out = (x: unknown) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2))
/** The same refusal, however many candidates hit it, is one thing to fix. */
const dedupe = <T extends { rule: string; reason: string }>(xs: T[]): T[] => [...new Map(xs.map((x) => [`${x.rule}:${x.reason}`, x])).values()]
const fail = (msg: string): never => { console.error(msg); process.exit(1) }
const json = (text: string | undefined, what: string) => {
  if (!text) return fail(`${what} is required`)
  try { return JSON.parse(text) } catch (e: any) { return fail(`${what} is not JSON: ${e.message}`) }
}
/** A span as an agent writes it names its last day: `through`. */
const spanNamed = (q: any) => {
  if (q?.span && 'to' in q.span) fail(`a span says its first and last day: {"from":"${q.span.from}","through":"<last day>"}`)
  return q
}
const readTurn = async (name: string) => (await readFile(join(env.home, name), 'utf8').catch(() => '')).trim()

/** An answer short enough to read: its columns with units, the first rows, and what was said about it. */
const shown = (r: Result, rows = 25) => ({
  columns: r.columns.map((c) => (c.unit ? `${c.name} (${c.unit})` : c.name)),
  rows: r.rows.slice(0, rows).map((row) => row.map((v, i) => (v !== null && r.labels?.[i]?.[String(v)] && r.labels[i][String(v)] !== String(v) ? `${r.labels[i][String(v)]} (${v})` : v))), ...(r.rows.length > rows ? { more: r.rows.length - rows } : {}),
  ...(r.totals ? { totals: r.totals } : {}),
})

const graph = await openSemanticGraph(env)
const m = graph.model(MODEL)
const sessionId = await readTurn('.session')
const current = () => {
  const s = sessionId ? graph.store.getSession(sessionId) : null
  return s?.currentStep ? graph.store.steps(sessionId).find((x) => x.id === s.currentStep) ?? null : null
}

if (command === 'match') {
  // THE WHOLE FIRST HALF, in one act. Words become things (eagerly, and at the sources for records), things become
  // subgraphs, subgraphs are ranked and the best few are asked so the data can separate them.
  const text = args.join(' ').trim() || fail("usage: ./match '<the question, as asked>'")
  const today = new Date().toISOString().slice(0, 10)
  const read = await graph.resolveQuestionTerms(MODEL, text, { today })
  const currency = Object.entries(m.settings ?? {}).find(([k]) => /currency/i.test(k))?.[1]
  const fragment = { ...fragmentOf(read.terms as any), phrases: read.terms.map((t) => t.phrase), ...(typeof currency === 'string' ? { currency } : {}) }
  const { done, refused } = completions(m.schema, fragment)
  const ask = async (q: any) => {
    const a = await graph.ask(q, { model: MODEL, today })
    return a.ok ? { ok: true as const, result: { rows: a.result.rows } } : { ok: false as const, rule: a.rule ?? 'error', reason: a.reason ?? 'failed' }
  }
  const judged = await judge(m.schema, done, fragment.phrases ?? [], ask)
  const ties = tied(judged)
  const ways = judged[0]?.evidence ? revisions(m.schema, judged[0].completion.question, judged[0].evidence) : []
  if (asJson) out({ terms: read, readings: judged.map((j) => ({ question: j.completion.question, said: j.said, why: j.why, uncertain: j.completion.uncertain, leftOver: j.leftOver, evidence: j.evidence })), tied: ties.map((t) => t.differ), revisions: ways, refused: dedupe(refused) })
  else {
    const said = [termsText(m.schema, read, text)]
    if (judged.length) said.push('', judgedText(judged, ties))
    else said.push('', dedupe(refused).length ? `nothing completes yet:\n${dedupe(refused).map((r) => `  ${r.rule}: ${r.reason}`).join('\n')}` : 'nothing in the graph fits that yet — ./look to see what it holds')
    if (ways.length) said.push('', `if that is not it: ${ways.map((w) => w.why).join('; ')}`)
    out(said.join('\n'))
  }
} else if (command === 'look') {
  // THE GRAPH ITSELF. Nothing: the whole catalogue. One node: what it holds and what it reaches. Two: the way from
  // one to the other — or, when the second is not a node, which record of the first that text means.
  const [first, ...rest] = args
  const second = rest.join(' ').trim()
  if (!first) { out(asJson ? catalog(m.schema) : catalogText(m.schema)); }
  else if (!second) {
    const isFact = m.schema.objects[first]?.kind === 'fact'
    if (asJson) out({ node: node(m.schema, first), ...(isFact ? { dimensions: dimensions(m.schema, first) } : {}) })
    else out([nodeText(m.schema, first), ...(isFact ? ['', dimensionsText(m.schema, [first])] : [])].join('\n'))
  } else if (m.schema.objects[second]) {
    out(asJson ? paths(m.schema, first, second).map((p) => p.join('.')) : pathsText(m.schema, first, second))
  } else {
    out(await graph.members(MODEL, first, second))
  }
} else if (command === 'ask') {
  // EVALUATE A SUBGRAPH. A refusal says the rule and what to change, so asking is also how a question is checked.
  // HOW LONG IT TOOK travels with the answer: a reader — and the agent deciding how long to wait next time — learns
  // the cost of the question it asked, rather than guessing at it.
  const q = spanNamed(json(args.join(' '), 'the question'))
  const started = Date.now()
  const a = await graph.ask(q, { model: MODEL, ...(sessionId ? { sessionId } : {}) })
  const took = { seconds: Math.round((Date.now() - started) / 100) / 10 }
  out(a.ok ? (({ columns, rows, notes }) => ({ columns, rows: rows.slice(0, 25), ...(rows.length > 25 ? { total: rows.length } : {}), notes, took }))(tableOf(a.result))
    : { refused: { ...(a.rule ? { rule: a.rule } : {}), reason: a.reason, ...((a as any).choices ? { choices: (a as any).choices } : {}) }, took })
} else if (command === 'program') {
  const [file = 'program.mjs', paramsText] = args
  const source = await readFile(join(env.home, file), 'utf8').catch(() => fail(`${file} is not in this folder`))
  const params = paramsText ? json(paramsText, 'the parameters') : {}
  const today = new Date().toISOString().slice(0, 10)
  const r = await runProgram(graph, source, params, { model: MODEL, sessionId: sessionId ?? undefined, today, onExplain: (t) => console.error(`… ${t}`) })
  if (r.error) out({ refused: r.error, steps: r.steps })
  else {
    // The run is kept beside the turn, so ./commit gives exactly the answer read here.
    const qid = await readTurn('.turn')
    if (qid) {
      await mkdir(join(env.home, 'out', qid), { recursive: true })
      await writeFile(join(env.home, 'out', qid, 'run.json'), JSON.stringify({ file, source: hashOf(source), name: r.meta!.name, params, callId: r.callId }, null, 2))
    }
    const a = r.answer!
    out({ headline: a.headline ? `${a.headline.label}: ${a.headline.display}` : null, narration: a.narration.map((n) => n.text), views: a.views.map((v) => `${v.id}: ${v.component} of ${v.data}`),
      data: Object.fromEntries(Object.entries(a.data).map(([k, t]) => [k, { rows: t.rows.length, columns: t.columns.map((c) => c.name), first: t.rows.slice(0, 20) }])), notes: a.notes, steps: r.steps.map((x) => `${x.kind}: ${'label' in x ? x.label : x.text}`) })
  }
} else if (command === 'commit') {
  if (!sessionId) fail('there is no data session for this conversation')
  const qid = await readTurn('.turn') || fail('there is no turn in progress here')
  const run = await readFile(join(env.home, 'out', qid, 'run.json'), 'utf8').then(JSON.parse).catch(() => null) ?? fail('there is no run to commit: ./run-program first')
  const source = await readFile(join(env.home, run.file), 'utf8').catch(() => fail(`${run.file} is not in this folder`))
  if (hashOf(source) !== run.source) fail(`${run.file} has changed since it was run: ./run-program it, read its answer, then ./commit`)
  // The run's answer is this conversation's next step, and ends the turn.
  const s = graph.store.getSession(sessionId)
  const stepId = graph.store.addStep({ sessionId, parent: s?.currentStep ?? null, move: { program: run.name, params: run.params }, question: { program: run.name, params: run.params }, canonical: null, callId: run.callId, refusal: null }, true)
  // The program and what it was run with, beside the answer: what run:, check:, program: and edit: act on.
  await writeFile(join(env.home, 'out', qid, 'program.mjs'), source)
  await writeFile(join(env.home, 'out', qid, 'params.json'), JSON.stringify(run.params, null, 2))
  await writeFile(join(env.home, 'out', qid, 'built.json'), JSON.stringify({ graph: 'semantic', kind: 'program', sessionId, step: stepId, callId: run.callId, program: run.name, source: run.source, params: run.params }, null, 2))
  out(`committed ${run.name} as step ${stepId}`)
} else if (command === 'moves') {
  const s = current() ?? fail('this conversation has no answer to move from yet')
  const q = s.question
  out(nextMoves(m.schema, (q.span && !('to' in q.span) ? { ...q, span: undefined } : q)).map((x) => ({ reads: x.reads, move: x.move })))
} else if (command === 'behind') {
  // WHAT IS UNDER THE ANSWER ON SCREEN: the rows of one group, or the steps it was reached by. A group is JSON.
  const s0 = current() ?? fail('this conversation has no answer to look behind')
  const [what, askedCall] = args
  if (!what || !what.trim().startsWith('{')) { out(graph.trace(what ?? s0.callId ?? fail('no answer to trace'))); }
  else {
    const callId = askedCall ?? ((s0.question as any)?.program ? fail("an answer program asked several questions — ./behind lists them; name one: ./behind '<group>' <call>") : s0.callId!)
    out(await graph.detail(callId, json(what, 'the group'), { model: MODEL, limit: 20 }))
  }
} else fail(`unknown tool "${tool}" — ${Object.keys(TOOLS).join(', ')}`)
process.exit(0)
