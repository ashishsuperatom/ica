// CLOSING AN INTENT (docs/intent-graph.md): when the composer decides a message is another intent, the one before is
// closed — and what the conversation learnt about answering it is worked out by a CLONE of the conversation (ica/clone.ts),
// in the background: it has the whole context, the person is never kept waiting, and its work never enters the
// conversation. The clone writes one file; the engine keeps what it says:
//
//   - new concepts, atomic, in the composition graph as the person's own (provisional; theirs to use at once), each one
//     that holds for everyone suggested for everyone (an admin decides) — never copied into the node, only named;
//   - the person's variant of the node: the concepts it stands on, the way to answer it, how it is shown, its sub-paths;
//   - what the node is, for a node the analyst made in this session;
//   - the names in its questions (a customer, a site …), so later questions with other names have the same canonical form;
//   - the next intents it suggests, each with a check (an option function) saying when it makes sense.
//
// Most often nothing is new. One close at a time per session, in order.

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { cloneTurn, type CloneOf } from './ica/clone.js'
import type { IntentParam, IntentVariantBody } from '@superatom/platform-types'
import type { createIntents } from './intent.js'
import type { Who } from './identity.js'
import { compileCheck } from './intent-checks.js'

export interface Closing {
  session: string
  node: { id: string; title: string; intent: string; madeHere: boolean; variant: (IntentVariantBody & { whose: string }) | null }
  /** The intent's turns, in order: what was asked, what was answered, by which agent. */
  turns: { question: string; answer: string; agent: string }[]
  who: Who
  /** The conversation to clone (the agent that did most of the intent's work). */
  conversation: CloneOf | null
}

const CLONE_FILE = (id: string) => `.intent-close/${id}.json`
const CONCEPT_NAME = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*){1,3}$/

const prompt = (c: Closing, file: string) => `The person has moved on from the intent "${c.node.title}" (${c.node.intent}). Do not answer anything now and do not
change any file but the one below. Work out what this conversation taught about answering this kind of question, and write it
as JSON to ${file}:

{
  "keep": true or false — false when the exchange was not a request (a greeting, a thank-you): nothing else is kept then,
  "title": a few words naming the kind of question (not its values),
  "intent": what is asked for, in general terms,
  "names": the names in the questions that change from one asking to the next — [{ "value": "<as written>", "kind": "customer" | "site" | …: what it is a name of }] (not dates, periods, numbers or codes),
  "concepts": {
    "use": the names of the concepts you were given that the answer stands on,
    "new": what had to be found out or what the person said is right, that no concept you were given says — each ATOMIC (one
           thing, said once): [{ "name": "<area>/<thing>" in lower case, read the same by everyone in the organisation,
           "title": "...", "text": "...", "everyone": true when it holds for the whole organisation, false when only for this person }]
  },
  "process": the way to answer this kind of question, in words — what to read, the steps, the traps; not a program,
  "show": how the person wants the answer shown,
  "paths": where the way divides by the situation: [{ "when": "...", "how": "..." }],
  "next": what the person is likely to ask next after this answer: [{ "asked": "the question as they would ask it",
           "label": "a few words", "check": an option function deciding when it makes sense, or null }]
}

Most often nothing is new: then "new" and "paths" are empty and "process" says the way you used. Write nothing about this person
that is not about answering the question.

A check is the source of one JavaScript module, quick (well under a second) and only reading:
  export default async function (state, ctx) { … return { label: "said from what is there" } or null }
  ctx.history: the answers down to this step ({ question?, markdown }), the last one being this intent's answer
  ctx.context: what the session was started with
  ctx.services.query(source, sql, params?): rows read from a source, as the person may read them`

export function createIntentClose(d: {
  intents: ReturnType<typeof createIntents>
  graphWrite?: (who: Record<string, unknown>, writes: { name: string; kind: string; body: unknown; reason: string; scope?: string; publish?: string }[]) => Promise<any[]>
  log?: (s: string) => void
  /** The clone's turn (tests script it); a real clone of the conversation otherwise. */
  clone?: typeof cloneTurn
}) {
  const log = d.log ?? ((s: string) => console.log(s))
  const clone = d.clone ?? cloneTurn
  const queues = new Map<string, Promise<void>>()

  async function run(c: Closing): Promise<void> {
    if (!c.conversation) { log(`[intent] ${c.session.slice(0, 12)} · close ${c.node.id}: no conversation to clone — nothing learnt`); return }
    const id = `${c.node.id}-${Date.now().toString(36)}`
    const rel = CLONE_FILE(id), file = join(c.conversation.cwd, rel)
    mkdirSync(join(c.conversation.cwd, '.intent-close'), { recursive: true })
    const transcript = c.turns.map((t) => `- asked: ${t.question}\n  answered (${t.agent}): ${t.answer.replace(/\s+/g, ' ').slice(0, 1500)}`).join('\n')
    const t = await clone(c.conversation, prompt(c, rel), { transcript, doneWhen: () => existsSync(file) })
    let r: any
    try { r = JSON.parse(readFileSync(file, 'utf8')) } catch (e: any) { log(`[intent] ${c.session.slice(0, 12)} · close ${c.node.id}: the clone wrote nothing readable (${t.how}, ${Math.round(t.ms / 1000)}s) — ${e?.message ?? e}`); return }
    finally { rmSync(file, { force: true }) }
    if (r?.keep === false) { log(`[intent] ${c.session.slice(0, 12)} · close ${c.node.id}: not a request — nothing kept`); return }
    const owner = `user:${c.who.id.replace(/^user:/, '')}`
    // New concepts, the person's own; each that holds for everyone suggested for everyone.
    const made: string[] = []
    for (const k of Array.isArray(r?.concepts?.new) ? r.concepts.new.slice(0, 8) : []) {
      const name = String(k?.name ?? '').trim().toLowerCase(), title = String(k?.title ?? '').trim(), text = String(k?.text ?? '').trim()
      if (!CONCEPT_NAME.test(name) || !title || !text || !d.graphWrite) continue
      const why = `learnt answering "${c.node.title}" (session ${c.session})`
      try {
        await d.graphWrite({ ...c.who }, [{ name, kind: 'concept', body: { form: 'text', title, text }, reason: why, scope: owner }])
        made.push(name)
        if (k?.everyone === true) await d.graphWrite({ ...c.who }, [{ name, kind: 'concept', body: null, reason: `${why} — it holds for everyone`, publish: 'global' }]).catch((e: any) => log(`[intent] ${name} was not suggested for everyone: ${e?.message ?? e}`))
      } catch (e: any) { log(`[intent] concept ${name} not written: ${e?.message ?? e}`) }
    }
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => String(x).trim()) : [])
    const variant: IntentVariantBody = {
      concepts: [...new Set([...strs(r?.concepts?.use), ...made])],
      process: String(r?.process ?? '').slice(0, 6000),
      show: String(r?.show ?? '').slice(0, 2000),
      paths: (Array.isArray(r?.paths) ? r.paths : []).filter((p: any) => p && typeof p.when === 'string' && typeof p.how === 'string').slice(0, 12).map((p: any) => ({ when: p.when.slice(0, 500), how: p.how.slice(0, 2000) })),
      about: { learntBy: t.how === 'forked' ? 'a clone of the conversation' : 'a fresh agent given the conversation', session: c.session },
    }
    // A variant the same as the one the person answered with is not written again (the node keeps one copy).
    const same = c.node.variant && JSON.stringify([[...c.node.variant.concepts].sort(), c.node.variant.process.trim()]) === JSON.stringify([[...variant.concepts].sort(), variant.process.trim()])
    const next: { asked: string; title?: string; label?: string; check?: string | null }[] = []
    for (const s of Array.isArray(r?.next) ? r.next.slice(0, 6) : []) {
      const asked = String(s?.asked ?? '').trim(); if (!asked) continue
      let check: string | null = typeof s?.check === 'string' && s.check.trim() ? s.check : null
      if (check) { try { await compileCheck(check) } catch (e: any) { log(`[intent] a check for "${asked.slice(0, 60)}" does not load — kept without it: ${e?.message ?? e}`); check = null } }
      next.push({ asked, label: String(s?.label ?? '').slice(0, 120) || undefined, check })
    }
    const names: IntentParam[] = (Array.isArray(r?.names) ? r.names : []).filter((p: any) => p && typeof p.value === 'string' && typeof p.kind === 'string').slice(0, 20)
    const kept = await d.intents.close({ node: c.node.id, owner, by: c.who.email ?? c.who.id, session: c.session, madeHere: c.node.madeHere, title: typeof r?.title === 'string' ? r.title : undefined, intent: typeof r?.intent === 'string' ? r.intent : undefined, variant: same && !variant.paths.length ? null : variant, names, next })
    log(`[intent] ${c.session.slice(0, 12)} · closed ${c.node.id} "${c.node.title}" (${t.how}, ${Math.round(t.ms / 1000)}s): variant ${kept.variant ? `v${kept.variant.version}${kept.variant.changed ? '' : ' unchanged'}` : 'unchanged'} · ${made.length} concept${made.length === 1 ? '' : 's'}${made.length ? ` (${made.join(', ')})` : ''} · ${kept.names} name${kept.names === 1 ? '' : 's'} · ${kept.next?.length ?? 0} next${kept.renamed ? ' · renamed' : ''}`)
  }

  return {
    /** An intent closed: its learning worked out in the background, after any close of the same session still running. */
    close(c: Closing): Promise<void> {
      const prev = queues.get(c.session) ?? Promise.resolve()
      const p = prev.then(() => run(c)).catch((e: any) => log(`[intent] ${c.session.slice(0, 12)} · close ${c.node.id} failed: ${e?.message ?? e}`))
      queues.set(c.session, p)
      void p.finally(() => { if (queues.get(c.session) === p) queues.delete(c.session) })
      return p
    },
  }
}

/** A check's identity, to cache it compiled. */
export const checkId = (src: string) => createHash('sha256').update(src).digest('hex').slice(0, 16)
