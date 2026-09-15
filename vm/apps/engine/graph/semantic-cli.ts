// ── THE AGENTS' TOOLS FOR THE SEMANTIC GRAPH ────────────────────────────────────────────────────────────────
//
//   ./overview                every fact, entity and calendar, briefly
//   ./describe <name>          one node: its arrows, what points at it, measures, attributes, members
//   ./group-paths <from> <to>     every way from one node to another
//   ./find-dimension <word>             the nodes and members a word is
//   ./find-record <Entity> <text>  which member was meant by what was typed
//   ./check-question '<question>'   the plan for a question, or the rule that refuses it and the choices
//   ./try-question '<q>'            see a question's answer while writing the program
//   ./try-program [file] [params]   the answer program's answer as a person would read it, not yet given
//   ./run-program [file] [params]   run the answer program as this conversation's next step
//   ./source-records '<group>'         the rows behind one group of the current answer
//   ./trace-answer [call]           how an answer was reached
//
// Each wrapper is generated into the agent's workspace with the paths it needs; the agent passes only the arguments.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { catalog, catalogText, conformedDimensions, dimensions, dimensionsText, termsText, check, nodeText, pathsText, find, nextMoves, node, paths, runProgram, tableOf, type Result } from '@superatom/semantic-graph'
import { MODEL, openSemanticGraph } from './semantic.js'

const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v }
const env = { dbDir: flag('db')!, projectDir: flag('project')!, managerUrl: flag('manager')!, home: flag('home')! }
// Each tool is named for what it does to what: the wrapper passes its own name.
const TOOLS: Record<string, string> = { 'resolve-terms': 'terms', 'overview': 'catalog', 'describe': 'node', 'group-paths': 'paths', 'list-dimensions': 'dimensions', 'find-measure': 'find-measure', 'find-dimension': 'find', 'find-record': 'members',
  'check-question': 'check', 'try-question': 'try', 'try-program': 'try-program', 'run-program': 'program', 'source-records': 'detail', 'trace-answer': 'trace' }
// How nodes connect reads as graph patterns; --json (or SEMANTIC_TOOL_FORMAT=json) gives the same views as JSON.
const asJson = argv.includes('--json') ? (argv.splice(argv.indexOf('--json'), 1), true) : process.env.SEMANTIC_TOOL_FORMAT === 'json'
const [tool, ...args] = argv
const command = TOOLS[tool] ?? ''

const out = (x: unknown) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2))
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

if (command === 'catalog') out(asJson ? catalog(m.schema) : catalogText(m.schema))
else if (command === 'node') { const name = args.join(' ').trim() || fail('usage: ./describe <name>'); out(asJson ? node(m.schema, name) : nodeText(m.schema, name)) }
else if (command === 'paths') {
  const [from, to] = args
  if (!from || !to) fail('usage: ./group-paths <from> <to>')
  out(asJson ? paths(m.schema, from, to).map((p) => p.join('.')) : pathsText(m.schema, from, to))
} else if (command === 'dimensions') {
  if (!args.length) fail('usage: ./list-dimensions <Fact> [<Fact> …]')
  out(asJson ? (args.length === 1 ? dimensions(m.schema, args[0]) : conformedDimensions(m.schema, args)) : dimensionsText(m.schema, args))
} else if (command === 'terms') {
  const text = args.join(' ').trim() || fail("usage: ./resolve-terms '<the question as asked>'")
  const read = await graph.resolveQuestionTerms(MODEL, text, { today: new Date().toISOString().slice(0, 10) })
  out(asJson ? read : termsText(m.schema, read, text))
} else if (command === 'find-measure') {
  const term = args.join(' ').trim() || fail('usage: ./find-measure <term>')
  const found = find(m.schema, term).filter((f) => f.kind === 'measure')
  out(found.length ? found : { none: `no measure is called "${term}"`, measures: catalog(m.schema).facts.map((f) => ({ fact: f.name, measures: f.measures })) })
} else if (command === 'find') {
  const term = args.join(' ').trim() || fail('usage: ./find-dimension <term>')
  out((await graph.matchWord(MODEL, term)).filter((f) => f.kind !== 'measure'))
}
else if (command === 'members') {
  const [entity, ...text] = args
  if (!entity || !text.length) fail('usage: ./find-record <Entity> <text>')
  out(await graph.members(MODEL, entity, text.join(' ')))
} else if (command === 'check') {
  const q = spanNamed(json(args.join(' '), 'the question'))
  const v = check(m.schema, { ...q, ...(q.span?.through ? { span: { from: q.span.from, to: new Date(Date.parse(q.span.through + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10) } } : {}) })
  out(v.ok ? { ok: true, columns: v.plan.columns.map((c) => (c.unit ? `${c.name} (${c.unit})` : c.name)), notes: v.plan.notes } : v)
} else if (command === 'try') {
  // A question asked to see its answer while writing the program; the conversation's answer is the program's.
  const q = spanNamed(json(args.join(' '), 'the question'))
  const a = await graph.ask(q, { model: MODEL, ...(sessionId ? { sessionId } : {}) })
  // As ctx.ask gives it to a program.
  out(a.ok ? (({ columns, rows, notes }) => ({ columns, rows: rows.slice(0, 25), ...(rows.length > 25 ? { total: rows.length } : {}), notes }))(tableOf(a.result)) : { refused: { ...(a.rule ? { rule: a.rule } : {}), reason: a.reason, ...((a as any).choices ? { choices: (a as any).choices } : {}) } })
} else if (command === 'try-program') {
  const [file = 'program.mjs', paramsText] = args
  const source = await readFile(join(env.home, file), 'utf8').catch(() => fail(`${file} is not in this folder`))
  const params = paramsText ? json(paramsText, 'the parameters') : {}
  const r = await runProgram(graph, source, params, { model: MODEL, sessionId: sessionId ?? undefined, today: new Date().toISOString().slice(0, 10), onExplain: (t) => console.error(`… ${t}`) })
  if (r.error) out({ refused: r.error, steps: r.steps })
  else {
    const a = r.answer!
    out({ headline: a.headline ? `${a.headline.label}: ${a.headline.display}` : null, narration: a.narration.map((n) => n.text), views: a.views.map((v) => `${v.id}: ${v.component} of ${v.data}`),
      data: Object.fromEntries(Object.entries(a.data).map(([k, t]) => [k, { rows: t.rows.length, columns: t.columns.map((c) => c.name), first: t.rows.slice(0, 20) }])), notes: a.notes, steps: r.steps.map((x) => `${x.kind}: ${'label' in x ? x.label : x.text}`) })
  }
} else if (command === 'program') {
  if (!sessionId) fail('there is no data session for this conversation')
  const qid = await readTurn('.turn') || fail('there is no turn in progress here')
  const [file = 'program.mjs', paramsText] = args
  const source = await readFile(join(env.home, file), 'utf8').catch(() => fail(`${file} is not in this folder`))
  const params = paramsText ? json(paramsText, 'the parameters') : {}
  const today = new Date().toISOString().slice(0, 10)
  const r = await runProgram(graph, source, params, { model: MODEL, sessionId, today, onExplain: (t) => console.error(`… ${t}`) })
  if (r.error) out({ refused: r.error, steps: r.steps })
  else {
    // The program's answer is this conversation's next step, and ends the turn.
    const s = graph.store.getSession(sessionId)
    const stepId = graph.store.addStep({ sessionId, parent: s?.currentStep ?? null, move: { program: r.meta!.name, params }, question: { program: r.meta!.name, params }, canonical: null, callId: r.callId, refusal: null }, true)
    await mkdir(join(env.home, 'out', qid), { recursive: true })
    // The program and what it was run with, beside the answer: what run:, check:, program: and edit: act on.
    await writeFile(join(env.home, 'out', qid, 'program.mjs'), source)
    await writeFile(join(env.home, 'out', qid, 'params.json'), JSON.stringify(params, null, 2))
    await writeFile(join(env.home, 'out', qid, 'step.json'), JSON.stringify({ graph: 'semantic', kind: 'program', sessionId, step: stepId, callId: r.callId }, null, 2))
    out({ step: stepId, narration: r.answer!.narration.map((n) => n.text), views: r.answer!.views.map((v) => `${v.id}: ${v.component} of ${v.data}`), data: Object.fromEntries(Object.entries(r.answer!.data).map(([k, t]) => [k, { columns: t.columns.map((c) => c.name), rows: t.rows.slice(0, 5), total: t.rows.length }])), notes: r.answer!.notes, steps: r.steps.map((x) => `${x.kind}: ${'label' in x ? x.label : x.text}`) })
  }
} else if (command === 'moves') {
  const s = current() ?? fail('this conversation has no answer to move from yet')
  const q = s.question
  out(nextMoves(m.schema, (q.span && !('to' in q.span) ? { ...q, span: undefined } : q)).map((x) => ({ reads: x.reads, move: x.move })))
} else if (command === 'detail') {
  const s = current() ?? fail('this conversation has no answer to look behind')
  const [group, askedCall] = args
  const callId = askedCall ?? ((s.question as any)?.program ? fail('an answer program asked several questions — ./trace-answer lists them; name one: ./source-records \'<group>\' <call>') : s.callId!)
  out(await graph.detail(callId, json(group, 'the group'), { model: MODEL, limit: 20 }))
} else if (command === 'trace') {
  const call = args[0] ?? current()?.callId ?? fail('no answer to trace')
  out(graph.trace(call))
} else fail(`unknown tool "${tool}" — ${Object.keys(TOOLS).join(', ')}`)
process.exit(0)
