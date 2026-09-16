// ── QUESTIONS AND THE RULES (§4, §5) ────────────────────────────────────────────────────────────────────────
//
// check() turns a question into a plan or refuses it. A plan is the only thing the evaluator runs, so every answer
// has passed every rule. A refusal names the rule, the object or arrow, and — where the question left a choice — the
// paths to choose between.

import { normalise, pathsFrom, pathText } from './paths.js'
import { addDays, endsPeriod, keyOf, monthsIn, periodOf, periodsBetween, shiftPeriods, startsPeriod, builtIn, type CalendarDef } from './calendar.js'
import { arrow, baseUnits, sameUnits, timeArrow, timesUnits, unitText, walk, type Measure, type Schema, type Units } from './schema.js'

// ── The question ──

/** Group by an object reached from each fact (optionally saying by which path, for all facts or per fact), by an
 *  attribute of the one fact that has it, or by an attribute `of` an object each fact reaches (its path as for `to`). */
export type Target = { to: string; via?: string[] | Record<string, string[]> } | { attribute: string; of?: string; via?: string[] | Record<string, string[]> }
/** Keep rows whose target is one of `in` — or, with `under`, anywhere below one of them along that self arrow. */
/** What a filter keeps: members in or not in a list, rows with nothing at the end of a partial path (or with something),
 *  or members whose label contains or starts with some text, ignoring case. One of them. */
export type Condition = { in: string[] } | { notIn: string[] } | { none: boolean } | { contains: string } | { startsWith: string }
  /** Values in [from, to): dates as YYYY-MM-DD, or numbers — for attributes that are dates or numbers. */
  | { range: { from?: string | number; to?: string | number } }
/** A filter keeps rows by one condition on a target — or keeps them to a named condition of the schema, reached from the
 *  fact along `via` when the fact reaches its object more than one way. */
export type Filter = (({ to: string; via?: string[] | Record<string, string[]>; under?: string } | { attribute: string; of?: string; via?: string[] | Record<string, string[]> }) & Condition)
  | { condition: string; via?: string[] | Record<string, string[]> }

export interface Question {
  /** `Fact.measure`, or an expression over them: `[A.x] / [B.y]`, over measures of any facts that share a grouping. */
  measures: string[]
  by?: Target[]
  where?: Filter[]
  /** [from, to): dates. */
  span?: { from: string; to: string }
  /** The currency money is reported in; the schema's conversion supplies the rates. */
  currency?: string
  /** The day the answer is given as of. A measured value — an exchange rate — dated after it is not known yet. */
  asOf?: string
  /** Named conditions a fact is always kept to, set aside for this question. */
  without?: string[]
  order?: { by: string; desc?: boolean }
  limit?: number
  /** Keep only groups whose output meets a condition — applied before order and limit. */
  having?: Array<{ output: string; op: '<' | '<=' | '>' | '>=' | '=' | '!='; value: number }>
  /** Also answer at these coarser groupings: each a subset of the targets, [] for the grand total. */
  totals?: string[][]
  /** Each of these outputs as a share of its total within a coarser grouping. */
  share?: { outputs: string[]; within: string[] }
  /** Along the calendar grouped by: every period of the span, the empty ones as zero for what adds up. */
  fill?: boolean
  /** Along the calendar grouped by: running totals, starting again at each period of `reset` (a coarser calendar). */
  cumulative?: { reset?: string }
  /** Along the calendar grouped by: each period over it and the `window - 1` periods before; `average` divides by the
   *  window. A computed output is computed from its parts' windows. */
  rolling?: { window: number; average?: boolean }
  /** With order and limit: keep that many groups within each group of these targets — the top three per pillar. */
  limitPer?: string[]
  /** The same question over the span moved back, side by side with the change. */
  compare?: { back: { years?: number; months?: number; days?: number; periods?: number } } | { span: { from: string; to: string } }
}

// ── The plan ──

/** Where a row leads along a path; an attribute of the row itself; or an attribute of the element a path leads to. */
export type Step = { path: string[] } | { attribute: string; at?: string[] }
export interface FactPlan {
  fact: string
  measures: string[]
  by: Step[]
  where: Array<Step & Condition & { under?: string }>
  time?: { role: string; level: string; calendar: string }
  /** When grouped rows span several instants, a stock is taken at the last or first, or averaged. */
  stockOverTime: boolean
  /** `on`: the one day every row converts on, when it is not the end of the span — a fact with no time, answered today. */
  convert?: { currency: string; at: 'row' | 'end'; on?: string }
}
export type Expr = { ref: string } | { op: '+' | '-' | '*' | '/'; args: [Expr, Expr] }
export interface Plan {
  columns: Array<{ name: string; unit?: string }>
  targets: string[]
  outputs: Array<{ name: string; expr: Expr; unit: string }>
  facts: FactPlan[]
  span?: { from: string; to: string }
  asOf?: string
  order?: Question['order']
  limit?: number
  having?: Question['having']
  /** The measures that add up over every arrow and over time — flows summed or counted: an empty group of them is zero. */
  additive?: string[]
  /** The same measures at coarser groupings, each its own plan: a ratio or a distinct count is recomputed, never added. */
  totals?: Array<{ by: string[]; plan: Plan }>
  share?: { outputs: string[]; within: string[]; plan: Plan }
  compare?: { back: { years?: number; months?: number; days?: number; periods?: number } | null; plan: Plan; time?: { target: number; level: string; def: CalendarDef; periods: number } }
  /** Work along the calendar grouped by, on the facts' values before outputs are computed. `keep` is the span shown. */
  along?: { target: number; def: CalendarDef; keep: { from: string; to: string }; fill: boolean; cumulative?: { reset?: CalendarDef }; rolling?: { window: number; average: boolean } }
  limitPer?: number[]
  notes: string[]
}

export type Verdict = { ok: true; plan: Plan } | { ok: false; rule: string; reason: string; choices?: Array<{ target: string; fact: string; paths: string[] }> }

const refuse = (rule: string, reason: string, choices?: Array<{ target: string; fact: string; paths: string[] }>): Verdict => ({ ok: false, rule, reason, ...(choices ? { choices } : {}) })

// ── Measures and expressions ──

export function parseExpr(text: string): Expr {
  const tokens = text.match(/\[[^\]]+\]|[A-Za-z_][\w ]*\.[\w ]*\w|[-+*/()]/g) ?? []
  let i = 0
  const atom = (): Expr => {
    const t = tokens[i++]
    if (t === '(') { const e = sum(); if (tokens[i++] !== ')') throw new Error(`"${text}": a bracket is not closed`); return e }
    if (!t || '+-*/)'.includes(t)) throw new Error(`"${text}" is not an expression of measures`)
    return { ref: t.replace(/^\[|\]$/g, '').trim() }
  }
  const product = (): Expr => { let e = atom(); while (tokens[i] === '*' || tokens[i] === '/') { const op = tokens[i++] as '*' | '/'; e = { op, args: [e, atom()] } } return e }
  const sum = (): Expr => { let e = product(); while (tokens[i] === '+' || tokens[i] === '-') { const op = tokens[i++] as '+' | '-'; e = { op, args: [e, product()] } } return e }
  const e = sum()
  if (i !== tokens.length) throw new Error(`"${text}" is not an expression of measures`)
  return e
}
const refs = (e: Expr): string[] => ('ref' in e ? [e.ref] : [...refs(e.args[0]), ...refs(e.args[1])])

function measureOf(s: Schema, ref: string): { fact: string; name: string; m: Measure } | undefined {
  const dot = ref.indexOf('.')
  const fact = ref.slice(0, dot), name = ref.slice(dot + 1)
  const m = s.objects[fact]?.kind === 'fact' ? s.objects[fact].measures?.[name] : undefined
  return m && { fact, name, m }
}

// ── Reaching a target from a fact (§5 A, D1) ──

type Reach = { step: Step } | { refuse: Verdict } | { choose: string[] } | { none: string }

function reach(s: Schema, fact: string, t: Target | Filter, facts: string[]): Reach {
  if ('attribute' in t) {
    if (!t.of || t.of === fact) {
      if (s.objects[fact].attributes?.[t.attribute]) return { step: { attribute: t.attribute } }
      if (t.of) return { refuse: refuse('A1', `${fact} has no attribute "${t.attribute}" — its attributes are ${Object.keys(s.objects[fact].attributes ?? {}).join(', ') || 'none'}`) }
      const owner = facts.find((f) => s.objects[f].attributes?.[t.attribute])
      if (owner) return { none: `${t.attribute} is an attribute of ${owner}` }
      const holders = Object.entries(s.objects).filter(([n, o]) => o.kind !== 'fact' && o.attributes?.[t.attribute]).map(([n]) => n)
      return { refuse: refuse('A1', holders.length ? `"${t.attribute}" is an attribute of ${holders.join(' and ')} — say which: {"attribute": "${t.attribute}", "of": "${holders[0]}"}` : `no fact asked about has the attribute "${t.attribute}"`) }
    }
    if (!s.objects[t.of]) return { refuse: refuse('A1', `there is no ${t.of}`) }
    if (!s.objects[t.of].attributes?.[t.attribute]) return { refuse: refuse('A1', `${t.of} has no attribute "${t.attribute}" — its attributes are ${Object.keys(s.objects[t.of].attributes ?? {}).join(', ') || 'none'}`) }
    const r = reach(s, fact, { to: t.of, via: t.via }, facts)
    return 'step' in r ? { step: { attribute: t.attribute, at: (r.step as { path: string[] }).path } } : r
  }
  if ('condition' in t) return { refuse: refuse('Q', `the condition "${t.condition}" is kept to, not grouped by`) }
  if (!s.objects[t.to]) return { refuse: refuse('A1', `there is no ${t.to}`) }
  const reaching = pathsFrom(s, fact).filter((p) => p.object === t.to)
  // A path through a self arrow (a manager, a parent) leads to a different element of the same kind — the person's manager,
  // the parent subsidiary. It is taken when named, and never makes a plain reading ambiguous.
  const direct = reaching.filter((p) => !walk(s, fact, p.steps)!.walked.some((a) => a.kind === 'self'))
  const all = direct.length ? direct : reaching
  const via = Array.isArray(t.via) ? t.via : t.via?.[fact]
  if (via) {
    // A path is a list of links, each one name: ["person", "pillar"].
    // A path given for every fact belongs to the facts that have it; one that no fact has is not a path.
    if (!walk(s, fact, via) && (!Array.isArray(t.via) || !facts.some((f) => walk(s, f, via)))) {
      const bad = via.find((_, i) => !walk(s, fact, via.slice(0, i + 1)))!
      const at = walk(s, fact, via.slice(0, via.indexOf(bad)))!.object
      return { refuse: refuse('A1', `${at} has no link "${bad}" — its links are ${Object.keys(s.objects[at].arrows ?? {}).join(', ')}; a path lists one link per step, e.g. ["person", "pillar"]`) }
    }
    const n = walk(s, fact, via)?.object === t.to ? normalise(s, fact, via) : undefined
    if (n && reaching.some((p) => pathText(p.steps) === pathText(n))) return { step: { path: n } }
    // A path said for all facts belongs to the facts that have it; the others reach the target their own one way.
    if (!Array.isArray(t.via) || (all.length !== 1 && !s.objects[fact].defaults?.[t.to])) {
      return { refuse: refuse('A1', `${fact} has no path ${via.join('.')} to ${t.to}`) }
    }
  }
  if (all.length === 1) return { step: { path: all[0].steps } }
  const d = s.objects[fact].defaults?.[t.to]
  if (all.length > 1 && d) return { step: { path: normalise(s, fact, d) } }
  if (all.length > 1) return { choose: all.map((p) => pathText(p.steps)) }

  // Not reached along arrows. Say why in the schema's own terms.
  const target = s.objects[t.to]
  if (target.kind === 'calendar') {
    const time = timeArrow(s, fact)
    return { none: time ? `${fact} is kept by ${s.objects[time.to].level}, and time only rolls up to coarser levels` : `${fact} has no time` }
  }
  const fansOut = pathsFrom(s, t.to).some((p) => Object.values(s.objects[fact].arrows ?? {}).some((a) => (typeof a === 'string' ? a : a.to) === p.object))
  return { none: fansOut ? `${fact} does not reach ${t.to}: ${t.to} reaches what ${fact} is kept by, so going from it back to ${fact} would count rows more than once` : `${fact} does not reach ${t.to}` }
}

const targetText = (t: Target | Filter) => ('condition' in t ? t.condition : 'attribute' in t ? (t.of ? `${t.of}.${t.attribute}` : t.attribute) : t.to + (Array.isArray(t.via) ? ` by ${t.via.join('.')}` : ''))
const stepText = (x: Step) => ('attribute' in x ? (x.at?.length ? `${pathText(x.at)}.${x.attribute}` : x.attribute) : pathText(x.path))

// ── check ──

/** `today`, when known, lets a comparison of a span still running be like for like. */
export function check(s: Schema, q: Question, context: { today?: string } = {}): Verdict {
  if (!q.measures?.length) return refuse('Q', 'a question asks for at least one measure')
  const outputs: Plan['outputs'] = []
  const used = new Map<string, { fact: string; name: string; m: Measure }>()
  for (const text of q.measures) {
    let expr: Expr
    try { expr = parseExpr(text) } catch (e: any) { return refuse('Q', e.message) }
    for (const r of refs(expr)) {
      const found = measureOf(s, r)
      if (!found) return refuse('Q', `there is no measure ${r}`)
      used.set(r, found)
    }
    outputs.push({ name: text, expr, unit: '' })
  }
  const facts = [...new Set([...used.values()].map((u) => u.fact))]
  const notes: string[] = []
  const choices: Array<{ target: string; fact: string; paths: string[] }> = []
  const plans: FactPlan[] = facts.map((fact) => ({ fact, measures: [...used.values()].filter((u) => u.fact === fact).map((u) => u.name), by: [], where: [], stockOverTime: false }))

  // A1–A3, C1, D1: every fact reaches every target.
  for (const p of plans) {
    for (const t of q.by ?? []) {
      const r = reach(s, p.fact, t, facts)
      if ('refuse' in r) return r.refuse
      if ('none' in r) return refuse(facts.length > 1 ? 'C1' : 'A1', facts.length > 1 ? `${r.none}, so ${facts.join(' and ')} cannot be put side by side by ${targetText(t)}` : r.none)
      if ('choose' in r) choices.push({ target: targetText(t), fact: p.fact, paths: r.choose })
      else p.by.push(r.step)
    }
  }
  // A1, C3: filters. A filter on another fact's version or attribute is about that fact alone. A named condition is its
  // filters, reached from the fact through the object it is about; a fact's own conditions apply unless set aside.
  for (const c of q.without ?? []) if (!s.conditions?.[c]) return refuse('A1', `"${c}" is not a condition of the schema — its conditions are ${Object.keys(s.conditions ?? {}).join(', ') || 'none'}`)
  for (const p of plans) {
    const named = (q.where ?? []).filter((w): w is { condition: string } => 'condition' in w).map((w) => w.condition)
    const always = (s.objects[p.fact].keptTo ?? []).filter((c) => !named.includes(c) && !(q.without ?? []).includes(c))
    if (always.length) notes.push(`${p.fact}: kept to ${always.map((c) => s.conditions?.[c]?.description ? `${c} (${s.conditions[c].description})` : c).join('; ')}`)
    const asked: Array<{ w: Filter; own: boolean }> = [...(q.where ?? []).map((w) => ({ w, own: false })), ...always.map((c) => ({ w: { condition: c } as Filter, own: true }))]
    for (const { w, own } of asked) {
      if ('condition' in w) {
        const def = s.conditions?.[w.condition]
        if (!def) return refuse('A1', `"${w.condition}" is not a condition of the schema — its conditions are ${Object.keys(s.conditions ?? {}).join(', ') || 'none'}`)
        let base: string[] = []
        // A condition about another fact asked about is about that fact alone.
        if (s.objects[def.on]?.kind === 'fact' && def.on !== p.fact) {
          if (facts.includes(def.on)) continue
          return refuse('C3', `the condition "${w.condition}" is about ${def.on}, and no measure asked about is from it`)
        }
        if (def.on !== p.fact) {
          const r = reach(s, p.fact, { to: def.on, via: w.via }, facts)
          if ('refuse' in r) return r.refuse
          if ('none' in r) { if (own) continue; return refuse('C3', `${r.none}, so it cannot be kept to ${w.condition}`) }
          if ('choose' in r) { choices.push({ target: def.on, fact: p.fact, paths: r.choose }); continue }
          base = (r.step as { path: string[] }).path
        }
        for (const cw of def.where as Filter[]) {
          if ('condition' in cw) return refuse('Q', `the condition "${w.condition}" names another condition; a condition keeps to filters on ${def.on}`)
          // Each filter of the condition is reached from its object, then from the fact through it.
          const inner = reach(s, def.on, cw, [def.on])
          if (!('step' in inner)) return refuse('Q', `the condition "${w.condition}": ${'refuse' in inner ? inner.refuse.ok ? '' : inner.refuse.reason : 'none' in inner ? inner.none : `${def.on} reaches ${targetText(cw)} by ${inner.choose.join(' or ')} — the condition must say which`}`)
          const st = inner.step
          const step: Step = 'attribute' in st ? (base.length || st.at ? { attribute: st.attribute, at: normalise(s, p.fact, [...base, ...(st.at ?? [])]) } : { attribute: st.attribute }) : { path: normalise(s, p.fact, [...base, ...st.path]) }
          const bad = addFilter(s, p, step, cw, notes); if (bad) return bad
        }
        continue
      }
      const r = reach(s, p.fact, w, facts)
      if ('refuse' in r) return r.refuse
      if ('none' in r) {
        const scoped = 'attribute' in w || facts.some((o) => o !== p.fact && Object.keys(s.objects[o].arrows ?? {}).some((role) => { const a = arrow(s, o, role)!; return a.kind === 'version' && a.to === (w as { to: string }).to }))
        if (scoped) continue
        return refuse('C3', `${r.none}, so it cannot be kept to ${conditionText(w as Condition)} while the other measures are`)
      }
      if ('choose' in r) { choices.push({ target: targetText(w), fact: p.fact, paths: r.choose }); continue }
      const bad = addFilter(s, p, r.step, w, notes); if (bad) return bad
    }
  }
  if (choices.length) return refuse('A2', choices.map((c) => `${c.fact} reaches ${c.target} by ${c.paths.join(' or ')}`).join('; ') + ' — say which', choices)

  for (const p of plans) {
    const f = s.objects[p.fact]
    // F2: a source that holds only the current state cannot answer as of an earlier day.
    if (f.history === 'current') {
      if (q.asOf && context.today && q.asOf < context.today) return refuse('F2', `${p.fact} holds only its current state; how it stood on ${q.asOf} cannot be read back — ask about it as it is now`)
      notes.push(`${p.fact}: as it stands now; earlier states are not kept`)
    }
    const time = timeArrow(s, p.fact)
    if (time) p.time = { role: time.role, level: s.objects[time.to].level ?? time.to, calendar: time.to }

    // D4: a span is cut at the boundaries of the fact's own time grain.
    if (q.span && p.time && !aligned(q.span, s.objects[p.time.calendar])) return refuse('D4', `${p.fact} is kept by ${p.time.level}; the span ${q.span.from} to ${q.span.to} cuts through a ${p.time.level}`)

    const groupedAtOwnTime = p.time && p.by.some((b) => 'path' in b && b.path.length === 1 && b.path[0] === p.time!.role)
    for (const name of p.measures) {
      const m = f.measures![name]
      // B: a stock across several instants.
      if (m.kind === 'stock' && p.time && !groupedAtOwnTime) {
        if (!m.overTime) return refuse('B1', `${p.fact}.${name} is a level at an instant; grouped over several ${p.time.level}s it needs to say whether it is the last, the first or the average level`)
        p.stockOverTime = true
        notes.push(`${p.fact}.${name}: the ${m.overTime} level in each group, not a sum over ${p.time.level}s`)
      }
      // F1: versions.
      if (m.versions) {
        const on = (x: Step) => 'path' in x && x.path[0] === m.versions
        if (!p.where.some(on) && !p.by.some(on)) return refuse('F1', `${p.fact}.${name} is kept in ${arrow(s, p.fact, m.versions)!.to} versions, which are never added together — keep to one, or group by ${m.versions}`)
      }
      if (m.aggregate === 'count distinct') notes.push(`${p.fact}.${name}: counted afresh in each group, not added from smaller groups`)
      // E: money in one currency.
      if (baseUnits(m.unit).money && m.currency) {
        const cur = m.currency
        const byCurrency = p.by.some((b) => Array.isArray(cur) ? 'path' in b && pathText(b.path) === pathText(normalise(s, p.fact, cur)) : 'attribute' in b && b.attribute === cur.attribute)
        if (!byCurrency) {
          if (!s.conversion) return refuse('E1', `${p.fact}.${name} is money in more than one currency, and the schema has no exchange rates to convert it — group by currency`)
          if (!q.currency) return refuse('E1', `${p.fact}.${name} is money in more than one currency — say the currency to report in, or group by currency`)
          // A fact with no time is as it stands now: its money converts at today's rates.
          const today = !p.time && !q.span ? q.asOf ?? context.today : undefined
          if (s.conversion.at === 'end' && !q.span && !today) return refuse('E2', `money is converted at the end of the span asked about, and the question has no span`)
          if (s.conversion.at === 'row' && !p.time && !today) return refuse('E2', `money is converted on each row's date, and ${p.fact} has no date — group by currency`)
          p.convert = today ? { currency: q.currency, at: 'end', on: today } : { currency: q.currency, at: s.conversion.at }
        }
      }
    }
    if (p.convert) notes.push(`${p.fact}: money converted to ${p.convert.currency} at ${p.convert.on ? `the rates of ${p.convert.on}` : p.convert.at === 'row' ? "each row's date" : 'the end of the span'}`)
    if (p.by.some((b) => 'path' in b && walk(s, p.fact, b.path)!.walked.some((a) => a.kind === 'as-of'))) notes.push(`${p.fact}: ${p.by.filter((b) => 'path' in b && walk(s, p.fact, b.path)!.walked.some((a) => a.kind === 'as-of')).map(stepText).join(', ')} taken as it was on each row's date`)
    if (p.by.some((b) => 'path' in b && walk(s, p.fact, b.path)!.walked.some((a) => a.partial))) notes.push(`${p.fact}: rows with nothing along ${p.by.filter((b) => 'path' in b && walk(s, p.fact, b.path)!.walked.some((a) => a.partial)).map(stepText).join(', ')} are kept as "none"`)
  }

  // E1, E3: units of each output.
  for (const o of outputs) {
    const u = unitsOf(o.expr, used)
    if ('refuse' in u) return refuse('E1', `${o.name}: ${u.refuse}`)
    o.unit = unitText(u.units)
  }
  if (facts.length > 1) notes.push(`${facts.join(' and ')} each added up on their own, then put side by side${q.by?.length ? ` by ${q.by.map(targetText).join(', ')}` : ''}`)

  const targets = (q.by ?? []).map(targetText)
  const plan: Plan = {
    columns: [...targets.map((name) => ({ name })), ...outputs.map((o) => ({ name: o.name, unit: o.unit }))],
    additive: [...used].filter(([, u]) => u.m.kind === 'flow' && ['sum', 'count'].includes(u.m.aggregate)).map(([r]) => r),
    targets, outputs, facts: plans, span: q.span, ...(q.asOf ? { asOf: q.asOf } : {}), order: q.order, limit: q.limit, notes,
  }
  return extend(s, q, plan, context)
}

/** A sub-question: the same measures, filters, span and currency, at a coarser grouping or another span. */
const sub = (q: Question, change: Partial<Question>): Question =>
  ({ measures: q.measures, by: q.by, where: q.where, without: q.without, span: q.span, currency: q.currency, asOf: q.asOf, ...change })

function extend(s: Schema, q: Question, plan: Plan, context: { today?: string }): Verdict {
  const { targets, outputs } = plan
  const named = (name: string) => targets.includes(name) || outputs.some((o) => o.name === name)
  const subset = (names: string[], what: string): Verdict | undefined => {
    const unknown = names.filter((n) => !targets.includes(n))
    return unknown.length ? refuse('Q', `${what} ${unknown.join(', ')} is not one of the targets (${targets.join(', ') || 'none'})`) : undefined
  }
  const at = (names: string[]) => (q.by ?? []).filter((t) => names.includes(targetText(t)))
  const outputFor = (p: Plan) => p.outputs

  for (const h of q.having ?? []) if (!outputs.some((o) => o.name === h.output)) return refuse('Q', `having: the answer has no output ${h.output}`)
  if (q.having?.length) plan.having = q.having

  if (q.totals?.length) {
    plan.totals = []
    for (const level of q.totals) {
      const bad = subset(level, 'totals:'); if (bad) return bad
      const v = check(s, sub(q, { by: at(level) }), context)
      if (!v.ok) return v
      plan.totals.push({ by: level, plan: v.plan })
    }
    if (q.limit || q.having) plan.notes.push('totals count every group, including those the limit or having leaves out')
  }

  if (q.share) {
    const bad = subset(q.share.within, 'share within'); if (bad) return bad
    for (const name of q.share.outputs) {
      const o = outputs.find((x) => x.name === name)
      if (!o) return refuse('Q', `share: the answer has no output ${name}`)
      // A share is a part over its whole: only for an output whose parts add up to the whole.
      if (!('ref' in o.expr)) return refuse('B3', `${name} is computed from other measures; its parts do not add up to its whole, so it has no share`)
      const [fact, m] = [o.expr.ref.slice(0, o.expr.ref.indexOf('.')), o.expr.ref.slice(o.expr.ref.indexOf('.') + 1)]
      const d = s.objects[fact].measures![m]
      if (d.kind === 'value-per-unit' || !['sum', 'count'].includes(d.aggregate)) return refuse('B3', `${name} is combined by ${d.aggregate}; its parts do not add up to its whole, so it has no share`)
      if (d.kind === 'stock' && plan.facts.find((f) => f.fact === fact)!.stockOverTime) return refuse('B3', `${name} is a level taken at one instant per group; groups at different instants do not add up to a whole`)
    }
    const v = check(s, sub(q, { by: at(q.share.within) }), context)
    if (!v.ok) return v
    plan.share = { outputs: q.share.outputs, within: q.share.within, plan: v.plan }
    plan.columns.push(...q.share.outputs.map((n) => ({ name: `${n} share within ${q.share!.within.join(', ') || 'all'}`, unit: 'ratio' })))
  }

  // Along the calendar grouped by: fill, running totals, moving windows.
  if (q.fill || q.cumulative || q.rolling) {
    const what = q.rolling ? 'a moving window' : q.cumulative ? 'a running total' : 'filling empty periods'
    const t = calendarTarget(s, plan)
    if (!t) return refuse('D7', `${what} goes along a calendar, and the question groups by none`)
    if (!q.span) return refuse('D7', `${what} goes along the periods of a span, and the question has none`)
    const def = s.objects[t.object]
    if (!startsPeriod(def, q.span.from) || !endsPeriod(def, q.span.to)) return refuse('D7', `${what} goes along whole ${t.object} periods, so the span starts and ends on their boundaries`)
    if (q.cumulative || q.rolling) {
      for (const o of outputs) {
        const bad = refs(o.expr).find((r) => { const [f, m] = [r.slice(0, r.indexOf('.')), r.slice(r.indexOf('.') + 1)]; const d = s.objects[f].measures![m]; return d.kind !== 'flow' || !['sum', 'count'].includes(d.aggregate) })
        if (bad) return refuse('B4', `${bad} does not add up over periods, so ${what} of ${o.name} would be wrong — it is counted afresh for each span, or taken at an instant`)
      }
    }
    let reset: CalendarDef | undefined
    if (q.cumulative?.reset) {
      const r = s.objects[q.cumulative.reset]
      if (r?.kind !== 'calendar' || !pathsFrom(s, t.object).some((p) => p.object === q.cumulative!.reset)) return refuse('D7', `a running total starts again at each period of a calendar ${t.object} rolls up to; ${q.cumulative.reset} is not one`)
      reset = r
    }
    if (q.rolling && (!Number.isInteger(q.rolling.window) || q.rolling.window < 1)) return refuse('D7', 'a moving window is a whole number of periods, at least one')
    plan.along = { target: t.index, def, keep: q.span, fill: !!q.fill || !!q.rolling, ...(q.cumulative ? { cumulative: { ...(reset ? { reset } : {}) } } : {}),
      ...(q.rolling ? { rolling: { window: q.rolling.window, average: !!q.rolling.average } } : {}) }
    if (q.rolling && q.rolling.window > 1) {
      // The periods before the span are read too, so its first periods have whole windows.
      const from = periodOf(def, shiftPeriods(def, keyOf(def, q.span.from), 1 - q.rolling.window)).from
      const wider = check(s, { ...sub(q, { span: { from, to: q.span.to } }), by: q.by }, context)
      if (!wider.ok) return wider
      plan.span = { from, to: q.span.to }
      plan.facts = wider.plan.facts
      plan.notes.push(`each ${t.object} is ${q.rolling.average ? 'the average' : 'the total'} of it and the ${q.rolling.window - 1} before it`)
    }
  }

  if (q.limitPer) {
    if (!q.limit || !q.order) return refuse('Q', 'a limit within groups keeps the first of each group, so it needs an order and a limit')
    const bad = subset(q.limitPer, 'limit per'); if (bad) return bad
    plan.limitPer = q.limitPer.map((x) => targets.indexOf(x))
  }

  if (q.compare) {
    if (!q.span) return refuse('D6', 'a comparison moves the span back, and the question has no span')
    const given = 'span' in q.compare ? q.compare.span : undefined
    const { years = 0, months = 0, days = 0, periods } = 'back' in q.compare ? q.compare.back : {}
    if ([days, years || months, periods].filter(Boolean).length > 1) return refuse('D6', 'move back by periods, by days, or by months and years — one of them')
    // A group at a calendar level is compared with the group the same number of periods back; the move is whole periods.
    let target: { index: number; object: string } | undefined
    for (const [i, b] of plan.facts[0].by.entries()) {
      if (!('path' in b)) continue
      const end = walk(s, plan.facts[0].fact, b.path)!.object
      if (s.objects[end].kind === 'calendar') target = { index: i, object: end }
    }
    const totalMonths = years * 12 + months
    let time: NonNullable<Plan['compare']>['time']
    let span: { from: string; to: string }
    if (target && given) {
      // An earlier span given outright: its periods are matched with the span's by their place in it.
      const def = s.objects[target.object]
      if (!startsPeriod(def, given.from) || !endsPeriod(def, given.to)) return refuse('D6', `grouped by ${target.object}, the span compared with starts and ends on ${target.object} boundaries`)
      if (given.from >= q.span.from) return refuse('D6', 'the span compared with comes before the span asked about')
      const places = periodsBetween(def, given.from, q.span.from).length
      if (periodsBetween(def, given.from, given.to).length !== periodsBetween(def, q.span.from, q.span.to).length) plan.notes.push(`the two spans have different numbers of ${target.object} periods; periods are matched by their place from the start`)
      span = given
      time = { target: target.index, level: def.level ?? target.object, def, periods: places }
    } else if (given) {
      span = given
    } else if (target) {
      const def = s.objects[target.object]
      const b = builtIn(def)
      const n = periods ?? (days ? (b === 'day' ? days : b === 'week' && days % 7 === 0 ? days / 7 : NaN) : monthsIn(def) && totalMonths % monthsIn(def)! === 0 ? totalMonths / monthsIn(def)! : NaN)
      if (!Number.isInteger(n) || n <= 0) return refuse('D6', `grouped by ${target.object}, a comparison moves back by whole ${target.object} periods`)
      if (!startsPeriod(def, q.span.from) || !endsPeriod(def, q.span.to)) return refuse('D6', `grouped by ${target.object}, the span is compared period by period, so it starts and ends on ${target.object} boundaries`)
      try { span = { from: periodOf(def, shiftPeriods(def, keyOf(def, q.span.from), -n)).from, to: periodOf(def, shiftPeriods(def, keyOf(def, addDays(q.span.to, -1)), -n)).to } }
      catch (e: any) { return refuse('D6', e.message) }
      time = { target: target.index, level: def.level ?? target.object, def, periods: n }
    } else {
      if (periods) return refuse('D6', 'moving back by periods needs a calendar among the groups')
      span = { from: shiftDate(q.span.from, -totalMonths, -days), to: shiftDate(q.span.to, -totalMonths, -days) }
    }
    // A span still running is compared with as many days of the earlier span, not the whole of it.
    const today = context.today
    if (today && q.span.from <= today && addDays(today, 1) < q.span.to) {
      const elapsed = Math.round((Date.parse(addDays(today, 1)) - Date.parse(q.span.from)) / 86400000)
      const cut = { from: span.from, to: addDays(span.from, elapsed) }
      const cutOk = check(s, { ...sub(q, { span: cut }), fill: q.fill, cumulative: q.cumulative, rolling: q.rolling }, context)
      if (cutOk.ok) { span = cut; plan.notes.push(`the span is still running, so it is compared with the first ${elapsed} days of the earlier one`) }
      else plan.notes.push(`the span is still running, but the earlier one cannot be cut at ${cut.to} (${cutOk.reason}), so it is compared whole`)
    }
    const v = check(s, { ...sub(q, { span }), fill: q.fill, cumulative: q.cumulative, rolling: q.rolling }, context)
    if (!v.ok) return v
    plan.compare = { back: 'back' in q.compare ? q.compare.back : null, plan: v.plan, ...(time ? { time } : {}) }
    for (const o of outputFor(plan)) plan.columns.push({ name: `${o.name} before`, unit: o.unit }, { name: `${o.name} change`, unit: o.unit })
  }

  if (q.order && !named(q.order.by) && !plan.columns.some((c) => c.name === q.order!.by)) return refuse('Q', `the answer has no column ${q.order.by} to order by — its columns are ${plan.columns.map((c) => c.name).join(', ')}`)
  return { ok: true, plan }
}

/** A date moved by months and days; a day past the end of a shorter month stays at that month's end. */
export function shiftDate(date: string, months: number, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1 + months, 1))
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate()
  t.setUTCDate(Math.min(d, last) + days)
  return t.toISOString().slice(0, 10)
}

function unitsOf(e: Expr, used: Map<string, { m: Measure }>): { units: Units } | { refuse: string } {
  if ('ref' in e) return { units: baseUnits(used.get(e.ref)!.m.unit) }
  const [a, b] = e.args.map((x) => unitsOf(x, used))
  if ('refuse' in a) return a
  if ('refuse' in b) return b
  if (e.op === '*') return { units: timesUnits(a.units, b.units) }
  if (e.op === '/') return { units: timesUnits(a.units, b.units, -1) }
  return sameUnits(a.units, b.units) ? { units: a.units } : { refuse: `${unitText(a.units)} and ${unitText(b.units)} are not the same unit, so they cannot be ${e.op === '+' ? 'added' : 'subtracted'}` }
}

/** Whether both ends of a span fall on the start of a period at this level. */
export function aligned(span: { from: string; to: string }, calendar: CalendarDef): boolean {
  return startsPeriod(calendar, span.from) && endsPeriod(calendar, span.to)
}


/** The target that is a calendar, if any. */
function calendarTarget(s: Schema, plan: Plan): { index: number; object: string } | undefined {
  for (const [i, b] of plan.facts[0].by.entries()) {
    if (!('path' in b)) continue
    const end = walk(s, plan.facts[0].fact, b.path)!.object
    if (s.objects[end].kind === 'calendar') return { index: i, object: end }
  }
  return undefined
}

export const conditionText = (c: Condition) => 'in' in c ? c.in.join(', ') : 'notIn' in c ? `anything but ${c.notIn.join(', ')}` : 'none' in c ? (c.none ? 'nothing' : 'something')
  : 'range' in c ? [c.range.from !== undefined ? `from ${c.range.from}` : '', c.range.to !== undefined ? `before ${c.range.to}` : ''].filter(Boolean).join(' ') : 'contains' in c ? `labels containing "${c.contains}"` : `labels starting "${c.startsWith}"`

/** One filter, checked against what it is on, added to a fact's plan. */
function addFilter(s: Schema, p: FactPlan, step: Step, w: Filter, notes: string[]): Verdict | undefined {
  const c = w as Condition & { under?: string }
  const kinds = (['in', 'notIn', 'none', 'contains', 'startsWith', 'range'] as const).filter((k) => k in c)
  if (kinds.length !== 1) return refuse('Q', `a filter keeps rows by one condition — in, notIn, none, contains, startsWith or range — and this one has ${kinds.length ? kinds.join(' and ') : 'none'}`)
  const listed = 'in' in c ? c.in : 'notIn' in c ? c.notIn : undefined
  let members = listed
  if ('attribute' in step) {
    const owner = step.at?.length ? walk(s, p.fact, step.at)!.object : p.fact
    const def = s.objects[owner].attributes![step.attribute]
    const unknown = def.members && listed ? listed.filter((v) => !def.members!.includes(v)) : []
    if (unknown.length) return refuse('A1', `${owner}.${step.attribute} has no value ${unknown.join(', ')} — its values are ${def.members!.join(', ')}`)
    if ('range' in c && !['date', 'number'].includes(def.type ?? '')) return refuse('A1', `${owner}.${step.attribute} is not a date or a number, so it has no range`)
  } else {
    const to = walk(s, p.fact, step.path)!.object
    const o = s.objects[to]
    if ('range' in c) return refuse('A1', `${to} is a dimension; a range keeps dates or numbers — filter by its members, or by an attribute of it`)
    members = listed?.map((v) => o.names?.[v] ?? v)
    const unknown = o.members && members ? members.filter((m) => !o.members![m]) : []
    if (unknown.length) return refuse('A1', `${to} has no member ${unknown.join(', ')}`)
    if (c.under) {
      const a = arrow(s, to, c.under)
      if (a?.kind !== 'self') return refuse('A5', `${to}.${c.under} is not an arrow from ${to} to itself, so there is nothing "under" to follow`)
      if (!('in' in c)) return refuse('A5', 'everything under is kept for members in a list')
    }
    if ('none' in c && !walk(s, p.fact, step.path)!.walked.some((a) => a.partial)) {
      return refuse('A4', `every ${p.fact} row reaches a ${to} along ${step.path.join('.')}, so none of them has nothing there`)
    }
  }
  const condition: Condition = 'in' in c ? { in: members! } : 'notIn' in c ? { notIn: members! } : 'none' in c ? { none: c.none } : 'range' in c ? { range: c.range } : 'contains' in c ? { contains: c.contains } : { startsWith: (c as { startsWith: string }).startsWith }
  p.where.push({ ...step, ...condition, ...(c.under ? { under: c.under } : {}) })
  if ('notIn' in c) notes.push(`${p.fact}: rows not in ${c.notIn.join(', ')} include those with nothing there`)
  return undefined
}

/** Whether a member (its key and label) meets a condition — the one definition the evaluator uses. */
export function meets(c: Condition, key: string | number | null, label: string | null): boolean {
  if ('none' in c) return c.none ? key === null : key !== null
  if ('in' in c) return key !== null && c.in.includes(String(key))
  if ('notIn' in c) return key === null || !c.notIn.includes(String(key))
  if ('range' in c) {
    if (key === null) return false
    const num = (v: unknown) => (typeof v === 'number' ? v : Number(v))
    const numeric = typeof c.range.from === 'number' || typeof c.range.to === 'number'
    const k = numeric ? num(key) : String(key)
    return (c.range.from === undefined || k >= (numeric ? num(c.range.from) : String(c.range.from))) && (c.range.to === undefined || k < (numeric ? num(c.range.to) : String(c.range.to)))
  }
  const text = (label ?? '').toLowerCase()
  return key !== null && ('contains' in c ? text.includes(c.contains.toLowerCase()) : text.startsWith(c.startsWith.toLowerCase()))
}
