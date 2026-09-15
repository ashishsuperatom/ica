// ── A CONVERSATION'S TURNS ON THE SEMANTIC GRAPH: A STEP DELIVERED, AND THE VERBS ON THE ANSWER ON SCREEN ───────
//
// The engine hands in how to reach the graph and the surfaces; everything else is here, so a turn can be driven in a
// test without a hub. The verbs themselves — what they match and what they say — are graph/semantic-verbs.ts.

import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nextMoves, runProgram, type createGraph } from '@superatom/semantic-graph'
import type { Answer } from '../../../../clients/protocol.js'
import { MODEL } from './semantic.js'
import { followupsOf, semanticTable, surfaceAnswer } from './surface-answer.js'
import { CATEGORY, checkAnswer, checkReport, diffAnswers, editPrompt, explainPrompt, parseView, programAnswer, viewFile, viewPrompt, type VerbMatch, type ViewRef } from './semantic-verbs.js'

type Graph = ReturnType<typeof createGraph>
export interface TurnDeps {
  graph: () => Promise<Graph>
  emit: (to: any, msg: any) => void
  tell: (reply: any, channel: string, sid: string, qid: string, timing: { ms: number }, answer: Answer, followups?: string[]) => void
  viewsDir: string
  today: () => string
}

const readJson = async (path: string) => { try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null } }

export function createSemanticTurns(d: TurnDeps) {
  async function deliverSemanticStep(o: { sid: string; qid: string; step: number; kind?: string; reply: any; channel: string; timing: { ms: number }; by: string; question: string; category?: string; around?: (a: any) => any }) {
  const sg = await d.graph()
  const held = sg.store.steps(o.sid).find((x) => x.id === o.step)
  const call = held?.callId ? sg.store.getCall(held.callId) : null
  const plan = call?.plan as any
  const interpretation = { question: o.question, canonical: call?.canonical, readAs: plan?.notes ?? [] }
  d.emit(o.reply, { t: 'session:step' as const, sid: o.sid, qid: o.qid, step: held?.id, parent: held?.parent ?? null, message: held?.move, state: held?.question,
    answer: call?.output ?? null, caveats: call?.caveats ?? [], interpretation, graph: 'semantic', timing: o.timing, by: o.by })
  // A program's answer is its data, views, narration and the next steps its author proposed; a graph question's is its table.
  const program = o.kind === 'program' || !!(held?.question as any)?.program
  let surfaced: any = call?.error ? { status: 'error' as const, answer: call.error }
    : program ? surfaceAnswer(call?.output as any, (call?.output as any)?.notes ?? [])
    : surfaceAnswer(semanticTable(call?.output as any) as any, (call?.output as any)?.notes ?? [])
  if (o.around) surfaced = o.around(surfaced)
  if (o.category) surfaced = { ...surfaced, category: o.category }
  const followups = program ? followupsOf(call?.output as any)
    : held?.question ? (() => { try { return nextMoves(sg.model(MODEL).schema, held.question).slice(0, 4).map((x) => x.reads) } catch { return [] } })() : []
  d.tell(o.reply, o.channel, o.sid, o.qid, o.timing, surfaced, followups)
  console.log(`[ica] ${o.by} · semantic step ${held?.id} · ${(o.timing.ms / 1000).toFixed(1)}s`)
}

  async function keepView(v: ViewRef, from: string) {
  await mkdir(d.viewsDir, { recursive: true })
  await copyFile(from, join(d.viewsDir, viewFile(v))).catch((e) => console.warn(`[verbs] view not kept: ${e.message}`))
}

/** The recorded run a verb acts on: the answer on screen, or the one a question id names. */
  async function verbSubject(sid: string, rest: string, cwd: string) {
  const sg = await d.graph()
  let callId: string | null = null
  let qid: string | undefined
  if (rest && /^[\w-]{6,}$/.test(rest)) {
    const s = await readJson(join(cwd, 'out', rest, 'step.json')) as any
    if (!s?.callId) return { error: `There is no answer \`${rest}\` in this conversation.` }
    callId = s.callId; qid = rest
  } else {
    const session = sg.store.getSession(sid)
    const step = session?.currentStep ? sg.store.steps(sid).find((x) => x.id === session.currentStep) : null
    callId = step?.callId ?? null
    // The question id it was answered under, so its program files can be read.
    if (callId) for (const dir of await readdir(join(cwd, 'out')).catch(() => [] as string[])) {
      const s = await readJson(join(cwd, 'out', dir, 'step.json')) as any
      if (s?.callId === callId) { qid = dir; break }
    }
  }
  const call = callId ? sg.store.getCall(callId) : null
  if (!call) return { error: 'There is no answer on screen yet: ask a question first.' }
  const q = call.question as any
  return { call, qid, program: q?.program ? { name: String(q.program), params: q.params ?? {}, source: String((call.plan as any)?.source ?? '') } : null }
}

/** Run a recorded program again as the conversation's next step, and remember it under this question id. */
  async function runAgain(sid: string, qid: string, cwd: string, p: { name: string; params: unknown; source: string }) {
  const sg = await d.graph()
  const r = await runProgram(sg, p.source, p.params as Record<string, unknown>, { model: MODEL, sessionId: sid, today: d.today() })
  if (r.error) return { error: r.error }
  const session = sg.store.getSession(sid)
  const step = sg.store.addStep({ sessionId: sid, parent: session?.currentStep ?? null, move: { program: p.name, params: p.params }, question: { program: p.name, params: p.params }, canonical: null, callId: r.callId, refusal: null }, true)
  const dir = join(cwd, 'out', qid)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'program.mjs'), p.source)
  await writeFile(join(dir, 'params.json'), JSON.stringify(p.params, null, 2))
  await writeFile(join(dir, 'step.json'), JSON.stringify({ graph: 'semantic', kind: 'program', sessionId: sid, step, callId: r.callId }, null, 2))
  return { step, callId: r.callId }
}

/** A verb turn: answered here when no model is needed, or handed to the composer with what to do. */
  async function semanticVerb(v: VerbMatch, o: { sid: string; qid: string; reply: any; channel: string; t0: number; cwd: string; question: string }):
  Promise<{ done: true } | { prompt: string; verb: VerbMatch; view?: ViewRef; explain?: string }> {
  const say = (answer: any) => { d.tell(o.reply, o.channel, o.sid, o.qid, { ms: Date.now() - o.t0 }, { category: CATEGORY[v.verb], ...answer }); return { done: true as const } }
  const sg = await d.graph()
  if (v.verb === 'view') {
    const entities = Object.entries(sg.model(MODEL).schema.objects).filter(([, x]) => x.kind === 'entity').map(([n]) => n)
    const ref = parseView(v.rest, entities)
    if ('error' in ref) return say({ status: 'cannot_answer', answer: ref.error })
    const kept = await readFile(join(d.viewsDir, viewFile(ref)), 'utf8').catch(() => null)
    if (!kept) return { prompt: viewPrompt(ref), verb: v, view: ref }
    const r = await runAgain(o.sid, o.qid, o.cwd, { name: `view of ${ref.entity}${ref.lens === 'canonical' ? '' : ` (${ref.lens})`}`, params: { id: ref.id }, source: kept })
    if ('error' in r) return say({ status: 'error', answer: `The view of ${ref.entity} ${ref.id} did not run: ${r.error}` })
    await deliverSemanticStep({ sid: o.sid, qid: o.qid, step: r.step!, kind: 'program', reply: o.reply, channel: o.channel, timing: { ms: Date.now() - o.t0 }, by: 'engine', question: o.question, category: CATEGORY.view })
    return { done: true }
  }
  const subject = await verbSubject(o.sid, v.verb === 'run' || v.verb === 'check' || v.verb === 'program' ? v.rest : '', o.cwd)
  if ('error' in subject) return say({ status: 'cannot_answer', answer: subject.error })
  const { call, program } = subject
  if (v.verb === 'explain') return { prompt: explainPrompt(v.raw, { qid: subject.qid, callId: call.id, program: !!program }), verb: v, explain: call.id }
  if (!program) return say({ status: 'cannot_answer', answer: 'The answer on screen was not made by a program, so there is no program to ' + (v.verb === 'edit' ? 'edit.' : v.verb === 'program' ? 'show.' : 'run.') })
  if (v.verb === 'program') return say(programAnswer(program.name, program.source, program.params))
  if (v.verb === 'edit') {
    if (!subject.qid) return say({ status: 'cannot_answer', answer: 'The program on screen is not in this conversation\'s folder, so it cannot be edited here.' })
    return { prompt: editPrompt(v.raw, v.rest, { qid: subject.qid, params: program.params }), verb: v }
  }
  // run: and check: — the same program with the same parameters; check: also says what moved.
  const r = await runAgain(o.sid, o.qid, o.cwd, program)
  if ('error' in r) return say({ status: 'error', answer: `${program.name} did not run again: ${r.error}` })
  const before = surfaceAnswer(call.output as any, (call.output as any)?.notes ?? [])
  const started = Date.now()
  await deliverSemanticStep({ sid: o.sid, qid: o.qid, step: r.step!, kind: 'program', reply: o.reply, channel: o.channel, timing: { ms: Date.now() - o.t0 }, by: 'engine', question: o.question, category: CATEGORY[v.verb],
    around: v.verb === 'check' ? (after) => checkAnswer(checkReport({ programDir: program.name, params: program.params, answeredAt: Number(call.at), ms: Date.now() - started, diff: diffAnswers(before, after) }), program.name, after) : undefined })
  return { done: true }
}

  return { deliverSemanticStep, semanticVerb, keepView }
}
