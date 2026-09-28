// This project's application, as the engine hands it every `app:` payload. The engine gives it the seams — the domains'
// programs (ctx.domain), the data manager, the composer, who is asking, a way to reply — and nothing else.
//
//   app:catalog                      → app:catalog     the dimensions, capabilities, roots
//   app:ask     { question }         → app:answer      an answer for exactly that question
//   app:move    { question, ops }    → app:answer      the question after the operations, and its answer
//   app:start   { focus, where? }    → app:answer      a capability as it opens
//   app:members { dim, typed }       → app:members     members of a dimension holding the typed words
//   app:say     { text, threadId, question, title, headline, notes, asked[], path[] } → app:said { markdown, blocks, calls, queries, ms }  the thread's composer answers in prose; queries are the parts that did not stand on the model
//   app:about                        → app:about       the sources, the programs the views read, the application
//   app:reload                       → app:reloaded    read the capabilities again (a coding agent changed them)
//
// Every reply carries the request's reqId. A refusal is app:refused with the sentence, never a different answer.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCapabilities, catalogOf } from './loader.mjs'
import { applyAll, asking, normal, inWords, NotAllowed } from './state.mjs'
import { WINDOWS, financialCalendars } from './windows.mjs'
import { DIMENSION } from './dimensions.mjs'
import { answer } from './resolve.mjs'
import { FACTS } from './facts.mjs'
import { factsFor } from './read.mjs'
import { PROJECT, SCENARIOS, members } from './project.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
let model = null
let loading = null

async function load(ctx, fresh = false) {
  const { capabilities, problems } = await loadCapabilities(join(HERE, 'capabilities'), ctx, { fresh })
  // The financial calendars, as the windows need them: the financial year a day falls in and its months, from the
  // organisation's setting (the month a financial year starts in). Read once, here; never assumed.
  let calendars = { FinancialYear: [], FinancialMonth: [] }
  try { calendars = financialCalendars(await factsFor(ctx).setting('financial-year-first-month'), todayOf(ctx)) } catch (e) { problems.push(`the financial calendars could not be made: ${e.message}`) }
  model = { capabilities, problems, windows: WINDOWS, calendars, loadedAt: new Date().toISOString() }
  if (problems.length) console.warn(`[app] capabilities loaded with problems:\n  ${problems.join('\n  ')}`)
  else console.log(`[app] ${capabilities.size} capabilities loaded`)
  return model
}

const todayOf = (ctx) => ctx.today ?? new Date().toISOString().slice(0, 10)

export async function handle(payload, ctx) {
  const t = String(payload.t)
  if (t === 'app:reload') { loading = load(ctx, true); await loading; return ctx.reply({ t: 'app:reloaded', problems: model.problems, capabilities: model.capabilities.size }) }
  if (!model) { loading ??= load(ctx); await loading }
  const today = todayOf(ctx)
  try {
    if (t === 'app:catalog') return ctx.reply({ t: 'app:catalog', project: PROJECT, scenarios: SCENARIOS, ...catalogOf(model), problems: model.problems, today })
    if (t === 'app:members') {
      // Members to choose from: a small list whole, a long one searched in the source (at most 20), an attribute's
      // values as the source counts them. Nobody picks from thousands.
      const d = DIMENSION.get(payload.dim)
      if (!d?.members) throw new NotAllowed(`${payload.dim} has no members to choose from`)
      const facts = factsFor(ctx)
      const typed = String(payload.typed ?? '')
      let found
      if (d.members.values) found = d.members.values.filter((v) => v.toLowerCase().includes(typed.toLowerCase().trim())).map((v) => ({ key: v, label: v }))
      else if (d.members.list || d.members.search) found = await members(d, typed, (f, p) => facts.read(f, p))
      else {
        const rows = await facts.read(d.members.fact, { today: todayOf(ctx), totals: [d.members.value], where: [] })
        const words = typed.toLowerCase().split(/\s+/).filter(Boolean)
        found = rows.data.rows.map((r) => r[d.members.value]).filter((v) => v != null && words.every((w) => String(v).toLowerCase().includes(w))).map((v) => ({ key: String(v), label: String(v) }))
      }
      // The same name recorded more than once is ONE choice for a person: the option carries every key that reads that way.
      const byLabel = new Map()
      for (const x of found) { if (!byLabel.has(x.label)) byLabel.set(x.label, { label: x.label, keys: [] }); byLabel.get(x.label).keys.push(x.key) }
      const matches = [...byLabel.values()].map((m) => ({ key: m.keys.length === 1 ? m.keys[0] : m.keys, keys: m.keys, label: m.label, ...(m.keys.length > 1 ? { recorded: m.keys.length } : {}) }))
      return ctx.reply({ t: 'app:members', dim: payload.dim, matches })
    }
    if (t === 'app:about') {   // where the numbers come from: the sources, the programs the views read, the application
      const sources = typeof ctx.sources === 'function' ? await ctx.sources().catch((e) => [{ id: '?', error: e.message }]) : []
      const programs = Object.entries(FACTS).filter(([, f]) => f.paged).map(([fact, f]) => ({ fact, program: f.program, domain: f.domain, grain: f.grain }))
      const settings = Object.entries(await factsFor(ctx).settings()).map(([name, value]) => ({ name, value }))
      return ctx.reply({ t: 'app:about', sources: sources.map((s) => ({ id: s.id, kind: s.kind, dialect: s.dialect, description: s.description ?? '' })), programs, settings,
        application: { capabilities: model.capabilities.size, loadedAt: model.loadedAt, problems: model.problems }, today })
    }
    if (t === 'app:say') {   // a typed question, answered in prose by the composer, inside what the person is looking at
      if (typeof ctx.say !== 'function') throw new NotAllowed('This engine has no composer')
      const text = String(payload.text ?? '').trim()
      if (!text) throw new NotAllowed('Say what you want to know')
      const context = contextOf(model, payload)
      const qid = String(payload.qid ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`)
      // The thread is the composer's session: follow-ups keep their memory there.
      const said = await ctx.say(text, context, { qid, threadId: String(payload.threadId ?? 'thread'), focus: payload.question?.focus ?? null })
      if (said.markdown == null) return ctx.reply({ t: 'app:refused', reason: 'No answer was written in time. Ask it another way, or narrower.' })
      return ctx.reply({ t: 'app:said', text, qid, markdown: said.markdown, blocks: said.blocks ?? [], agent: said.agent ?? null, calls: said.calls ?? [], queries: said.queries ?? [], ms: said.ms, question: payload.question ?? null, today })
    }
    // A window default may ask where the data is: the domains' programs, the same facts the views read.
    const facts = factsFor(ctx)
    const g = { read: (fact, params) => facts.read(fact, params), today }
    let question, said, dropped
    if (t === 'app:start') { question = await asking(model, payload.focus, today, payload.where ? { where: payload.where } : {}, g); said = `opened ${model.capabilities.get(payload.focus).label.toLowerCase()}` }
    else if (t === 'app:ask') question = normal(payload.question)
    else if (t === 'app:move') { const r = await applyAll(model, normal(payload.question), (payload.ops ?? []).map((o) => ({ ...o, today })), g); question = r.question; said = r.said; dropped = r.dropped }
    else return ctx.reply({ t: 'app:refused', reason: `the application has no "${t}"` })
    if (!model.capabilities.has(question.focus)) throw new NotAllowed(`There is nothing to look at called "${question.focus}"`)
    const a = await answer(model, question, { ...ctx, today })
    return ctx.reply({ t: 'app:answer', ...a, said, dropped })
  } catch (e) {
    if (e instanceof NotAllowed) return ctx.reply({ t: 'app:refused', reason: e.message })
    console.error('[app]', e)
    return ctx.reply({ t: 'app:error', error: e.message })
  }
}

/** What the person is looking at, in words the composer can hold: the block's question, what it showed, the blocks above. */
function contextOf(m, p) {
  const one = (b, i) => {
    if (!b) return ''
    const q = b.question ? normal(b.question) : null
    const cap = q ? m.capabilities.get(q.focus) : null
    const lines = [`${i}. ${b.title ?? cap?.label ?? q?.focus ?? 'a screen'}${q ? ` — ${inWords(m, q) || 'no filters'}` : ''}`]
    if (cap?.whenToUse) lines.push(`   about: ${cap.whenToUse}`)
    if (Array.isArray(b.headline) && b.headline.length) lines.push(`   shows: ${b.headline.map((h) => `${h.label} ${h.value ?? '—'}${h.unit && h.unit !== 'text' ? ` ${h.unit}` : ''}`).join(' · ')}`)
    if (Array.isArray(b.notes) && b.notes.length) lines.push(`   notes: ${b.notes.slice(0, 4).join('; ')}`)
    // What the screen read: the programs and their arguments, to change rather than to rediscover.
    for (const a of (Array.isArray(b.asked) ? b.asked : []).filter((x) => x && typeof x === 'object' && x.question).slice(0, 4))
      lines.push(`   read: ${JSON.stringify(a.question)}${typeof a.rows === 'number' ? ` → ${a.rows} rows` : ''}`)
    return lines.join('\n')
  }
  const path = Array.isArray(p.path) ? p.path : []
  const current = { question: p.question, title: p.title, headline: p.headline, notes: p.notes, asked: p.asked }
  const all = [...path, current].filter(Boolean)
  return all.length ? all.map((b, i) => one(b, i + 1)).join('\n') + `\nThe last one is the screen the question is asked from.` : 'A fresh start; no screen yet.'
}
void inWords

export default { handle }
