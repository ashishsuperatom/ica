// ── The STATE engine — how the last block's STATE changes, and what runs when it does ─────────────────────────────
//
// STATE is one JSON: which package (by program hash) owns each slice, the slices, and the agent's own keys
// (STATE.agent). It changes only through ops — set, add, remove — each checked against the slice's schema, and a
// change that does not fit is refused with a sentence. After a change, a package runs when its own slice changed or
// when a path it declared it reads changed (in dependency order; a cycle is refused when the packages load), or when
// one of its functions is called (an action, a run button).
//
// A package function is handed the whole STATE, deep-frozen, and a setter scoped to its own slice: it can read
// everything and change only its own part — enforced here, not by convention (React's setState is the model). What a
// function returns — a new slice, an answer, more actions — is checked the same way. Runs for an earlier STATE that
// finish after a newer intent are dropped (a session keeps a generation).
//
// Pure: no Node and no browser APIs, so the same code runs in the engine and in a Worker.

import { checkOp, checkPackage, checkPackages, checkValue, type ActionSpec, type Field, type Op, type PackageSpec, type SliceSchema, type State } from '@superatom/platform-types'

export class StateRefusal extends Error {
  constructor(public problems: string[]) { super(problems.join('; ')) }
}

/** What a package function may do: read the whole STATE (frozen), set its own slice, and return an answer or actions. */
export interface PackageContext {
  /** Merge fields into this package's slice (only fields its schema declares). */
  set(patch: Record<string, unknown>): void
  /** Its slice as set so far in this call. */
  readonly slice: Readonly<Record<string, unknown>>
  /** Parameters the caller passed (an action's, a run button's). */
  readonly params: Readonly<Record<string, unknown>>
  /** What the platform gives a program to work with — data through the datasource manager, and so on. */
  readonly services: Readonly<Record<string, unknown>>
}
export interface FunctionResult {
  /** A whole new slice (replaces STATE.<package>, nothing else). */
  slice?: Record<string, unknown>
  /** What it shows: markdown with marker lines, and the files or blocks the markers name (`:::table rows.json`). */
  answer?: { markdown: string; files?: string[]; blocks?: Record<string, Record<string, unknown>>; world?: Record<string, number> }
  /** Actions it suggests now, shown among the session's possible actions. */
  actions?: ActionSpec[]
}
export type PackageFunction = (state: Readonly<State>, ctx: PackageContext) => FunctionResult | void | Promise<FunctionResult | void>

export interface LoadedPackage {
  /** The slice it owns. */
  name: string
  /** Its program's content hash. */
  hash: string
  spec: PackageSpec
  functions: Record<string, PackageFunction>
}

export interface Ran { package: string; fn: string; answer?: FunctionResult['answer']; actions?: ActionSpec[] }
export interface Outcome {
  state: State
  /** The paths that changed, from the ops and from the runs. */
  changed: string[]
  /** What ran, in order, and what each showed. */
  ran: Ran[]
}

// ── frozen copies and canonical hashes ──────────────────────────────────────────────────────────────────────────
function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v as object)) deepFreeze(x) }
  return v
}
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}
/** A STATE's identity: the same STATE always has the same hash (FNV-1a, 64 bits, hex). An answer records the hash of the STATE it was made from. */
export function stateHash(state: State): string {
  const text = canonical(state)
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ text.length
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ c, 0x0100019d) >>> 0 }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

/** The field a path names inside a slice's schema: `trips.window.from` → window → from. */
function fieldAt(schema: SliceSchema, parts: string[]): Field | null {
  let cur: Field | SliceSchema = { object: schema }
  for (const p of parts) {
    let f: Field = cur as Field
    while (typeof f === 'object' && 'nullable' in f) f = f.nullable
    if (typeof f !== 'object' || !('object' in f)) return null
    const next: Field | undefined = f.object[p]
    if (next === undefined) return null
    cur = next
  }
  return cur as Field
}
const unwrap = (f: Field): Field => (typeof f === 'object' && 'nullable' in f ? unwrap(f.nullable) : f)

export interface StateEngine {
  /** The packages, in the order they run (dependencies first). */
  readonly order: string[]
  /** A first STATE: every package's initial slice, with the given slices and agent keys over it. */
  start(over?: Partial<Record<string, Record<string, unknown>>>, agent?: Record<string, unknown>): State
  /** Apply ops (checked, all or none) without running anything. */
  apply(state: State, ops: Op[]): { state: State; changed: string[] }
  /** Apply ops, then run every package they affect, in order. */
  dispatch(state: State, ops: Op[], params?: Record<string, unknown>): Promise<Outcome>
  /** Call one package function (an action, a run button), then run the packages its change affects. */
  call(state: State, pkg: string, fn: string, params?: Record<string, unknown>): Promise<Outcome>
  /** A suggested action: its ops (then the runs), or the function it calls. */
  act(state: State, pkg: string, actionId: string, params?: Record<string, unknown>): Promise<Outcome>
  /** Which packages run, in order, when these paths change. */
  affected(changed: string[]): string[]
}

/** Load packages into one STATE engine: each checked; one owner per slice; reads resolve; no cycles. */
export function createStateEngine(packages: LoadedPackage[], opts: { services?: Record<string, unknown> } = {}): StateEngine {
  const services = Object.freeze({ ...(opts.services ?? {}) })
  const problems: string[] = []
  for (const p of packages) {
    problems.push(...checkPackage(p.spec, `package "${p.name}"`))
    if (p.name !== p.spec.owns) problems.push(`package "${p.name}" owns "${p.spec.owns}": a package is named for its slice`)
    for (const f of p.spec.functions) if (typeof p.functions[f.name] !== 'function') problems.push(`package "${p.name}" declares ${f.name}() but does not provide it`)
  }
  problems.push(...checkPackages(packages.map((p) => p.spec)))
  if (problems.length) throw new StateRefusal(problems)
  const byName = new Map(packages.map((p) => [p.name, p]))

  // Dependency order: a package after every package whose slice it reads. A cycle is refused here, at load.
  const order: string[] = []
  const state: Record<string, 'visiting' | 'done'> = {}
  const visit = (n: string, path: string[]) => {
    if (state[n] === 'done') return
    if (state[n] === 'visiting') throw new StateRefusal([`packages read each other in a cycle: ${[...path, n].join(' → ')} — a package may not depend on itself through others`])
    state[n] = 'visiting'
    for (const r of byName.get(n)!.spec.reads) { const dep = r.split('.')[0]; if (dep !== n) visit(dep, [...path, n]) }
    state[n] = 'done'; order.push(n)
  }
  for (const p of packages) visit(p.name, [])

  const affected = (changed: string[]): string[] => {
    // A package runs when its own slice changed, or a path it reads changed (or a field under it, or a slice above it).
    const touches = (read: string, c: string) => read === c || read.startsWith(c + '.') || c.startsWith(read + '.')
    const hit = new Set<string>()
    for (const n of order) {
      const p = byName.get(n)!
      if (changed.some((c) => c.split('.')[0] === n)) hit.add(n)
      else if (p.spec.reads.some((r) => changed.some((c) => touches(r, c)))) hit.add(n)
    }
    return order.filter((n) => hit.has(n))
  }

  const start: StateEngine['start'] = (over = {}, agent = {}) => {
    const s: State = { packages: Object.fromEntries(packages.map((p) => [p.name, p.hash])), agent: clone(agent) }
    for (const p of packages) {
      const slice = { ...clone(p.spec.initial), ...clone(over[p.name] ?? {}) }
      const bad = Object.entries(p.spec.schema).flatMap(([k, f]) => checkValue(f, slice[k], `${p.name}.${k}`))
      for (const k of Object.keys(slice)) if (!(k in p.spec.schema)) bad.push(`${p.name}.${k} is not declared`)
      if (bad.length) throw new StateRefusal(bad)
      s[p.name] = slice
    }
    return s
  }

  /** One op, applied to a working copy; returns the path it changed. */
  const applyOne = (s: State, op: Op): string => {
    const bad = checkOp(op)
    if (bad.length) throw new StateRefusal(bad)
    const [slice, ...parts] = op.path.split('.')
    if (slice === 'packages') throw new StateRefusal([`${op.path}: which packages a STATE has is the platform's, not an op's`])
    if (slice === 'agent') {   // the agent's own keys: free-form
      const agent = (s.agent ??= {}) as Record<string, unknown>
      let target = agent
      for (const p of parts.slice(0, -1)) target = (target[p] ??= {}) as Record<string, unknown>
      const key = parts[parts.length - 1]
      if (op.op === 'set') target[key] = clone(op.value)
      else if (op.op === 'add') { const cur = target[key]; target[key] = [...(Array.isArray(cur) ? cur : cur === undefined ? [] : [cur]), clone(op.value)] }
      else delete target[key]
      return op.path
    }
    const pkg = byName.get(slice)
    if (!pkg) throw new StateRefusal([`${op.path}: no package owns the slice "${slice}"`])
    const field = fieldAt(pkg.spec.schema, parts)
    if (!field) throw new StateRefusal([`${op.path}: "${slice}" has no field ${parts.join('.')}`])
    // the parent object, created along the way only where the schema says the path is an object
    let parent = s[slice] as Record<string, unknown>
    for (const p of parts.slice(0, -1)) { if (parent[p] === null || parent[p] === undefined) parent[p] = {}; parent = parent[p] as Record<string, unknown> }
    const key = parts[parts.length - 1]
    if (op.op === 'set') {
      const problems = checkValue(field, op.value, op.path)
      if (problems.length) throw new StateRefusal(problems)
      parent[key] = clone(op.value)
    } else if (op.op === 'add') {
      const f = unwrap(field)
      if (typeof f !== 'object' || !('list' in f)) throw new StateRefusal([`${op.path} is not a list: add appends to a list — use set`])
      const problems = checkValue(f.list, op.value, `${op.path}[]`)
      if (problems.length) throw new StateRefusal(problems)
      parent[key] = [...((parent[key] as unknown[]) ?? []), clone(op.value)]
    } else {
      const f = unwrap(field)
      if (typeof f === 'object' && 'list' in f) {
        if (!('value' in op)) throw new StateRefusal([`${op.path}: remove from a list says which item (value)`])
        const want = canonical(op.value)
        const list = (parent[key] as unknown[]) ?? []
        if (!list.some((x) => canonical(x) === want)) throw new StateRefusal([`${op.path} does not hold ${JSON.stringify(op.value)}`])
        parent[key] = list.filter((x) => canonical(x) !== want)
      } else if (typeof field === 'object' && 'nullable' in field) parent[key] = null
      else throw new StateRefusal([`${op.path} cannot be removed: it is not a list and not nullable — set it instead`])
    }
    return op.path
  }

  const apply: StateEngine['apply'] = (state, ops) => {
    const s = clone(state)
    const changed = ops.map((op) => applyOne(s, op))   // all or none: a refusal throws before the copy is returned
    return { state: s, changed: [...new Set(changed)] }
  }

  /** Run one function: frozen STATE in, its own slice out (checked). */
  const runOne = async (s: State, name: string, fn: string, params: Record<string, unknown>): Promise<{ state: State; ran: Ran; changed: string[] }> => {
    const pkg = byName.get(name)
    if (!pkg) throw new StateRefusal([`no package "${name}"`])
    const f = pkg.functions[fn]
    if (!f || !pkg.spec.functions.some((x) => x.name === fn)) throw new StateRefusal([`package "${name}" has no function ${fn}()`])
    const before = clone(s[name]) as Record<string, unknown>
    let slice = clone(s[name]) as Record<string, unknown>
    const frozen = deepFreeze(clone(s))
    const ctx: PackageContext = {
      set(patch) {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new StateRefusal([`${name}.set() takes an object of its own fields`])
        const bad: string[] = []
        for (const [k, v] of Object.entries(patch)) {
          const field = pkg.spec.schema[k]
          if (!field) bad.push(`${name}.${k}: ${name} can set only the fields its schema declares — and never another package's slice`)
          else bad.push(...checkValue(field, v, `${name}.${k}`))
        }
        if (bad.length) throw new StateRefusal(bad)
        slice = { ...slice, ...clone(patch) }
      },
      get slice() { return deepFreeze(clone(slice)) },
      params: deepFreeze(clone(params)),
      services,
    }
    const out = (await f(frozen, ctx)) ?? {}
    if (out.slice !== undefined) {
      const bad = Object.entries(pkg.spec.schema).flatMap(([k, field]) => checkValue(field, out.slice![k], `${name}.${k}`))
      for (const k of Object.keys(out.slice)) if (!(k in pkg.spec.schema)) bad.push(`${name}.${k} is not declared`)
      if (bad.length) throw new StateRefusal(bad)
      slice = clone(out.slice)
    }
    const next = clone(s); next[name] = slice
    // The fields the run changed, each as a path — so a package reading trips.count re-runs only when count changed.
    const changed = [...new Set([...Object.keys(before ?? {}), ...Object.keys(slice)])].filter((k) => canonical(before?.[k]) !== canonical(slice[k])).map((k) => `${name}.${k}`)
    return { state: next, ran: { package: name, fn, ...(out.answer ? { answer: out.answer } : {}), ...(out.actions ? { actions: out.actions } : {}) }, changed }
  }

  /** Run every affected package once, in order; a run that changes its slice can make later packages affected. */
  const cascade = async (s: State, changed: string[], skip: Set<string>, params: Record<string, unknown>): Promise<Outcome> => {
    const ran: Ran[] = []
    const all = new Set(changed)
    const done = new Set<string>(skip)
    for (const n of order) {
      if (done.has(n) || !affected([...all]).includes(n)) continue
      const r = await runOne(s, n, 'run', params)
      s = r.state; ran.push(r.ran); done.add(n)
      for (const c of r.changed) all.add(c)
    }
    return { state: s, changed: [...all], ran }
  }

  const dispatch: StateEngine['dispatch'] = async (state, ops, params = {}) => {
    const a = apply(state, ops)
    return cascade(a.state, a.changed, new Set(), params)
  }

  const call: StateEngine['call'] = async (state, pkg, fn, params = {}) => {
    const r = await runOne(clone(state), pkg, fn, params)
    const rest = await cascade(r.state, r.changed, new Set([pkg]), params)
    return { state: rest.state, changed: rest.changed, ran: [r.ran, ...rest.ran] }
  }

  const act: StateEngine['act'] = async (state, pkg, actionId, params = {}) => {
    const p = byName.get(pkg)
    const a = p?.spec.actions.find((x) => x.id === actionId)
    if (!p || !a) throw new StateRefusal([`package "${pkg}" suggests no action "${actionId}"`])
    if (a.call) return call(state, pkg, a.call, params)
    return dispatch(state, a.ops ?? [], params)
  }

  return { order, start, apply, dispatch, call, act, affected }
}

/** A session's STATE over time: one current STATE, and a generation so a run for an older STATE is dropped. */
export function createStateSession(engine: StateEngine, initial: State) {
  let current = initial
  let generation = 0
  const settle = async (work: (s: State) => Promise<Outcome>): Promise<(Outcome & { stale: false }) | { stale: true }> => {
    const mine = ++generation
    const out = await work(current)
    if (mine !== generation) return { stale: true }   // a newer intent arrived while this ran: its result wins
    current = out.state
    return { ...out, stale: false }
  }
  return {
    get state() { return current },
    dispatch: (ops: Op[], params?: Record<string, unknown>) => settle((s) => engine.dispatch(s, ops, params)),
    call: (pkg: string, fn: string, params?: Record<string, unknown>) => settle((s) => engine.call(s, pkg, fn, params)),
    act: (pkg: string, id: string, params?: Record<string, unknown>) => settle((s) => engine.act(s, pkg, id, params)),
  }
}
