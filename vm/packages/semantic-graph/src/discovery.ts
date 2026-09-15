// ── THE GRAPH AS AN AGENT SEES IT (§12) ──────────────────────────────────────────────────────────────────────
//
// An agent never sees tables or SQL. It sees nodes, arrows and paths, and asks these:
//
//   node     what one node is: its kind, what it is kept by or belongs to, what points at it, its measures and
//            attributes, the members it lists and the names people use for them
//   paths    every way from one node to another, along arrows, in normal form
//   find     the nodes a word is — an object, a measure, an attribute, a role, a member, a name people use — exactly
//   members  which member of an entity someone meant by what they typed, looked up at the source: exact, starting with,
//            containing, then within a few typing mistakes — and said to be ambiguous when several fit equally
//
// Every answer is in the graph's own terms, so what an agent builds from them is a question the algebra can check.

import { pathsFrom } from './paths.js'
import { arrows, grainOf, walk, type Schema } from './schema.js'

export interface NodeView {
  name: string
  kind: 'entity' | 'calendar' | 'fact'
  description?: string
  synonyms?: string[]
  arrows: Array<{ role: string; to: string; kind: string; partial?: boolean }>
  pointedAtBy: Array<{ from: string; role: string; kind: string }>
  measures?: Array<{ name: string; unit: string; kind: string; aggregate: string; currency?: string; overTime?: string; of?: string; weight?: string; versions?: string; synonyms?: string[] }>
  /** facts: the conditions its rows are always kept to. */
  keptTo?: string[]
  /** the named conditions about this object. */
  conditions?: Array<{ name: string; description?: string; where: unknown[] }>
  /** the source holds only the current state. */
  history?: 'current'
  /** facts: the path taken to a dimension when a question does not say which. */
  defaults?: Record<string, string>
  attributes?: Array<{ name: string; type?: string; values?: string[]; description?: string }>
  members?: { count: number; sample: Array<{ key: string; label: string }>; names?: Record<string, string> }
  calendar?: { level?: string; fiscal?: unknown; periods?: number }
}

export function node(s: Schema, name: string): NodeView {
  const o = s.objects[name]
  if (!o) {
    const near = Object.keys(s.objects).filter((n) => n.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(n.toLowerCase()))
    throw new Error(`there is no node "${name}"${near.length ? ` — did you mean ${near.join(', ')}?` : ''}`)
  }
  const pointedAtBy = Object.keys(s.objects).flatMap((from) => arrows(s, from).filter((a) => a.to === name).map((a) => ({ from, role: a.role, kind: a.kind })))
  return {
    name, kind: o.kind, ...(o.description ? { description: o.description } : {}), ...(o.synonyms ? { synonyms: o.synonyms } : {}),
    arrows: arrows(s, name).map((a) => ({ role: a.role, to: a.to, kind: a.kind, ...(a.partial ? { partial: true } : {}) })),
    pointedAtBy,
    ...(o.kind === 'fact' ? {
      measures: Object.entries(o.measures ?? {}).map(([m, d]) => ({ name: m, unit: d.unit, kind: d.kind, aggregate: d.aggregate,
        ...(d.currency ? { currency: Array.isArray(d.currency) ? d.currency.join('.') : `the attribute ${d.currency.attribute}` } : {}),
        ...(d.overTime ? { overTime: d.overTime } : {}), ...(d.of ? { of: d.of } : {}), ...(d.weight ? { weight: d.weight } : {}), ...(d.versions ? { versions: d.versions } : {}),
        ...(d.synonyms ? { synonyms: d.synonyms } : {}) })),
      ...(o.defaults ? { defaults: Object.fromEntries(Object.entries(o.defaults).map(([t, p]) => [t, p.join('.')])) } : {}),

    } : {}),
    ...(o.attributes ? { attributes: Object.entries(o.attributes).map(([a, d]) => ({ name: a, ...(d.type ? { type: d.type } : {}), ...(d.members ? { values: d.members } : {}), ...(d.description ? { description: d.description } : {}) })) } : {}),
    ...(o.keptTo?.length ? { keptTo: o.keptTo } : {}),
    ...(o.history ? { history: o.history } : {}),
    ...(Object.entries(s.conditions ?? {}).some(([, c]) => c.on === name) ? { conditions: Object.entries(s.conditions ?? {}).filter(([, c]) => c.on === name).map(([n, c]) => ({ name: n, ...(c.description ? { description: c.description } : {}), where: c.where })) } : {}),
    ...(o.members ? { members: { count: Object.keys(o.members).length, sample: Object.entries(o.members).slice(0, 10).map(([key, label]) => ({ key, label })), ...(o.names ? { names: o.names } : {}) } } : {}),
    ...(o.kind === 'calendar' ? { calendar: { ...(o.level ? { level: o.level } : {}), ...(o.fiscal ? { fiscal: o.fiscal } : {}), ...(o.periods ? { periods: o.periods.length } : {}) } } : {}),
  }
}

/** Every path from a node to another, along arrows, in normal form — with what each arrow walked is. */
export function paths(s: Schema, from: string, to: string, maxSteps = 4) {
  if (!s.objects[from]) throw new Error(`there is no node "${from}"`)
  if (!s.objects[to]) throw new Error(`there is no node "${to}"`)
  return pathsFrom(s, from, maxSteps).filter((p) => p.object === to).map((p) => p.steps)
}

export type Found =
  | { kind: 'object'; node: string; as: string }
  | { kind: 'measure'; node: string; measure: string; as: string }
  | { kind: 'attribute'; node: string; attribute: string; value?: string; as: string }
  | { kind: 'role'; node: string; role: string; to: string; as: string }
  | { kind: 'member'; node: string; key: string; label: string; as: string }
  | { kind: 'condition'; node: string; condition: string; as: string }

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}&+]+/gu, ' ').trim()

/** The nodes a word is, matched exactly after case and punctuation — never guessed. */
export function find(s: Schema, word: string): Found[] {
  const w = norm(word)
  const is = (x?: string) => !!x && norm(x) === w
  const out: Found[] = []
  for (const [name, o] of Object.entries(s.objects)) {
    if (is(name)) out.push({ kind: 'object', node: name, as: 'its name' })
    for (const syn of o.synonyms ?? []) if (is(syn)) out.push({ kind: 'object', node: name, as: `a synonym, "${syn}"` })
    for (const [m, d] of Object.entries(o.measures ?? {})) {
      if (is(m)) out.push({ kind: 'measure', node: name, measure: m, as: 'its name' })
      for (const syn of d.synonyms ?? []) if (is(syn)) out.push({ kind: 'measure', node: name, measure: m, as: `a synonym, "${syn}"` })
    }
    for (const [a, d] of Object.entries(o.attributes ?? {})) {
      if (is(a)) out.push({ kind: 'attribute', node: name, attribute: a, as: 'its name' })
      for (const syn of d.synonyms ?? []) if (is(syn)) out.push({ kind: 'attribute', node: name, attribute: a, as: `a synonym, "${syn}"` })
      for (const v of d.members ?? []) if (is(v)) out.push({ kind: 'attribute', node: name, attribute: a, value: v, as: 'one of its values' })
    }
    for (const a of arrows(s, name)) {
      if (is(a.role)) out.push({ kind: 'role', node: name, role: a.role, to: a.to, as: `an arrow to ${a.to}` })
      for (const syn of (typeof o.arrows?.[a.role] === 'object' ? (o.arrows![a.role] as { synonyms?: string[] }).synonyms : undefined) ?? []) if (is(syn)) out.push({ kind: 'role', node: name, role: a.role, to: a.to, as: `a synonym, "${syn}"` })
    }
    for (const [key, label] of Object.entries(o.members ?? {})) if (is(label) || key === word.trim()) out.push({ kind: 'member', node: name, key, label, as: is(label) ? 'its label' : 'its key' })
    for (const [n, key] of Object.entries(o.names ?? {})) if (is(n)) out.push({ kind: 'member', node: name, key, label: o.members?.[key] ?? key, as: `a name people use, "${n}"` })
  }
  for (const [n, c] of Object.entries(s.conditions ?? {})) {
    if (is(n)) out.push({ kind: 'condition', node: c.on, condition: n, as: 'its name' })
    for (const syn of c.synonyms ?? []) if (is(syn)) out.push({ kind: 'condition', node: c.on, condition: n, as: `a synonym, "${syn}"` })
  }
  // One entry per thing found, however many of its words matched.
  const seen = new Map<string, Found>()
  for (const f of out) {
    const k = JSON.stringify({ ...f, as: undefined })
    const had = seen.get(k)
    if (had) had.as = `${had.as}; ${f.as}`
    else seen.set(k, { ...f })
  }
  return [...seen.values()]
}

/** The edit distance between two texts, with a transposition counted as one mistake. */
export function mistakes(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
  }
  return d[a.length][b.length]
}

export type MemberMatch = { key: string; label: string; how: 'exact' | 'starts with' | 'contains' | 'close'; mistakes?: number }

/** Of candidates, the ones typed text means: the best kind of match only, and ambiguous when more than one fits it. */
export function bestMembers(candidates: Array<{ key: string; label: string }>, typed: string): { matches: MemberMatch[]; ambiguous: boolean } {
  const t = norm(typed)
  const allowed = t.length <= 4 ? 1 : 2
  const tiers: Array<[MemberMatch['how'], (label: string, key: string) => number | boolean]> = [
    ['exact', (l, k) => norm(l) === t || k === typed.trim()],
    ['starts with', (l) => norm(l).startsWith(t)],
    ['contains', (l) => norm(l).includes(t)],
    ['close', (l) => { const m = Math.min(mistakes(norm(l), t), ...norm(l).split(' ').map((word) => mistakes(word, t))); return m <= allowed ? m : false }],
  ]
  for (const [how, test] of tiers) {
    const hits = candidates.map((c) => ({ c, r: test(c.label, c.key) })).filter((x) => x.r !== false)
    if (!hits.length) continue
    if (how === 'close') {
      const best = Math.min(...hits.map((h) => h.r as number))
      const top = hits.filter((h) => h.r === best)
      return { matches: top.map((h) => ({ ...h.c, how, mistakes: best })), ambiguous: top.length > 1 }
    }
    return { matches: hits.map((h) => ({ ...h.c, how })), ambiguous: hits.length > 1 }
  }
  return { matches: [], ambiguous: false }
}

/** Everything the graph holds, briefly: each fact with what it is kept by and its measures, each entity with where it
 *  belongs, each calendar. For finding one's way before looking at a node. */
export function catalog(s: Schema) {
  const entries = Object.entries(s.objects)
  return {
    facts: entries.filter(([, o]) => o.kind === 'fact').map(([name, o]) => ({
      name, ...(o.description ? { description: o.description } : {}),
      keptBy: arrows(s, name).map((a) => `${a.role} → ${a.to}`),
      measures: Object.entries(o.measures ?? {}).map(([m, d]) => `${m} (${d.unit}, ${d.kind}, ${d.aggregate})`),
      ...(o.attributes ? { attributes: Object.keys(o.attributes) } : {}),
      ...(o.keptTo?.length ? { keptTo: o.keptTo } : {}),
      ...(o.history ? { history: o.history } : {}),
    })),
    entities: entries.filter(([, o]) => o.kind === 'entity').map(([name, o]) => ({
      name, ...(o.description ? { description: o.description } : {}),
      belongs: arrows(s, name).map((a) => `${a.role} → ${a.to}${a.kind === 'as-of' ? ' (changes over time)' : a.partial ? ' (may be none)' : ''}`),
      ...(o.members ? { members: Object.keys(o.members).length } : {}),
      ...(o.attributes ? { attributes: Object.keys(o.attributes) } : {}),
    })),
    conditions: Object.entries(s.conditions ?? {}).map(([name, c]) => ({ name, on: c.on, ...(c.description ? { description: c.description } : {}) })),
    calendars: entries.filter(([, o]) => o.kind === 'calendar').map(([name, o]) => ({ name, cuts: o.fiscal ? `fiscal ${o.fiscal.period}s from month ${o.fiscal.startMonth}` : o.periods ? `${o.periods.length} listed periods` : o.level, rollsUpTo: arrows(s, name).map((a) => a.to) })),
  }
}

// ── Dimensions: how a fact's measures can be sliced ──

export interface Dimension {
  /** How a question names it: an entity or calendar by its name, an attribute as Owner.attribute (the fact's own by name). */
  name: string
  kind: 'entity' | 'attribute' | 'calendar'
  /** For an attribute: the object that carries it. */
  of?: string
  attribute?: string
  /** Every path from the fact to it (to its owner, for an attribute), normal form; [] for the fact's own attribute. */
  paths: string[][]
  /** The path taken when a question does not say: the only one, or the fact's default. */
  default?: string[]
  /** Some rows reach nothing there. */
  partial: boolean
  /** Followed as it was on each row's date. */
  asOf: boolean
}

/** Every dimension of a fact: what it reaches along arrows, the attributes of itself and of what it reaches, and the
 *  calendar levels of its time. A path through a self arrow (a parent, a manager) counts only when nothing else leads
 *  there, as when reading a question. */
export function dimensions(s: Schema, fact: string, maxSteps = 4): Dimension[] {
  const f = s.objects[fact]
  if (f?.kind !== 'fact') throw new Error(`${fact} is not a fact — dimensions belong to facts`)
  const byObject = new Map<string, string[][]>()
  for (const p of pathsFrom(s, fact, maxSteps)) (byObject.get(p.object) ?? byObject.set(p.object, []).get(p.object)!).push(p.steps)
  const out: Dimension[] = []
  const info = (object: string, all: string[][]) => {
    const direct = all.filter((steps) => !walk(s, fact, steps)!.walked.some((a) => a.kind === 'self'))
    const use = direct.length ? direct : all
    const d = f.defaults?.[object]
    const chosen = use.length === 1 ? use[0] : d
    const walked = (steps: string[]) => walk(s, fact, steps)!.walked
    return { paths: use, ...(chosen ? { default: chosen } : {}), partial: (chosen ? walked(chosen) : use.flatMap(walked)).some((a) => a.partial), asOf: (chosen ? walked(chosen) : use.flatMap(walked)).some((a) => a.kind === 'as-of') }
  }
  for (const a of Object.keys(f.attributes ?? {})) out.push({ name: a, kind: 'attribute', of: fact, attribute: a, paths: [[]], default: [], partial: false, asOf: false })
  for (const [object, all] of byObject) {
    const o = s.objects[object]
    if (o.kind === 'fact') continue
    const i = info(object, all)
    out.push({ name: object, kind: o.kind === 'calendar' ? 'calendar' : 'entity', ...i })
    for (const a of Object.keys(o.attributes ?? {})) out.push({ name: `${object}.${a}`, kind: 'attribute', of: object, attribute: a, ...i })
  }
  const order = { calendar: 0, entity: 1, attribute: 2 }
  return out.sort((x, y) => order[x.kind] - order[y.kind] || x.name.localeCompare(y.name))
}

/** The dimensions several facts share — by which their measures can be put side by side. */
export function conformedDimensions(s: Schema, facts: string[]): Dimension[] {
  if (!facts.length) return []
  const each = facts.map((f) => new Map(dimensions(s, f).map((d) => [d.name, d])))
  return [...each[0].values()].filter((d) => each.every((m) => m.has(d.name)))
}

/** A fact's grain with what each part leads to. */
export function grain(s: Schema, fact: string) {
  return grainOf(s, fact).map((role) => ({ role, to: arrows(s, fact).find((a) => a.role === role)!.to }))
}
