// ── What a program says it is, in its own code (docs/programs-design.md "Where a program says what it is") ────────────
//
// A program's functions and views are written and exported as usual. Beside them each side says what it offers, by
// reference — never their code:
//
//   server/index.ts   export const program = defineProgram({ state, functions: { run: fn(run, {...}) }, filters, options })
//   web/index.tsx     export const views = defineViews({ RevenueTrend: view(RevenueTrend, {...}) })
//
// A definition is static data: inspect() gives it as JSON, never running a function or reading data. The build runs
// each side's definition once and keeps what it says (server.json, web.json) inside the build's hash; the engine, the
// page and ./inspect read those. This module is pure — no imports — so the build can run it anywhere.

/** A field of STATE or a param: its type, in the slice schema's small language. */
export type FieldType =
  | 'string' | 'number' | 'boolean' | 'date' | 'json'
  | { enum: (string | number)[] } | { list: FieldType } | { object: Record<string, FieldType> } | { nullable: FieldType }
/** A field: its type, and where it starts (for STATE; a param's start is unused). */
export interface Field { type: FieldType; initial: unknown }

const f = (type: FieldType, initial: unknown): Field => ({ type, initial })
/** The field types, each with where it starts. A nullable field starts empty, and as a param may be left out. */
export const field = {
  string: (initial = '') => f('string', initial),
  number: (initial = 0) => f('number', initial),
  boolean: (initial = false) => f('boolean', initial),
  date: (initial = '') => f('date', initial),
  json: (initial: unknown = null) => f('json', initial),
  enum: <T extends string | number>(values: T[], initial?: T) => f({ enum: values }, initial ?? values[0]),
  list: (of: Field | FieldType, initial: unknown[] = []) => f({ list: typeOf(of) }, initial),
  object: (fields: Record<string, Field | FieldType>, initial: Record<string, unknown> = {}) => f({ object: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeOf(v)])) }, initial),
  nullable: (of: Field | FieldType) => f({ nullable: typeOf(of) }, null),
}
const typeOf = (x: Field | FieldType): FieldType => (x && typeof x === 'object' && 'type' in x ? (x as Field).type : x as FieldType)

type Ref = (...args: any[]) => unknown
/** What a function produces: a view (a step), data (JSON to its caller), or an action (an effect outside STATE). */
export type Produces = 'view' | 'data' | 'action'

export interface FnDef { produces: Produces; doc?: string; params?: Record<string, Field | FieldType>; /** An action's approval route: a function of the program computing who approves. */ approval?: Ref }
export interface FnDescription { name: string; export: string; produces: Produces; doc?: string; params?: Record<string, FieldType>; approval?: string }
export interface DefinedFn extends FnDef { ref: Ref; inspect(): FnDescription }

/** A function the program offers: the function itself (exported as usual), and what it is. */
export function fn(ref: Ref, def: FnDef): DefinedFn {
  if (typeof ref !== 'function') throw new Error(`fn(…) takes the function itself, not ${JSON.stringify(ref)}`)
  return { ref, ...def, inspect: () => describeFn(ref.name, { ref, ...def }) }
}
const nameOf = (r: Ref | undefined, exports?: Map<Ref, string>) => (r ? exports?.get(r) ?? r.name : undefined)
const describeFn = (name: string, d: FnDef & { ref: Ref }, exports?: Map<Ref, string>): FnDescription => ({
  name, export: nameOf(d.ref, exports)!, produces: d.produces, ...(d.doc ? { doc: d.doc } : {}),
  ...(d.params ? { params: Object.fromEntries(Object.entries(d.params).map(([k, v]) => [k, typeOf(v)])) } : {}),
  ...(d.approval ? { approval: nameOf(d.approval, exports) } : {}),
})

export interface FilterDef { field: string; label: string; /** The function computing its choices from the data. */ options: Ref; size?: 'small' | 'medium' | 'large'; noun?: [string, string]; unit?: string }
export interface ProgramDef {
  /** Its STATE: each field's type and where it starts. */
  state: Record<string, Field>
  /** Paths of other programs' STATE that run it again when they change. */
  watches?: string[]
  /** What it offers — `run`, the default, and any others — by the name they are called by. */
  functions: Record<string, DefinedFn>
  /** Its option functions: each computes one next move for the step it is at. */
  options?: Ref[]
  filters?: FilterDef[]
  breakdown?: { field: string; label?: string; choices: { value: string; label: string }[] }
  /** What is wrong with its STATE as a change from outside would leave it — asked before such a change is kept. */
  check?: Ref
}
export interface ProgramDescription {
  state: { schema: Record<string, FieldType>; initial: Record<string, unknown> }
  watches: string[]
  functions: FnDescription[]
  options: string[]
  filters: (Omit<FilterDef, 'options'> & { options: string })[]
  breakdown?: ProgramDef['breakdown']
  check?: string
}
export interface DefinedProgram {
  def: ProgramDef
  functions: Record<string, DefinedFn>
  /** What it says it is, as data — each reference by its export's name (the build gives the names; else the function's own). */
  inspect(exports?: Map<Ref, string>): ProgramDescription
}

/** What a program's server side offers. */
export function defineProgram(def: ProgramDef): DefinedProgram {
  const functions = Object.fromEntries(Object.entries(def.functions).map(([name, d]) => [name, { ...d, inspect: () => describeFn(name, d) }]))
  return {
    def, functions,
    inspect: (exports) => ({
      state: { schema: Object.fromEntries(Object.entries(def.state).map(([k, v]) => [k, typeOf(v)])), initial: Object.fromEntries(Object.entries(def.state).map(([k, v]) => [k, v.initial])) },
      watches: def.watches ?? [],
      functions: Object.entries(def.functions).map(([name, d]) => describeFn(name, d, exports)),
      options: (def.options ?? []).map((r) => nameOf(r, exports)!),
      filters: (def.filters ?? []).map((x) => ({ ...x, options: nameOf(x.options, exports)! })),
      ...(def.breakdown ? { breakdown: def.breakdown } : {}),
      ...(def.check ? { check: nameOf(def.check, exports) } : {}),
    }),
  }
}

/** A move a view can make: ops on a STATE field, or a call of a program's function. */
export type Send = { set: string } | { add: string } | { remove: string } | { call: string }
export interface ViewDef { doc?: string; /** Above the step's answer (its controls), or with it (the default). */ place?: 'head' | 'body'; /** The STATE fields it shows. */ reads?: string[]; /** The moves it can make. */ sends?: Send[] }
export interface ViewDescription { name: string; export: string; doc?: string; place: 'head' | 'body'; reads: string[]; sends: Send[] }
export interface DefinedView extends ViewDef { ref: Ref; inspect(): ViewDescription }

/** A view the program draws: the component itself (exported as usual), and what it is. */
export function view(ref: Ref, def: ViewDef = {}): DefinedView {
  if (typeof ref !== 'function') throw new Error(`view(…) takes the component itself, not ${JSON.stringify(ref)}`)
  return { ref, ...def, inspect: () => describeView(ref.name, { ref, ...def }) }
}
const describeView = (name: string, d: ViewDef & { ref: Ref }, exports?: Map<Ref, string>): ViewDescription => ({
  name, export: nameOf(d.ref, exports)!, ...(d.doc ? { doc: d.doc } : {}), place: d.place ?? 'body', reads: d.reads ?? [], sends: d.sends ?? [],
})
export interface ViewsDescription { as: 'block' | 'ui'; views: ViewDescription[] }
export interface DefinedViews { views: Record<string, DefinedView>; inspect(exports?: Map<Ref, string>): ViewsDescription }

/** What a program's web side draws: its views, by name, in order. `as: 'ui'` — drawn alone, the full width. */
export function defineViews(views: Record<string, DefinedView>, o: { as?: 'block' | 'ui' } = {}): DefinedViews {
  const named = Object.fromEntries(Object.entries(views).map(([name, d]) => [name, { ...d, inspect: () => describeView(name, d) }]))
  return { views: named, inspect: (exports) => ({ as: o.as ?? 'block', views: Object.entries(views).map(([name, d]) => describeView(name, d, exports)) }) }
}

// What a program's functions are given and return (the platform's types, as the SDK gives them).
export type { ProgramContext, ProgramServices, FunctionResult, OptionContext, OptionFunction, Option, Step } from '@superatom/state'
