// ── The platform's shapes — one definition, used in the engine, in Workers and in the browser ────────────────────
//
// The words are docs/platform-architecture.md's: scope, STATE and its slices, ops and intents, programs and the
// packages they bring to STATE, answers and the answer history, agents, sessions, the decision state and the
// governance log. Each shape has a type and a check; a check answers with sentences (what is wrong, where), never a
// stack trace, and an empty list when the value is good. No dependencies.

export type Problems = string[]

// ── Scope ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** global · group:<name> · user:<id> */
export type Scope = 'global' | `group:${string}` | `user:${string}`
export const isScope = (v: unknown): v is Scope => v === 'global' || (typeof v === 'string' && /^(group|user):[^\s:]+$/.test(v))

// ── Slice schemas: the small type language a package declares its part of STATE in ────────────────────────────────
/** string · number · boolean · date (YYYY-MM-DD) · json (anything) · one of a list · a list · an object · nullable */
export type Field =
  | 'string' | 'number' | 'boolean' | 'date' | 'json'
  | { enum: (string | number)[] }
  | { list: Field }
  | { object: SliceSchema }
  | { nullable: Field }
export type SliceSchema = Record<string, Field>

const kindOf = (f: Field): string => (typeof f === 'string' ? f : 'enum' in f ? 'enum' : 'list' in f ? 'list' : 'object' in f ? 'object' : 'nullable')

/** Is this a well-formed slice schema? */
export function checkSchema(schema: unknown, at = 'schema'): Problems {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [`${at} must be an object of field types`]
  const out: Problems = []
  for (const [k, f] of Object.entries(schema as Record<string, unknown>)) out.push(...checkField(f, `${at}.${k}`))
  return out
}
function checkField(f: unknown, at: string): Problems {
  if (typeof f === 'string') return ['string', 'number', 'boolean', 'date', 'json'].includes(f) ? [] : [`${at}: "${f}" is not a type (string, number, boolean, date, json)`]
  if (!f || typeof f !== 'object') return [`${at}: a field type is a name or { enum | list | object | nullable }`]
  const o = f as Record<string, unknown>
  if (Array.isArray(o.enum)) return o.enum.length ? [] : [`${at}: an enum lists at least one value`]
  if ('list' in o) return checkField(o.list, `${at}[]`)
  if ('object' in o) return checkSchema(o.object, at)
  if ('nullable' in o) return checkField(o.nullable, at)
  return [`${at}: a field type is a name or { enum | list | object | nullable }`]
}

/** Does a value fit a field type? */
export function checkValue(f: Field, v: unknown, at: string): Problems {
  if (typeof f === 'object' && 'nullable' in f) return v === null ? [] : checkValue(f.nullable, v, at)
  if (v === undefined) return [`${at} is missing`]
  switch (kindOf(f)) {
    case 'string': return typeof v === 'string' ? [] : [`${at} must be text, not ${show(v)}`]
    case 'number': return typeof v === 'number' && Number.isFinite(v) ? [] : [`${at} must be a number, not ${show(v)}`]
    case 'boolean': return typeof v === 'boolean' ? [] : [`${at} must be true or false, not ${show(v)}`]
    case 'date': return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? [] : [`${at} must be a date (YYYY-MM-DD), not ${show(v)}`]
    case 'json': return []
    case 'enum': { const e = (f as { enum: (string | number)[] }).enum; return e.includes(v as any) ? [] : [`${at} must be one of ${e.map((x) => JSON.stringify(x)).join(', ')}, not ${show(v)}`] }
    case 'list': return Array.isArray(v) ? v.flatMap((x, i) => checkValue((f as { list: Field }).list, x, `${at}[${i}]`)) : [`${at} must be a list, not ${show(v)}`]
    case 'object': return checkObject((f as { object: SliceSchema }).object, v, at)
  }
  return [`${at}: unknown type`]
}
/** Does an object fit a schema? Every declared field must be present (null where nullable); no undeclared fields. */
export function checkObject(schema: SliceSchema, v: unknown, at: string): Problems {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [`${at} must be an object, not ${show(v)}`]
  const out: Problems = []
  for (const [k, f] of Object.entries(schema)) out.push(...checkValue(f, (v as Record<string, unknown>)[k], `${at}.${k}`))
  for (const k of Object.keys(v)) if (!(k in schema)) out.push(`${at}.${k} is not declared`)
  return out
}
const show = (v: unknown) => (v === undefined ? 'nothing' : JSON.stringify(v)?.slice(0, 60) ?? String(v))

// ── STATE, ops and intents ────────────────────────────────────────────────────────────────────────────────────────
/** The last block's STATE: which package (by program hash) owns each slice, the slices, and the agent's own keys. */
export interface State {
  packages: Record<string, string>
  agent?: AgentKeys
  [slice: string]: unknown
}
/** The ICA's own slice: mostly the canonical question for this STATE and what the answer history shows. */
export interface AgentKeys { question?: string; seeing?: string; [key: string]: unknown }

/** The only ways STATE changes. A path is `<slice>.<field>[.<field>…]`. */
export type Op =
  | { op: 'set'; path: string; value: unknown }
  | { op: 'add'; path: string; value: unknown }       // append to a list
  | { op: 'remove'; path: string; value?: unknown }   // a list item equal to value, or the field back to null

export type Destination = 'new' | 'current'
export interface Intent {
  id: string
  session: string
  /** structured: ops from a control · language: the words a person typed (the ICA turns them into ops and an answer) */
  kind: 'structured' | 'language'
  ops?: Op[]
  text?: string
  /** Where the result goes: a new block, or replacing the current block's answer. */
  to: Destination
  /** An action a package suggested, when the intent is one. */
  action?: { package: string; id: string }
  /** A package function called with parameters (run is the default). */
  call?: { package: string; fn: string; params?: Record<string, unknown> }
  /** The block it was sent from; left out, the session's current block. An earlier block branches. */
  block?: string
  /** A language intent's outcome, from the ICA: the STATE change it read from the words, and its answer. */
  result?: { ops?: Op[]; markdown?: string; files?: string[]; blocks?: Record<string, Record<string, unknown>> }
  /** A language intent's question id: its answer is committed at <session>/<qid>/answer.md. */
  qid?: string
  by: string
  at: string
}

export function checkOp(v: unknown, at = 'op'): Problems {
  if (!v || typeof v !== 'object') return [`${at} must be an object`]
  const o = v as Record<string, unknown>
  const out: Problems = []
  if (!['set', 'add', 'remove'].includes(o.op as string)) out.push(`${at}.op must be set, add or remove, not ${show(o.op)}`)
  if (typeof o.path !== 'string' || !/^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)+$/.test(o.path)) out.push(`${at}.path must be <slice>.<field>, not ${show(o.path)}`)
  if ((o.op === 'set' || o.op === 'add') && !('value' in o)) out.push(`${at}: ${o.op} needs a value`)
  return out
}
export function checkIntent(v: unknown): Problems {
  if (!v || typeof v !== 'object') return ['an intent must be an object']
  const o = v as Record<string, unknown>
  const out: Problems = []
  for (const k of ['id', 'session', 'by', 'at']) if (typeof o[k] !== 'string' || !o[k]) out.push(`intent.${k} is required`)
  if (o.kind !== 'structured' && o.kind !== 'language') out.push('intent.kind must be structured or language')
  if (o.to !== 'new' && o.to !== 'current') out.push('intent.to must be new or current')
  if (o.kind === 'structured' && !(Array.isArray(o.ops) && o.ops.length) && !o.action && !o.call) out.push('a structured intent carries ops, an action or a call')
  if (o.ops !== undefined) {
    if (!Array.isArray(o.ops)) out.push('intent.ops must be a list')
    else o.ops.forEach((op, i) => out.push(...checkOp(op, `intent.ops[${i}]`)))
  }
  const a = o.action as Record<string, unknown> | undefined
  if (a !== undefined && (typeof a?.package !== 'string' || typeof a?.id !== 'string')) out.push('intent.action names its package and id')
  const c = o.call as Record<string, unknown> | undefined
  if (c !== undefined && (typeof c?.package !== 'string' || typeof c?.fn !== 'string')) out.push('intent.call names its package and fn')
  if (o.kind === 'language') {
    if (typeof o.text !== 'string' || !o.text.trim()) out.push('a language intent carries its text')
    const r = o.result as Record<string, unknown> | undefined
    if (r?.ops !== undefined) (Array.isArray(r.ops) ? r.ops : [null]).forEach((op, i) => out.push(...checkOp(op, `intent.result.ops[${i}]`)))
  }
  return out
}

/** Libraries the platform supplies to every program's React side when it is loaded: a program imports them, never
 *  bundles them, so every program on a screen uses the same copy. Anything else goes into the program's own files. */
export const PLATFORM_LIBRARIES = ['react', 'react/jsx-runtime', 'react-dom', 'echarts', '@superatom/ui', '@superatom/design'] as const
export type PlatformLibrary = (typeof PLATFORM_LIBRARIES)[number]

// ── Programs and the packages they bring to STATE ─────────────────────────────────────────────────────────────────
/** What a function produces: data, an action (a change outside STATE), or a view (an answer appended to the session). */
export type Produces = 'data' | 'action' | 'view'
export interface FunctionSpec { name: string; produces: Produces; doc?: string }
/** Something a program suggests, shown among the session's possible actions: a function to call, or plain ops. */
export interface ActionSpec { id: string; label: string; call?: string; ops?: Op[] }
/** A write outside the session: goes through the governance path, never through STATE. */
export interface CommandSpec { id: string; label: string; permission: string }

export interface PackageSpec {
  /** The slice it owns: STATE.<owns>. Exactly one package owns a path. */
  owns: string
  schema: SliceSchema
  /** The slice when the package joins a STATE. */
  initial: Record<string, unknown>
  /** Paths of other slices that re-run it when they change (the author's choice; empty: only its own changes and its actions). */
  reads: string[]
  /** `run` is the default; every function is called with the whole STATE, frozen, and may change only its own slice. */
  functions: FunctionSpec[]
  actions: ActionSpec[]
  commands: CommandSpec[]
  /** Its small documentation, injected into the agent (path inside the program). */
  doc: string
}

export interface ProgramManifest {
  id: string
  name: string
  /** Content hash of the built bundles: a program is immutable; a change is a new hash. */
  hash: string
  version: number
  scope: Scope
  owner: string
  /** Path in the org knowledge index tree: procurement.contract … */
  attachesTo: string
  node: { bundle: string; runtime: ('on-prem' | 'worker')[] }
  /** The React side: one or more blocks it gives the UI. */
  ui: { bundle: string; blocks: string[]; /** Blocks drawn above the step's answer (its controls). */ head?: string[] }
  /** Datasource index nodes it reads. */
  reads: string[]
  /** Its part in STATE, when it takes part. */
  package?: PackageSpec
  published: boolean
  /** A library: functions (and components) other programs use — no STATE, no blocks of its own. */
  kind?: 'library'
  /** The libraries built into it, each by name and the hash of the build that went in (node/lib/<name>, web/lib/<name>). */
  uses?: { name: string; hash: string }[]
}

export function checkPackage(v: unknown, at = 'package'): Problems {
  if (!v || typeof v !== 'object') return [`${at} must be an object`]
  const p = v as Record<string, unknown>
  const out: Problems = []
  if (typeof p.owns !== 'string' || !/^[A-Za-z_][\w-]*$/.test(p.owns)) out.push(`${at}.owns must name its slice (a word)`)
  if (p.owns === 'packages' || p.owns === 'agent') out.push(`${at}.owns: "${p.owns}" is the platform's, not a package's`)
  out.push(...checkSchema(p.schema, `${at}.schema`))
  if (!out.length) out.push(...checkObject(p.schema as SliceSchema, p.initial, `${at}.initial`))
  if (!Array.isArray(p.reads)) out.push(`${at}.reads must be a list of paths`)
  else p.reads.forEach((r, i) => { if (typeof r !== 'string' || !r.includes('.')) out.push(`${at}.reads[${i}] must be <slice>.<field>`); else if (r.split('.')[0] === p.owns) out.push(`${at}.reads[${i}]: its own slice re-runs it already`) })
  const fns = Array.isArray(p.functions) ? (p.functions as FunctionSpec[]) : []
  if (!fns.some((f) => f?.name === 'run')) out.push(`${at}.functions must include run, the default`)
  fns.forEach((f, i) => { if (!['data', 'action', 'view'].includes(f?.produces)) out.push(`${at}.functions[${i}].produces must be data, action or view`) })
  const names = new Set(fns.map((f) => f?.name))
  for (const [i, a] of ((p.actions as ActionSpec[]) ?? []).entries()) {
    if (!a?.id || !a?.label) out.push(`${at}.actions[${i}] needs an id and a label`)
    if (!a?.call && !a?.ops) out.push(`${at}.actions[${i}] calls a function or carries ops`)
    if (a?.call && !names.has(a.call)) out.push(`${at}.actions[${i}] calls "${a.call}", which the package does not have`)
    a?.ops?.forEach((op, j) => { out.push(...checkOp(op, `${at}.actions[${i}].ops[${j}]`)); if ((op as Op).path?.split('.')[0] !== p.owns) out.push(`${at}.actions[${i}].ops[${j}] changes another package's slice`) })
  }
  for (const [i, c] of ((p.commands as CommandSpec[]) ?? []).entries()) if (!c?.id || !c?.label || !c?.permission) out.push(`${at}.commands[${i}] needs an id, a label and a permission`)
  if (typeof p.doc !== 'string' || !p.doc) out.push(`${at}.doc is required: without it an agent cannot use the package`)
  return out
}

export function checkProgram(v: unknown): Problems {
  if (!v || typeof v !== 'object') return ['a program manifest must be an object']
  const m = v as Record<string, unknown>
  const out: Problems = []
  for (const k of ['id', 'name', 'hash', 'owner', 'attachesTo']) if (typeof m[k] !== 'string' || !m[k]) out.push(`program.${k} is required`)
  if (!isScope(m.scope)) out.push(`program.scope must be global, group:<name> or user:<id>, not ${show(m.scope)}`)
  if (typeof m.attachesTo === 'string' && !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(m.attachesTo)) out.push('program.attachesTo is a path of the org knowledge index: words joined by dots')
  const node = m.node as Record<string, unknown> | undefined, ui = m.ui as Record<string, unknown> | undefined
  if (!node || typeof node.bundle !== 'string') out.push('program.node.bundle is required: a program is a Node.js bundle and a React bundle')
  const library = m.kind === 'library'
  if (m.kind !== undefined && !library) out.push('program.kind is "library" or left out')
  if (!ui || typeof ui.bundle !== 'string' || !Array.isArray(ui.blocks) || (!library && !ui.blocks.length)) out.push('program.ui needs its bundle and the blocks it gives the UI')
  if (library && Array.isArray(ui?.blocks) && ui!.blocks.length) out.push('a library gives no blocks of its own: its components are drawn by the programs that use it')
  if (library && m.package !== undefined) out.push('a library takes no part in STATE: no package')
  if (m.uses !== undefined && (!Array.isArray(m.uses) || m.uses.some((u: any) => !u || typeof u.name !== 'string' || !/^[0-9a-f]{64}$/.test(String(u.hash))))) out.push('program.uses lists each library built in, by name and hash')
  if (m.package !== undefined) out.push(...checkPackage(m.package, 'program.package'))
  return out
}

/** Packages that may share one STATE: each slice owned once; every read names a slice some package owns. */
export function checkPackages(packages: PackageSpec[]): Problems {
  const out: Problems = []
  const owners = new Map<string, number>()
  packages.forEach((p, i) => { if (owners.has(p.owns)) out.push(`two packages own the slice "${p.owns}" — a path has exactly one owner`); owners.set(p.owns, i) })
  for (const p of packages) for (const r of p.reads) if (!owners.has(r.split('.')[0])) out.push(`"${p.owns}" reads ${r}, but no package owns "${r.split('.')[0]}"`)
  return out
}

// ── Answers ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** One entry of the answer history: what a run or the ICA showed, from which STATE, in which block. */
export interface Answer {
  id: string
  session: string
  block: string
  /** The intent that produced it. */
  cause: string
  /** The STATE it was made from, by hash. */
  stateHash: string
  at: string
  /** Markdown; marker lines (`:::table data/x.json`) name the blocks and components it shows. */
  markdown: string
  /** Files the markers name, by path, as the session holds them. */
  files: string[]
  /** Blocks the markers name, carried with the answer (a program's data, by the name its marker line gives). */
  blocks?: Record<string, Record<string, unknown>>
  /** It replaced the block's previous answer (an intent to the current view) rather than opening the block. */
  replaced?: string
  /** The figures it showed, by name — what the decision memory compares a later step's world with. */
  world?: Record<string, number>
}

// ── Agents and sessions ───────────────────────────────────────────────────────────────────────────────────────────
export interface AgentSpec {
  id: string
  name: string
  scope: Scope
  owner: string
  /** The composition-graph domain whose concepts make its system prompt. */
  domain: string
  /** Programs it may run, by id; the session filters them by the user's scope. */
  programs: string[]
  /** The tools it is given (platform code), by name. */
  tools: string[]
  /** STATE when a session starts: fields over each package's initial slice, by slice. */
  start?: Record<string, Record<string, unknown>>
  /** The pre-designed starting UI and the structured intents its controls send. */
  ui: { start: string }
  ica: string
  /** The one agent a question no other agent fits goes to. */
  isDefault?: boolean
  /** How it is shown wherever it is listed: an iconify icon, an accent (a token name), one line on what it is for. */
  look?: AgentLook
  /** Its starting points: each opens a session on a STATE of its own (fields by slice over the agent's start). */
  starts?: AgentStart[]
}
export interface AgentLook { icon?: string; accent?: string; says?: string; /** Its main view: what opening it shows, named as that view is. */ main?: { label: string; says?: string } }
export interface AgentStart { key: string; label: string; says?: string; start: Record<string, Record<string, unknown>> }

// ── The project's map ────────────────────────────────────────────────────────────────────────────────────────────
// What the people of a project see to find their way: sections, each a list of places, each place an agent. It is a
// node of the composition graph (kind "map", named "map"), written by the project's admins; a place's slug is its
// address (/<slug>). Agents not on the map are found by search and on the All agents page.

export interface MapItem { agent: string; slug?: string; label?: string; icon?: string }
export interface MapSection { label: string; items: MapItem[] }
/** `home`: the agent whose view is the front page — what someone sees first (what needs them today). */
export interface ProjectMap { sections: MapSection[]; home?: string }

/** The user app's own addresses — never a place's slug. */
export const APP_PAGES = ['about', 'agents', 'activity', 'connections', 'profile', 'settings'] as const
export const RESERVED_SLUGS: readonly string[] = [...APP_PAGES, 'a', 'c', 's', 'w', 'u', 'dashboard', 'admin', 'api', 'ws', 'assets', 'auth']
/** A place's address: its slug, else its agent's name. */
export const slugOf = (item: MapItem): string => item.slug ?? item.agent

export function checkMap(v: unknown): Problems {
  if (!v || typeof v !== 'object' || !Array.isArray((v as any).sections)) return ['a map lists its sections']
  const out: Problems = []
  const seen = new Set<string>()
  if ((v as any).home !== undefined && (typeof (v as any).home !== 'string' || !(v as any).home.trim())) out.push('the home names an agent')
  for (const [i, s] of ((v as any).sections as any[]).entries()) {
    if (!s || typeof s.label !== 'string' || !s.label.trim()) { out.push(`section ${i + 1} has a label`); continue }
    if (!Array.isArray(s.items)) { out.push(`section "${s.label}" lists its items`); continue }
    for (const it of s.items) {
      if (!it || typeof it.agent !== 'string' || !it.agent) { out.push(`an item of "${s.label}" names its agent`); continue }
      for (const k of ['slug', 'label', 'icon'] as const) if (it[k] !== undefined && (typeof it[k] !== 'string' || !it[k].trim())) out.push(`"${it.agent}": its ${k} is text`)
      const slug = slugOf(it)
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) out.push(`"${slug}" is not an address: lower-case letters, digits and dashes`)
      else if (RESERVED_SLUGS.includes(slug)) out.push(`"${slug}" is one of the app's own addresses — give the place a slug`)
      else if (seen.has(slug)) out.push(`two places have the address "${slug}"`)
      seen.add(slug)
    }
  }
  return out
}

export function checkAgent(v: unknown): Problems {
  if (!v || typeof v !== 'object') return ['an agent must be an object']
  const o = v as Record<string, unknown>
  const out: Problems = []
  for (const k of ['id', 'name', 'owner', 'domain', 'ica']) if (typeof o[k] !== 'string' || !o[k]) out.push(`agent.${k} is required`)
  if (typeof o.scope !== 'string' || !/^(global|group:.+|user:.+)$/.test(o.scope)) out.push('agent.scope must be global, group:<name> or user:<id>')
  if (!Array.isArray(o.programs) || o.programs.some((p) => typeof p !== 'string' || !p)) out.push('agent.programs must be a list of program names or hashes')
  if (!Array.isArray(o.tools) || o.tools.some((t) => typeof t !== 'string')) out.push('agent.tools must be a list of tool names')
  const ui = o.ui as Record<string, unknown> | undefined
  if (!ui || typeof ui.start !== 'string') out.push('agent.ui.start names its starting UI')
  return out
}

export interface Session {
  id: string
  /** Always one user's. */
  user: string
  agent: string
  /** The last block's STATE. */
  state: State
  /** The blocks, a tree: changing an earlier block branches from it. */
  blocks: { id: string; parent: string | null; answer: string | null; stateHash: string }[]
  /** The active leaf. */
  leaf: string
  created: string
  updated: string
}

// ── Decision state (a first cut; to be expanded) ──────────────────────────────────────────────────────────────────
/** A state with a memory of the data that passed through it, the states it is made of, and for each the possible
 *  outcomes, actions or paths a person can take, with the reasoning behind each. */
export interface DecisionState {
  id: string
  name: string
  states: string[]
  options: { id: string; kind: 'outcome' | 'action' | 'path'; label: string; reasoning: string; leadsTo?: string }[]
  /** What has passed through it: a reference to each dataset, when. */
  memory: { at: string; data: string; note?: string }[]
}

// ── Governance ────────────────────────────────────────────────────────────────────────────────────────────────────
export type GovernanceAction = 'create' | 'edit' | 'suggest' | 'approve' | 'reject' | 'grant' | 'revoke' | 'publish' | 'promote' | 'transfer'
/** One entry of the append-only log: nothing is removed, any past state can be rebuilt from these. */
export interface GovernanceEntry {
  seq: number
  at: string
  by: string
  item: string
  action: GovernanceAction
  /** Content hashes, before and after (null where there was none). */
  from: string | null
  to: string | null
  reason: string
  /** For grant/revoke: who, and what they may do. For approve/reject: the suggestion's seq. */
  subject?: string
  permission?: string
  decides?: number
}
export function checkGovernanceEntry(v: unknown): Problems {
  if (!v || typeof v !== 'object') return ['a governance entry must be an object']
  const e = v as Record<string, unknown>
  const out: Problems = []
  if (!Number.isInteger(e.seq) || (e.seq as number) < 1) out.push('entry.seq is a positive whole number')
  for (const k of ['at', 'by', 'item', 'reason']) if (typeof e[k] !== 'string' || !e[k]) out.push(`entry.${k} is required`)
  if (!['create', 'edit', 'suggest', 'approve', 'reject', 'grant', 'revoke', 'publish', 'promote', 'transfer'].includes(e.action as string)) out.push(`entry.action ${show(e.action)} is not one the log knows`)
  if ((e.action === 'grant' || e.action === 'revoke') && (!e.subject || !e.permission)) out.push(`a ${e.action} names its subject and permission`)
  if ((e.action === 'approve' || e.action === 'reject') && !Number.isInteger(e.decides)) out.push(`an ${e.action} names the suggestion it decides (decides: its seq)`)
  return out
}

// ── Audit history ─────────────────────────────────────────────────────────────────────────────────────────────────
/** Who did something: a person, an agent key, the engine, or the platform itself. */
export type AuditActor = { kind: 'user' | 'agent' | 'engine' | 'system'; id: string; email?: string }
/** One thing that happened, whichever way it was done: who, through what, did what, to what, and how it ended.
 *  Append-only; never changed or removed. */
export interface AuditEvent {
  id: string
  at: string
  project: string
  actor: AuditActor
  /** The way it came: the user UI, the admin console, an agent (with an agent key), the engine, the platform's API. */
  via: 'ui' | 'admin' | 'agent' | 'engine' | 'api' | 'channel' | 'system'
  /** What was done, `<thing>.<verb>`: `question.ask`, `session.intent`, `agent-key.create`, … */
  action: string
  target?: string
  outcome: 'ok' | 'refused' | 'error'
  /** What it was, as recorded: a question's words, an intent's ops, a refusal's reason. */
  detail?: Record<string, unknown>
}

export function checkAuditEvent(v: unknown): Problems {
  if (!v || typeof v !== 'object') return ['an audit event must be an object']
  const o = v as Record<string, unknown>
  const out: Problems = []
  for (const k of ['id', 'at', 'project', 'action']) if (typeof o[k] !== 'string' || !o[k]) out.push(`audit.${k} is required`)
  if (typeof o.action === 'string' && !/^[a-z][\w-]*(\.[a-z][\w-]*)+$/.test(o.action)) out.push(`audit.action is <thing>.<verb>, not ${show(o.action)}`)
  const a = o.actor as Record<string, unknown> | undefined
  if (!a || !['user', 'agent', 'engine', 'system'].includes(a.kind as string) || typeof a.id !== 'string' || !a.id) out.push('audit.actor names its kind (user, agent, engine, system) and id')
  if (!['ui', 'admin', 'agent', 'engine', 'api', 'channel', 'system'].includes(o.via as string)) out.push(`audit.via must be ui, admin, agent, engine, api, channel or system, not ${show(o.via)}`)
  if (!['ok', 'refused', 'error'].includes(o.outcome as string)) out.push(`audit.outcome must be ok, refused or error, not ${show(o.outcome)}`)
  return out
}
