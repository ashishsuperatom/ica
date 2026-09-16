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
//   ./trace ['<group>'|<call>]           what is under the answer on screen: the rows of one group, or its steps
//
// Each wrapper is generated into the agent's workspace with the paths it needs; the agent passes only the arguments.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { termsBrief, mistakes, fragmentOf, tied, revisions, judgedText, judge, completions, catalog, catalogText, conformedDimensions, dimensions, dimensionsText, termsText, check, nodeText, pathsText, find, nextMoves, node, paths, runProgram, tableOf, type Result } from '@superatom/semantic-graph'
import { MODEL, openSemanticGraph } from './semantic.js'

const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v }
const env = { dbDir: flag('db')!, projectDir: flag('project')!, managerUrl: flag('manager')!, home: flag('home')! }
// Each tool is named for what it does to what: the wrapper passes its own name.
const TOOLS: Record<string, string> = { match: 'match', look: 'look', ask: 'ask', 'run-program': 'program', commit: 'commit', trace: 'trace' }
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

/** Read a question in words into the graph: the subgraphs it could be, ranked, tried, and said back. */
async function match(text: string) {
  // THE WHOLE FIRST HALF, in one act. Words become things (eagerly, and at the sources for records), things become
  // subgraphs, subgraphs are ranked and the best few are asked so the data can separate them.
  const today = new Date().toISOString().slice(0, 10)
  const read = await graph.resolveQuestionTerms(MODEL, text, { today })
  const currency = Object.entries(m.settings ?? {}).find(([k]) => /currency/i.test(k))?.[1]
  const fragment: any = { ...fragmentOf(read.terms as any), phrases: read.terms.map((t) => t.phrase), ...(typeof currency === 'string' ? { currency } : {}) }

  // A NAME THE SOURCES DID NOT HOLD BY ITS WHOLE SELF. "paspley d365 commerce" is a project, typed as people type:
  // a word misspelt, a code left off the front. The words the graph could not place are put back together and
  // looked for INSIDE the kinds of thing the question named — which is what a person does, and costs one query
  // per kind rather than a search of everything.
  const unplaced = (read.unmatched ?? []).filter((w) => w.length > 2 && !/^\d+$/.test(w))
  const kinds = [...new Set((read.terms as any[]).flatMap((t) => t.means.filter((x: any) => x.kind === 'object' && m.schema.objects[x.node]?.kind === 'entity').map((x: any) => x.node)))] as string[]
  // Words the graph could not place are searched for whether or not something else was found: a question names
  // more than one thing, and a record found for one word says nothing about the words still unaccounted for.
  if (unplaced.length && kinds.length) {
    // A NAME THE SOURCES DID NOT HOLD BY ITS WHOLE SELF — a word misspelt, a code left off the front, punctuation
    // where the question had none. The words the graph could not place are tried against the kinds of thing the
    // question named, LONGEST RUN FIRST: a run of adjacent words is far more distinctive than any one of them, and
    // a source that answers a single common word with its row cap may not hold the right row at all. The first run
    // that comes back small enough to read is scored by how much of what was typed each name actually holds — a
    // word it contains, or one a single typo away.
    const runs: string[] = []
    for (let n = Math.min(unplaced.length, 3); n >= 1; n--) for (let i = 0; i + n <= unplaced.length; i++) runs.push(unplaced.slice(i, i + n).join(' '))
    // The kind NEAREST the unknown words is tried first: "project paspley d365 commerce" says which kind those
    // words name, and asking the wrong kind first is how a budget is spent before the right question is asked.
    const lower = text.toLowerCase()
    const near = (entity: string) => {
      const phrase = (read.terms as any[]).find((t) => t.means.some((x: any) => x.node === entity && x.kind === 'object'))?.phrase ?? entity
      const at = lower.indexOf(String(phrase).toLowerCase()), from = lower.indexOf(unplaced[0])
      return at < 0 || from < 0 ? 1e6 : Math.abs(from - at)
    }
    const order = [...kinds].sort((a, b) => near(a) - near(b))
    const seen = new Map<string, { object: string; key: string; label: string; hits: number }>()
    let asked = 0
    for (const needle of runs) {
      if (asked >= 12 || [...seen.values()].some((x) => x.hits >= 2)) break
      for (const entity of order.slice(0, 2)) {
        if (asked >= 12) break
        asked++
        const found: any = await graph.members(MODEL, entity, needle).catch(() => null)
        const matches = found?.matches ?? []
        if (!matches.length || matches.length > 25) continue   // nothing, or too many to tell anything from
        for (const b of matches) {
          const label = String(b.label).toLowerCase()
          const parts = label.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
          const hits = unplaced.filter((u) => label.includes(u) || parts.some((lw) => mistakes(lw, u) <= 1)).length
          const key = `${entity}|${b.key}`
          if (!seen.has(key) || seen.get(key)!.hits < hits) seen.set(key, { object: entity, key: String(b.key), label: String(b.label), hits })
        }
      }
    }
    const best = [...seen.values()].sort((a, b) => b.hits - a.hits).filter((x) => x.hits >= 2).slice(0, 3)
    if (best.length) {
      const phrase = unplaced.join(' ')
      ;(fragment.values ??= []).push({ text: phrase, meanings: best.map((b) => ({ object: b.object, key: b.key, label: b.label })) })
      read.notes = [...(read.notes ?? []), `"${phrase}" is ${best.map((b) => `${b.label} (a ${b.object})`).join(' or ')}`]
    }
  }

  const { done, refused } = completions(m.schema, fragment)
  const ask = async (q: any) => {
    const a = await graph.ask(q, { model: MODEL, today })
    return a.ok ? { ok: true as const, result: { rows: a.result.rows } } : { ok: false as const, rule: a.rule ?? 'error', reason: a.reason ?? 'failed' }
  }
  // WHAT IS LEFT OVER is what the graph never placed — not every word of the question. A phrase that became a
  // measure, a dimension, a record or a span is accounted for by construction; saying otherwise reads as a fault
  // where there is none.
  const placed = new Set((fragment.values ?? []).flatMap((v: any) => String(v.text).split(/\s+/)))
  const over = (read.unmatched ?? []).filter((w) => w.length > 2 && !placed.has(w))
  const judged = await judge(m.schema, done, over, ask)
  const ties = tied(judged)
  const ways = judged[0]?.evidence ? revisions(m.schema, judged[0].completion.question, judged[0].evidence) : []
  // THE BEST FEW, not every reading the graph could build: the rest are counted, so nothing is hidden and nothing
  // is dumped. An agent that wants more can say more of the question.
  const top = judged.slice(0, 3)
  const rest = judged.length - top.length
  if (asJson) out({ terms: termsBrief(read), readings: top.map((j) => ({ question: j.completion.question, said: j.said, why: j.why, uncertain: j.completion.uncertain, leftOver: j.leftOver, evidence: j.evidence })), ...(rest > 0 ? { more: rest } : {}), tied: ties.map((t) => t.differ), revisions: ways, refused: dedupe(refused) })
  else {
    const said = [termsText(m.schema, read, text)]
    if (top.length) said.push('', judgedText(top, ties), ...(rest > 0 ? [`and ${rest} more reading${rest > 1 ? 's' : ''} the graph can build — say more of the question to narrow it`] : []))
    else said.push('', dedupe(refused).length ? `nothing completes yet:\n${dedupe(refused).map((r) => `  ${r.rule}: ${r.reason}`).join('\n')}` : 'nothing in the graph fits that yet — ./look to see what it holds')
    if (ways.length) said.push('', `if that is not it: ${ways.map((w) => w.why).join('; ')}`)
    out(said.join('\n'))
  }
}

if (command === 'match') {
  await match(args.join(' ').trim() || fail("usage: ./match '<the question, as asked>'"))
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
    // WHAT COMES BACK IS READ, NOT STORED. A name that matches two hundred records says "narrow it", not two
    // hundred lines: the closest few are shown with the total, so the answer stays something a person — or an
    // agent with a finite head — can actually use.
    const found: any = await graph.members(MODEL, first, second)
    const all = found.matches ?? []
    const shown = all.slice(0, 10)
    const capped = all.length >= 200   // the source stops at its row cap: there may be more it never sent
    out({ ...found, matches: shown, ...(all.length > shown.length ? {
      matched: capped ? `${all.length} or more` : all.length,
      notShown: all.length - shown.length,
      advice: `${capped ? 'at least ' : ''}${all.length} names match "${second}" — say more of the name, or a distinctive part of it, to narrow it`,
    } : {}) })
  }
} else if (command === 'ask' && !args.join(' ').trim().startsWith('{')) {
  // WORDS, HANDED TO THE TOOL THAT READS WORDS. "ask" means asking in English, so a question in English arrives
  // here often; sending it back with a complaint teaches nothing. It is read into the graph, and the readings say
  // which one to evaluate.
  await match(args.join(' ').trim() || fail("usage: ./ask '<question>' — or ./ask '<the question in words>' to have it read into the graph first"))
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
} else if (command === 'trace') {
  // WHAT IS UNDER THE ANSWER ON SCREEN: the rows of one group, or the steps it was reached by. A group is JSON.
  const s0 = current() ?? fail('this conversation has no answer to look behind')
  const [what, askedCall] = args
  if (!what || !what.trim().startsWith('{')) { out(graph.trace(what ?? s0.callId ?? fail('no answer to trace'))); }
  else {
    const callId = askedCall ?? ((s0.question as any)?.program ? fail("an answer program asked several questions — ./trace lists them; name one: ./trace '<group>' <call>") : s0.callId!)
    out(await graph.detail(callId, json(what, 'the group'), { model: MODEL, limit: 20 }))
  }
} else fail(`unknown tool "${tool}" — ${Object.keys(TOOLS).join(', ')}`)
process.exit(0)
