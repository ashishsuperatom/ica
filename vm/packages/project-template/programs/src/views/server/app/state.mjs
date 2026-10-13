// What a block is asking, as a value — and the only ways it may change.
//
//     summary · pillar CEC · window Oct–Jan · by commitment · as bars
//
// A question is a focus (one capability), an ordered stack of filters, a grouping, a lens, a window (the time the
// focus is over — a parameter, never a filter) and assumptions (what-ifs, recorded with the answer).
//
// Operations in, state out. A click sends an operation; it is applied here against the whole question, because
// only the whole question can say whether it makes sense. What is kept is the state that came out — absolute,
// true whatever path led to it. Every rule lives here once, as a pure function, and is tested in Node.
//
// The rules need the model: which dimensions exist (dimensions.mjs) and which capability honours what
// (the loader's catalog). Both are passed in, so this file knows no focus by name.

import { DIMENSION, DIMENSIONS, beneath, lineage } from './dimensions.mjs'
import { addDays } from './windows.mjs'

export class NotAllowed extends Error {}

const dimOf = (key) => {
  const d = DIMENSION.get(key)
  if (!d) throw new NotAllowed(`There is no dimension called "${key}"`)
  return d
}
const find = (q, dim) => q.where.find((f) => f.dim === dim)

/** The stack in one canonical order: families as declared, then containment, then declaration order. */
export function ordered(where) {
  const declared = (key) => DIMENSIONS.findIndex((d) => d.key === key)
  const family = (f) => declared(lineage(f.dim)[0])
  const depth = (f) => lineage(f.dim).length
  return [...where].sort((a, b) => family(a) - family(b) || depth(a) - depth(b) || declared(a.dim) - declared(b.dim))
}

/** What one capability lets a question do — the loader gives this shape for every focus. */
const capabilityOf = (model, focus) => {
  const c = model.capabilities.get(focus)
  if (!c) throw new NotAllowed(`There is nothing to look at called "${focus}"`)
  return c
}

/**
 * Apply one operation. Refuses rather than guesses: a question that cannot be asked is an error with a sentence in
 * it, never a screen quietly showing something else.
 */
export async function apply(model, q, op, g) {
  const step = await applyOne(model, q, op, g)
  // A table's page is kept only while the question is the same: any other move shows every table from its first page.
  if (op.op !== 'page' && step.question.pages) step.question = normal({ ...step.question, pages: undefined })
  return step
}

async function applyOne(model, q, op, g) {
  const cap = capabilityOf(model, q.focus)
  switch (op.op) {
    case 'push': {
      const d = dimOf(op.dim)
      if (d.byOnly) throw new NotAllowed(`${d.label} is a period of the window, not a filter: set the window instead`)
      if (!cap.honours.includes(op.dim)) throw new NotAllowed(`${cap.label} is not broken down by ${d.label.toLowerCase()}: it honours ${cap.honours.map((k) => DIMENSION.get(k).label.toLowerCase()).join(', ')}`)
      const dropped = []
      let where = q.where
      const already = find(q, op.dim)
      if (already && JSON.stringify(valueOf(already.value)) === JSON.stringify(valueOf(op.value)) && !!op.not === (already.op === 'is not')) return { question: q, said: `already ${d.label.toLowerCase()} ${op.label ?? op.value}` }
      if (already) {
        const inner = beneath(op.dim).filter((k) => find(q, k))
        dropped.push(...inner.map((k) => `${DIMENSION.get(k).label} ${find(q, k).label ?? find(q, k).value}`))
        where = where.filter((f) => f.dim !== op.dim && !inner.includes(f.dim))
      }
      for (const o of lineage(op.dim).slice(0, -1)) {
        const held = find(q, o)
        if (held && held.op === 'is not') throw new NotAllowed(`Cannot narrow to a ${d.label.toLowerCase()} while ${DIMENSION.get(o).label} is excluded`)
      }
      where = [...where, { dim: op.dim, op: op.not ? 'is not' : 'is', value: valueOf(op.value), ...(op.label ? { label: op.label } : {}) }]
      const by = q.by === op.dim ? undefined : q.by
      return { question: normal({ ...q, where, by }), said: `${op.not ? 'excluded' : 'narrowed to'} ${d.label.toLowerCase()} ${op.label ?? op.value}`, dropped: dropped.length ? dropped : undefined }
    }
    case 'pop': {
      const d = dimOf(op.dim)
      if (!find(q, op.dim)) return { question: q, said: `${d.label} was not filtered` }
      const inner = beneath(op.dim).filter((k) => find(q, k))
      const where = q.where.filter((f) => f.dim !== op.dim && !inner.includes(f.dim))
      return { question: normal({ ...q, where }), said: `dropped ${d.label.toLowerCase()}`, dropped: inner.length ? inner.map((k) => `${DIMENSION.get(k).label} ${find(q, k).label ?? find(q, k).value}`) : undefined }
    }
    case 'up': {
      const innermost = ordered(q.where).reduce((deepest, f) => (!deepest || lineage(f.dim).length >= lineage(deepest.dim).length ? f : deepest), undefined)
      if (!innermost) return { question: q, said: 'nothing to widen' }
      return applyOne(model, q, { op: 'pop', dim: innermost.dim }, g)
    }
    case 'clear':
      return { question: normal({ ...q, where: [] }), said: 'cleared every filter' }
    case 'by': {
      if (!op.dim) return { question: normal({ ...q, by: undefined }), said: 'showed the whole' }
      const d = dimOf(op.dim)
      if (!(cap.by ?? []).includes(op.dim)) throw new NotAllowed(`${cap.label} cannot be broken down by ${d.label.toLowerCase()}${cap.by?.length ? `: only by ${cap.by.map((k) => DIMENSION.get(k).label.toLowerCase()).join(', ')}` : ''}`)
      if (find(q, op.dim)) throw new NotAllowed(`Already narrowed to one ${d.label.toLowerCase()}; there is nothing to break down`)
      return { question: normal({ ...q, by: op.dim }), said: `broke it down by ${d.label.toLowerCase()}` }
    }
    case 'as': {
      if (!(cap.lenses ?? ['table']).includes(op.lens)) throw new NotAllowed(`${cap.label} cannot be drawn as ${op.lens}`)
      return { question: normal({ ...q, as: op.lens }), said: `drew it as ${op.lens}` }
    }
    case 'focus': {
      // A new focus keeps the filters it honours: asking the same question of something else is the whole point.
      const next = capabilityOf(model, op.on)
      const kept = q.where.filter((f) => next.honours.includes(f.dim))
      const dropped = q.where.filter((f) => !next.honours.includes(f.dim)).map((f) => `${DIMENSION.get(f.dim).label} ${f.label ?? f.value}`)
      // A window travels where it means the same thing. Into a view over a range of days it travels as the days it
      // spans — a drill-down keeps the time it came from. Otherwise the new focus starts from its own default.
      let window
      if (q.window && next.window && q.window.kind === next.window.kind) window = q.window
      else if (q.window && next.window?.kind === 'range' && model.windows[q.window.kind]?.span) {
        const s = model.windows[q.window.kind].span(q.window, op.today ?? new Date().toISOString().slice(0, 10), model)
        window = { kind: 'range', from: s.from, through: addDays(s.to, -1) }
      } else window = await windowDefault(model, next, op.today, g)
      return { question: normal({ focus: op.on, where: kept, window }), said: `looked at ${next.label.toLowerCase()}`, dropped: dropped.length ? dropped : undefined }
    }
    case 'drill': {
      const from = q.by
      if (!from) throw new NotAllowed('Nothing is broken down, so there is nothing to drill into')
      const next = beneath(from).find((k) => (cap.by ?? []).includes(k))
      if (!next) throw new NotAllowed(`${DIMENSION.get(from).label} has nothing beneath it here`)
      return { question: normal({ ...q, by: next }), said: `went down to ${DIMENSION.get(next).label.toLowerCase()}` }
    }
    case 'window': {
      if (!cap.window) throw new NotAllowed(`${cap.label} has no time window`)
      const kind = op.window?.kind ?? cap.window.kind
      if (kind !== cap.window.kind) throw new NotAllowed(`${cap.label} is over ${cap.window.kind}, not ${kind}`)
      const problem = model.windows[kind]?.check?.(op.window, model)
      if (problem) throw new NotAllowed(problem)
      if (op.window?.compare !== undefined && typeof op.window.compare !== 'boolean') throw new NotAllowed('compare is on or off')
      if (op.window?.compare && kind !== 'range') throw new NotAllowed(`a ${kind} window cannot yet be compared with the period before`)
      const window = model.windows[kind].normalise ? model.windows[kind].normalise({ ...op.window, kind }, model) : { ...op.window, kind }
      return { question: normal({ ...q, window }), said: `set the window to ${model.windows[kind].words(window)}` }
    }
    case 'assume': {
      if (!cap.assume) throw new NotAllowed(`${cap.label} takes no assumptions`)
      const unknown = Object.keys(op.assume ?? {}).filter((k) => !(k in cap.assume))
      if (unknown.length) throw new NotAllowed(`${cap.label} has no assumption called ${unknown.join(', ')}: it takes ${Object.keys(cap.assume).join(', ')}`)
      const assume = { ...(q.assume ?? {}), ...op.assume }
      for (const k of Object.keys(assume)) if (assume[k] === null || assume[k] === undefined) delete assume[k]
      return { question: normal({ ...q, assume: Object.keys(assume).length ? assume : undefined }), said: Object.keys(op.assume ?? {}).length ? `assumed ${Object.entries(op.assume).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')}` : 'dropped the assumptions' }
    }
    case 'page': {
      // A table is read a page at a time: which page, and the order the source reads it in (a column, "-" for largest first).
      if (typeof op.block !== 'string' || !op.block) throw new NotAllowed('Say which table to turn the page of')
      if (!Number.isInteger(op.page) || op.page < 1) throw new NotAllowed('A page is a whole number from 1')
      if (op.order !== undefined && !/^-?[a-z_][a-z0-9_]*$/i.test(String(op.order))) throw new NotAllowed('An order is a column, with "-" for largest first')
      const pages = { ...(q.pages ?? {}), [op.block]: { page: op.page, ...(op.order ? { order: String(op.order) } : q.pages?.[op.block]?.order ? { order: q.pages[op.block].order } : {}) } }
      return { question: normal({ ...q, pages }), said: `page ${op.page}${op.order ? `, ordered by ${String(op.order).replace(/^-/, '')}${String(op.order).startsWith('-') ? ', largest first' : ''}` : ''}` }
    }
    default:
      throw new NotAllowed(`There is no operation "${op.op}"`)
  }
}

/** Apply several operations in order, stopping at the first that cannot be done. `g` lets a focus's window default ask where the data is. */
export async function applyAll(model, q, ops, g) {
  let question = q
  const said = [], dropped = []
  for (const op of ops) {
    const step = await apply(model, question, op, g)
    question = step.question
    said.push(step.said)
    if (step.dropped) dropped.push(...step.dropped)
  }
  return { question, said: said.join(', '), dropped: dropped.length ? dropped : undefined }
}

/** The question in words, the way a block header reads it. */
export function inWords(model, q) {
  const parts = ordered(q.where ?? []).map((f) => {
    const d = DIMENSION.get(f.dim)
    const not = f.op === 'is not' ? 'not ' : ''
    // A flag reads as its name when it is Yes, and as "not <name>" when it is No or when it is denied.
    if (d.flag) return `${not || /^(no|false|f)$/i.test(String(f.label ?? f.value)) ? 'not ' : ''}${d.label.toLowerCase()}`
    return `${d.label.toLowerCase()} ${not}${f.label ?? f.value}`
  })
  if (q.by) parts.push(`by ${DIMENSION.get(q.by).label.toLowerCase()}`)
  if (q.window && model.windows[q.window.kind]) parts.push(model.windows[q.window.kind].words(q.window))
  if (q.assume && Object.keys(q.assume).length) parts.push(`assuming ${Object.entries(q.assume).map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ')}`)
  return parts.join(' · ')
}

/** A filter's value: one key as a string, or several keys (one label recorded more than once) as a sorted list. */
export function valueOf(v) {
  if (Array.isArray(v)) { const keys = [...new Set(v.map(String))].sort(); return keys.length === 1 ? keys[0] : keys }
  return String(v)
}

/** The empty question about something, as its capability starts it. `g` lets the window default ask where the data is. */
export async function asking(model, focus, today, overrides = {}, g) {
  const cap = capabilityOf(model, focus)
  return normal({ focus, where: cap.start?.where ?? [], window: await windowDefault(model, cap, today, g), ...overrides })
}

/**
 * A capability's window as it starts: its own default — a value, or a function of today that may be async and may
 * ask the domains' programs through `g` (a default window is where the data is, not where the calendar is) — else the kind's
 * default for today. The other kinds stay synchronous.
 */
export async function windowDefault(model, cap, today = new Date().toISOString().slice(0, 10), g) {
  if (!cap.window) return undefined
  const kind = cap.window.kind
  const own = typeof cap.window.default === 'function' ? await cap.window.default(today, model, g) : cap.window.default
  return { kind, ...(own ?? model.windows[kind].default(today, model)) }
}

/** Whether two questions are the same question, whatever path each took. */
export const same = (a, b) => JSON.stringify(normal(a)) === JSON.stringify(normal(b))

/** One shape per question, so a state can be compared, cached and put in an address. */
export function normal(q) {
  const out = { focus: q.focus, where: ordered(q.where ?? []).map((f) => ({ dim: f.dim, op: f.op ?? 'is', value: valueOf(f.value), ...(f.label ? { label: f.label } : {}) })) }
  if (q.by) out.by = q.by
  if (q.as) out.as = q.as
  if (q.window) out.window = q.window
  if (q.assume && Object.keys(q.assume).length) out.assume = q.assume
  if (q.pages && Object.keys(q.pages).length) out.pages = q.pages
  return out
}
