// LEARNING FROM EACH ANSWER (docs/intent-graph.md): after every answer, what the conversation taught about answering its
// intents is worked out by a CLONE of the conversation (ica/clone.ts), in the background — it has the whole context, the
// person is never kept waiting, and its work never enters the conversation. Learnt after every answer, not when an intent
// ends: a person content with the first answer never asks again, and what it taught must not be lost.
//
// ONE LEARNER PER SESSION: at most one clone runs at a time. Answers that arrive while it runs start nothing more; when it
// finishes it runs once again over everything new since it began (most often it is quick, and runs once per answer). Each
// run takes every intent of the session with turns not yet learnt from, in one clone turn. The clone writes one file; the
// engine keeps, per intent:
//
//   - new concepts, atomic, in the composition graph as the person's own (provisional; theirs to use at once), each one
//     that holds for everyone suggested for everyone (an admin decides) — never copied into the node, only named;
//   - the person's variant of the node: the concepts it stands on, the way to answer it, how it is shown, its sub-paths
//     (only when it differs from the one they answer with);
//   - what the node is, for a node the analyst made in this session;
//   - the names in its questions (a customer, a site …), so later questions with other names have the same canonical form;
//   - the three next intents it suggests — interpolation, extrapolation, novelty — each the intent's (sensible for anyone
//     asking it), with a check (an option function) saying when it makes sense.
// Most often nothing is new.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { openClone, type CloneOf } from './ica/clone.js'
import { NEXT_KINDS, ownerOf, type IntentParam, type IntentVariantBody, type NextKind } from '@superatom/platform-types'
import type { createIntents, NextEdge } from './intent.js'
import type { Who } from './identity.js'
import { compileCheck } from './intent-checks.js'

/** One intent of the session as it stands: its node and every turn answered at it. */
export interface IntentTurns { node: string; madeHere: boolean; turns: { qid: string; question: string; answer: string; agent: string }[] }
/** The session after an answer: who it is, and its intents. */
export interface Answered { session: string; who: Who; intents: IntentTurns[] }

const CONCEPT_NAME = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*){1,3}$/

const SCHEMA = `{
  "keep": true or false — false when it was not a request (a greeting, a thank-you): nothing else is kept for it then,
  "title": a few words naming the kind of question (not its values),
  "intent": what is asked for, in general terms,
  "names": the names in its questions that change from one asking to the next — [{ "value": "<as written>", "kind": "customer" | "site" | …: what it is a name of }] (not dates, periods, numbers or codes),
  "concepts": {
    "use": the names of the concepts you were given that its answers stand on,
    "new": the shared knowledge its answers stand on that no concept you were given says — [{ "name": "<area>/<thing>" in
           lower case, read the same by everyone in the organisation, "title": "...", "text": "...", "for": "intent" when it is
           about answering this kind of question, "me" when it is how this person wants every answer (how amounts are written,
           how long an answer is…), "everyone": true when it holds for the whole organisation, false when only for this person }]
  },
  "process": the intent's own path: how its answer is found, so it can be found again directly (below),
  "show": how the person wants the answer shown,
  "paths": where the path divides by the situation: [{ "when": "...", "how": "..." }],
  "next": new next questions only where they make sense — none is fine, never more than three in all (below):
           { "interpolation": [NEXT], "extrapolation": [NEXT], "novelty": [NEXT] } (a kind left out adds none), each NEXT being
           { "asked": "the question as a person would ask it", "label": "a few words", "check": an option function, or null },
  "retire": the next questions it has that rarely make sense or are never taken — [{ "id": "<its id>", "why": "..." }]
}`

/** What a node holds about answering it — like a large program: what many questions share lives once in concepts (a library),
 *  the intent keeps its own path through them. */
const MEMORY_RULES = `Like a large program: what many questions share is defined once, as concepts — every definition and every calculation
(how a figure is defined and computed: revenue, money pending, what counts as open), where each thing lives (source, table,
columns), how tables join, the rules of the business. A concept says one thing; when its formula is corrected, everything
that uses it is corrected. Put all such logic in concepts: use the concept you were given that says it, write a new one
for the rest — so that loading an intent's concepts is enough to answer it again, for any period, customer or value.
"process" is the intent's own path through them — the steps in order, how the values in the question are applied, which
concepts each step uses (by name, not repeated), what the answer shows — so the next time it is asked the work starts from
it. Say how to find the answer; mention a trap only when it changes the result.`

/** What the next questions are — the intent's, never only this answer's. */
const NEXT_RULES = `The next questions belong to the intent, not to this one answer: each must make sense to anyone who asks this kind of
question, with any values — written from what the intent is for (the decision or the work it serves), never from the
particular figures seen this time. Values that change go in as the person would say them generally ("that supplier", "the
period"), or as placeholders.
- interpolation: what follows naturally — the same thing, one step further: the detail behind a figure, a breakdown, the
  same over another period or scope.
- extrapolation: a different question the answer's data leads to — what the kind of figures this intent shows would make
  someone responsible ask next (a cause, a comparison, a consequence).
- novelty: a direction outside the data shown — what someone responsible for this would also need to know, that this kind of
  answer never touches.
Each one's check decides, each time the intent is answered, whether that next question makes sense then, from the data and
the answer; its label is said from what is there. A next question that needs no check has none. After an answer the most
likely of each kind are tried in order and the first that makes sense is offered; what happened each time is shown beside
the ones it has — look at them and learn from it. Add a new one only where it makes sense: a kind may have none when nothing
of that kind makes sense for this intent, and most times nothing needs adding. Never more than three new ones at a time.`

const poolLine = (e: NextEdge) => `    [${e.kind}] ${e.to} "${e.title}" — tried ${e.tried ?? 0}, made sense ${e.held ?? 0}, failed ${e.failed ?? 0}, taken by people ${e.taken ?? 0}`
const prompt = (intents: (IntentTurns & { id: string; title: string; intent: string; pool: NextEdge[]; standsOn: string })[], file: string) => `Do not answer anything now and do not change any file but the one below. For each intent of this conversation listed
here, work out what the conversation taught about answering its kind of question, and write it as JSON to ${file}:
{ "<intent id>": ${SCHEMA.replace(/\n/g, '\n  ')}, … }

${intents.map((i) => `${i.id}: "${i.title}" — ${i.intent}\n${i.turns.map((t) => `  - asked: ${t.question.slice(0, 300)}`).join('\n')}${i.standsOn ? `\n  what it stands on now (its concepts — improve these rather than write them again):\n${i.standsOn.split('\n').map((l) => `    ${l}`).join('\n')}` : ''}${i.pool.length ? `\n  the next questions it has, with what happened when each was offered:\n${i.pool.map(poolLine).join('\n')}` : ''}`).join('\n\n')}

${MEMORY_RULES}
Write nothing about this person that is not about answering the question.

${NEXT_RULES}

A check is the source of one JavaScript module, quick (well under a second) and only reading:
  export default async function (state, ctx) { … return { label: "said from what is there" } or null }
  ctx.history: the answers down to this step ({ question?, markdown }), the last one being the intent's answer
  ctx.context: what the session was started with
  ctx.services.query(source, sql, params?): rows read from a source, as the person may read them`

export function createIntentLearn(d: {
  intents: ReturnType<typeof createIntents>
  graphWrite?: (who: Record<string, unknown>, writes: { name: string; kind: string; body: unknown; reason: string; scope?: string; publish?: string }[]) => Promise<any[]>
  /** The conversation to clone: the session's analyst or composer (app-seam.ts conversationOf). */
  conversationOf: (session: string, role: 'composer' | 'analyst') => Promise<CloneOf | null>
  /** Where each session's learnt marks are kept (<projectDir>/sessions/<sid>/intents-learnt.json). */
  projectDir: string
  log?: (s: string) => void
  /** The concepts a person can see (knowledge.ts): what an intent stands on, as text; and the ones that read like a proposal. */
  concepts?: { text(names: string[], own: string[]): Promise<string>; search(proposals: { name: string; title: string; text: string }[], own: string[]): { name: string; title: string; text: string; scope: string }[][] }
  /** The person's own concept of what they want of every answer (knowledge.ts personConcept), and its parts now. */
  person?: { name(owner: string): string; parts(owner: string): string[] }
  /** The clone (tests script it); a real clone of the conversation otherwise. */
  clone?: typeof openClone
}) {
  const log = d.log ?? ((s: string) => console.log(s))
  const open = d.clone ?? openClone
  // Per session: whether a run is going, and the newest state of the session to learn from after it.
  const sessions = new Map<string, { running: Promise<void> | null; next: Answered | null }>()
  const marksFile = (sid: string) => join(d.projectDir, 'sessions', sid, 'intents-learnt.json')
  const marksOf = (sid: string): Record<string, string> => { try { return JSON.parse(readFileSync(marksFile(sid), 'utf8')) } catch { return {} } }
  const keepMarks = (sid: string, m: Record<string, string>) => { try { mkdirSync(join(d.projectDir, 'sessions', sid), { recursive: true }); writeFileSync(marksFile(sid), JSON.stringify(m)) } catch { /* learnt again next time */ } }

  async function run(a: Answered): Promise<void> {
    const marks = marksOf(a.session)
    const owner = ownerOf(a.who.id)
    // The intents with a turn not yet learnt from; read as the person meets them (title, intent, their variant).
    const dirty = a.intents.filter((i) => i.turns.length && marks[i.node] !== i.turns[i.turns.length - 1].qid)
    const nodes = (await Promise.all(dirty.map(async (i) => ({ i, n: await d.intents.node({ id: i.node, owner, caps: [] }) }))))
      .filter((x) => x.n && !x.n.agent && !x.n.system).map(({ i, n }) => ({ ...i, id: i.node, title: n!.title, intent: n!.intent, variant: n!.variant ?? null, pool: [] as NextEdge[], standsOn: '' }))
    for (const x of nodes) {
      x.pool = (await d.intents.next({ at: x.id, owner, caps: [] })).filter((e) => e.tag === 'suggested')
      if (x.variant?.concepts.length && d.concepts) x.standsOn = (await d.concepts.text(x.variant.concepts, [owner]).catch(() => '')).slice(0, 6000)
    }
    if (!nodes.length) return
    const byAnalyst = nodes.some((x) => x.turns.some((t) => t.agent === 'analyst'))
    const conversation = (await d.conversationOf(a.session, byAnalyst ? 'analyst' : 'composer')) ?? (await d.conversationOf(a.session, byAnalyst ? 'composer' : 'analyst'))
    if (!conversation) { log(`[intent] ${a.session.slice(0, 12)} · learn: no conversation to clone`); return }
    const stamp = Date.now().toString(36)
    const rel = `.intent-learn/${stamp}.json`, file = join(conversation.cwd, rel)
    mkdirSync(join(conversation.cwd, '.intent-learn'), { recursive: true })
    const transcript = nodes.flatMap((x) => x.turns.map((t) => `- asked: ${t.question}\n  answered (${t.agent}): ${t.answer.replace(/\s+/g, ' ').slice(0, 1500)}`)).join('\n')
    const clone = await open(conversation, transcript)
    const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } finally { rmSync(f, { force: true }) } }
    let all: any, t: { how: string; ms: number }
    try {
      t = await clone.turn(prompt(nodes, rel), { doneWhen: () => existsSync(file) })
      all = readJson(file)
      if (!all) { log(`[intent] ${a.session.slice(0, 12)} · learn: the clone wrote nothing readable (${t.how}, ${Math.round(t.ms / 1000)}s)`); return }
      // THE CONCEPTS IT PROPOSED, SEARCHED: one that already exists and says the same is reused, never written twice.
      const proposed = nodes.flatMap((x) => (Array.isArray(all?.[x.id]?.concepts?.new) ? all[x.id].concepts.new : []).map((k: any) => ({ name: String(k?.name ?? '').trim().toLowerCase(), title: String(k?.title ?? ''), text: String(k?.text ?? '') }))).filter((k) => k.name)
      const found = proposed.length && d.concepts ? d.concepts.search(proposed, [owner]) : []
      const hits = proposed.map((p, i) => ({ p, like: found[i] ?? [] })).filter((x) => x.like.length)
      if (hits.length) {
        const rel2 = `.intent-learn/${stamp}-2.json`, file2 = join(conversation.cwd, rel2)
        const t2 = await clone.turn(`Concepts that already exist read like some you proposed:\n${hits.map((x) => `- you proposed ${x.p.name} ("${x.p.title}"): ${x.like.map((c) => `\n    ${c.name} — ${c.title}: ${c.text.slice(0, 300)}`).join('')}`).join('\n')}\n\nWhere an existing one says the same thing exactly, reuse it: put its name in "use" and leave yours out of "new". Keep yours only where none does. Write the whole JSON again, with that changed, to ${rel2}.`, { doneWhen: () => existsSync(file2) })
        const again = readJson(file2)
        if (again) { all = again; t = { how: t.how, ms: t.ms + t2.ms } }
        log(`[intent] ${a.session.slice(0, 12)} · learn: ${hits.length} proposed concept${hits.length === 1 ? '' : 's'} read like existing ones — checked again (${Math.round(t2.ms / 1000)}s)`)
      }
    } finally { clone.close() }
    for (const x of nodes) {
      const r = all?.[x.id]
      if (r) await keep(a, owner, x, r, t).catch((e: any) => log(`[intent] ${a.session.slice(0, 12)} · learn ${x.id} failed: ${e?.message ?? e}`))
      marks[x.id] = x.turns[x.turns.length - 1].qid
    }
    keepMarks(a.session, marks)
  }

  /** What the clone said about one intent, kept. */
  async function keep(a: Answered, owner: string, x: IntentTurns & { id: string; title: string; variant: (IntentVariantBody & { whose: string }) | null }, r: any, t: { how: string; ms: number }) {
    if (r?.keep === false) { log(`[intent] ${a.session.slice(0, 12)} · learnt ${x.id}: not a request — nothing kept`); return }
    // New concepts, the person's own; each that holds for everyone suggested for everyone.
    const made: string[] = [], mine: string[] = [], reused: string[] = []
    for (const k of Array.isArray(r?.concepts?.new) ? r.concepts.new.slice(0, 12) : []) {
      const name = String(k?.name ?? '').trim().toLowerCase(), title = String(k?.title ?? '').trim(), text = String(k?.text ?? '').trim()
      if (!CONCEPT_NAME.test(name) || !title || !text || !d.graphWrite) continue
      // A concept of that name that is someone else's (the project's) is used, never overwritten — a change to it is theirs.
      const there = d.concepts?.search([{ name, title, text }], [owner])[0]?.find((c) => c.name === name)
      if (there && there.scope !== owner) { reused.push(name); continue }
      const why = `learnt answering "${x.title}" (session ${a.session})`
      try {
        await d.graphWrite({ ...a.who }, [{ name, kind: 'concept', body: { form: 'text', title, text, learnt: { intent: x.id, session: a.session } }, reason: why, scope: owner }])
        if (k?.for === 'me') { mine.push(name); continue }
        made.push(name)
        if (k?.everyone === true) await d.graphWrite({ ...a.who }, [{ name, kind: 'concept', body: null, reason: `${why} — it holds for everyone`, publish: 'global' }]).catch((e: any) => log(`[intent] ${name} was not suggested for everyone: ${e?.message ?? e}`))
      } catch (e: any) { log(`[intent] concept ${name} not written: ${e?.message ?? e}`) }
    }
    // What this person wants of every answer: their own concept, made of these — given with every question of theirs.
    if (mine.length && d.person && d.graphWrite) {
      const name = d.person.name(owner), parts = [...new Set([...d.person.parts(owner), ...mine])]
      await d.graphWrite({ ...a.who }, [{ name, kind: 'concept', body: { form: 'composed', title: 'How this person wants every answer', concepts: parts, learnt: { session: a.session } }, reason: `learnt from their answers (session ${a.session})`, scope: owner }])
        .catch((e: any) => log(`[intent] ${name} not written: ${e?.message ?? e}`))
    }
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((y) => typeof y === 'string' && y.trim()).map((y) => String(y).trim()) : [])
    const variant: IntentVariantBody = {
      concepts: [...new Set([...strs(r?.concepts?.use), ...reused, ...made])],
      process: String(r?.process ?? '').slice(0, 6000),
      show: String(r?.show ?? '').slice(0, 2000),
      paths: (Array.isArray(r?.paths) ? r.paths : []).filter((p: any) => p && typeof p.when === 'string' && typeof p.how === 'string').slice(0, 12).map((p: any) => ({ when: p.when.slice(0, 500), how: p.how.slice(0, 2000) })),
      about: { learntBy: t.how === 'forked' ? 'a clone of the conversation' : 'a fresh agent given the conversation', session: a.session },
    }
    // A variant the same as the one the person answers with is not written again (the node keeps one copy).
    const same = x.variant && JSON.stringify([[...x.variant.concepts].sort(), x.variant.process.trim()]) === JSON.stringify([[...variant.concepts].sort(), variant.process.trim()])
    const next: { asked: string; title?: string; label?: string; kind?: NextKind; check?: string | null }[] = []
    // Three new ones at most, each run, of whatever kinds.
    for (const kind of NEXT_KINDS) for (const s of ([] as any[]).concat(r?.next?.[kind] ?? [])) {
      if (next.length >= 3) break
      const asked = String(s?.asked ?? '').trim(); if (!asked) continue
      let check: string | null = typeof s?.check === 'string' && s.check.trim() ? s.check : null
      if (check) { try { await compileCheck(check) } catch (e: any) { log(`[intent] a check for "${asked.slice(0, 60)}" does not load — kept without it: ${e?.message ?? e}`); check = null } }
      next.push({ asked, label: String(s?.label ?? '').slice(0, 120) || undefined, kind, check })
    }
    const names: IntentParam[] = (Array.isArray(r?.names) ? r.names : []).filter((p: any) => p && typeof p.value === 'string' && typeof p.kind === 'string').slice(0, 20)
    const retire = (Array.isArray(r?.retire) ? r.retire : []).filter((y: any) => typeof y?.id === 'string' && typeof y?.why === 'string' && y.why.trim()).map((y: any) => ({ to: y.id, why: y.why }))
    const kept = await d.intents.close({ node: x.id, owner, by: a.who.email ?? a.who.id, session: a.session, madeHere: x.madeHere, title: typeof r?.title === 'string' ? r.title : undefined, intent: typeof r?.intent === 'string' ? r.intent : undefined, variant: same && !variant.paths.length ? null : variant, names, next, retire })
    log(`[intent] ${a.session.slice(0, 12)} · learnt ${x.id} "${x.title}" (${t.how}, ${Math.round(t.ms / 1000)}s): variant ${kept.variant ? `v${kept.variant.version}${kept.variant.changed ? '' : ' unchanged'}` : 'unchanged'} · ${made.length} new concept${made.length === 1 ? '' : 's'}${made.length ? ` (${made.join(', ')})` : ''}${reused.length ? ` · reused ${reused.join(', ')}` : ''}${mine.length ? ` · for every answer: ${mine.join(', ')}` : ''} · uses ${variant.concepts.length} · ${kept.names} name${kept.names === 1 ? '' : 's'} · ${kept.next?.length ?? 0} next${retire.length ? ` · ${retire.length} retired` : ''}${kept.renamed ? ' · renamed' : ''}`)
  }

  return {
    /** An answer given: the session learnt from in the background — now, or once the run going finishes. */
    answered(a: Answered): Promise<void> {
      const s = sessions.get(a.session) ?? { running: null, next: null }
      sessions.set(a.session, s)
      s.next = a   // the newest state of the session: whatever the run going does not cover
      if (s.running) return s.running
      const loop = async () => {
        while (s.next) {
          const now = s.next; s.next = null
          await run(now).catch((e: any) => log(`[intent] ${a.session.slice(0, 12)} · learning failed: ${e?.message ?? e}`))
        }
        s.running = null
      }
      s.running = loop()
      return s.running
    },
  }
}

/** A check's identity, to cache it compiled. */
export const checkId = (src: string) => createHash('sha256').update(src).digest('hex').slice(0, 16)
