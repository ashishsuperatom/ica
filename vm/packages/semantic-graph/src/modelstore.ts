// ── THE MODEL, KEPT AS A GRAPH AND CHANGED ONLY BY OPERATIONS (MODELING.md) ─────────────────────────────────────
//
// A model is nodes and edges in SQLite — entities, calendars, facts, measures, attributes, conditions, equations; the
// arrows between objects; where each object's rows are; the programs that produce rows; settings. It is changed by
// operations, each checked before anything is written and recorded with who asked, why and where it came from:
//
//   refused when it would duplicate    a name, or a synonym that is already another object's or condition's name
//   refused when it would break        the derived schema (or its bindings) would have a problem it did not have
//   refused when it would dangle       removing what something else refers to
//
// An operation is a pure step from one state to the next; the state written is the one checked. The schema a question
// is checked against is derived from the nodes and edges, never kept as a document.

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { arrows, schemaProblems, type Arrow, type AttributeDef, type ConditionDef, type Measure, type ObjectDef, type Schema } from './schema.js'
import { sourcesProblems, type ProgramDef } from './producers.js'
import type { EntitySource, FactSource, Sources } from './sql.js'

export interface ModelState {
  schema: Schema
  sources: Sources
  settings: Record<string, unknown>
  programs: Record<string, ProgramDef>
}

export type Operation =
  | { op: 'add-entity'; name: string; description?: string; synonyms?: string[]; members?: Record<string, string>; names?: Record<string, string>; history?: 'current' }
  | { op: 'add-calendar'; name: string; level?: string; fiscal?: ObjectDef['fiscal']; periods?: ObjectDef['periods']; description?: string; synonyms?: string[] }
  | { op: 'add-fact'; name: string; description?: string; synonyms?: string[]; history?: 'current' }
  | { op: 'add-arrow'; id: string; to: string; kind?: Arrow['kind']; partial?: boolean; synonyms?: string[] }
  | ({ op: 'add-measure'; id: string; description?: string } & Measure)
  | ({ op: 'add-attribute'; id: string } & AttributeDef)
  | ({ op: 'add-condition'; name: string } & ConditionDef)
  | { op: 'add-equation'; on: string; paths: [string[], string[]] }
  | { op: 'set'; id: string; property: string; value: unknown }
  | { op: 'rename'; id: string; to: string }
  | { op: 'remove'; id: string }
  | { op: 'promote-attribute'; id: string; entity: string }
  | { op: 'bind'; object: string; binding: FactSource | EntitySource }
  | { op: 'add-program'; name: string; program: ProgramDef }
  | { op: 'set-setting'; key: string; value: unknown }
  | { op: 'set-conversion'; conversion: Schema['conversion'] }

export interface ChangeContext { by: string; reason?: string; from?: string; dryRun?: boolean }
export type Applied = { ok: true; change: number | null; notes: string[]; state: ModelState } | { ok: false; reason: string }

export class Refused extends Error {}
const refuse = (m: string): never => { throw new Refused(m) }
const clone = <T>(x: T): T => structuredClone(x)
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const TABLES = `
CREATE TABLE IF NOT EXISTS g_model (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL, created_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS g_node (
  model TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, owner TEXT, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed', version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
  PRIMARY KEY (model, id)
);
CREATE TABLE IF NOT EXISTS g_edge (
  model TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL, role TEXT NOT NULL, target TEXT NOT NULL, body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, PRIMARY KEY (model, id)
);
CREATE TABLE IF NOT EXISTS g_binding (model TEXT NOT NULL, object TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, PRIMARY KEY (model, object));
CREATE TABLE IF NOT EXISTS g_program (model TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, PRIMARY KEY (model, name));
CREATE TABLE IF NOT EXISTS g_setting (model TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (model, key));
CREATE TABLE IF NOT EXISTS g_change (
  id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL, op TEXT NOT NULL,
  target TEXT, args TEXT NOT NULL, reason TEXT, source TEXT, applied INTEGER NOT NULL, refusal TEXT, touched TEXT
);
CREATE INDEX IF NOT EXISTS g_change_model ON g_change(model, id);
`

export class ModelStore {
  readonly db: DatabaseSync
  constructor(db: DatabaseSync | string) {
    if (typeof db === 'string') {
      if (db !== ':memory:') mkdirSync(dirname(db), { recursive: true })
      this.db = new DatabaseSync(db)
      this.db.exec('PRAGMA busy_timeout = 15000')
      this.db.exec('PRAGMA journal_mode = WAL')
    } else this.db = db
    this.db.exec(TABLES)
  }

  models(): string[] { return (this.db.prepare('SELECT name FROM g_model ORDER BY name').all() as any[]).map((r) => r.name) }
  has(model: string): boolean { return !!this.db.prepare('SELECT 1 FROM g_model WHERE name = ?').get(model) }
  /** The latest change applied to a model: a reader holding an older one reloads. */
  lastChange(model: string): number { return Number((this.db.prepare('SELECT MAX(id) AS n FROM g_change WHERE model = ? AND applied = 1').get(model) as any)?.n ?? 0) }

  createModel(model: string, ctx: ChangeContext): Applied {
    if (this.has(model)) return this.record(model, { op: 'create-model' } as any, model, ctx, `there is already a model "${model}"`)
    if (ctx.dryRun) return { ok: true, change: null, notes: [], state: emptyState(model) }
    this.db.exec('BEGIN')
    try {
      this.db.prepare('INSERT INTO g_model (name, created_at, created_by) VALUES (?, ?, ?)').run(model, Date.now(), ctx.by)
      const change = this.log(model, 'create-model', model, {}, ctx, null, [model])
      this.db.exec('COMMIT')
      return { ok: true, change, notes: [], state: emptyState(model) }
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }

  /** The model as it stands: its schema derived from nodes and edges, its bindings, programs and settings. */
  state(model: string): ModelState {
    if (!this.has(model)) throw new Error(`there is no model "${model}" — models here: ${this.models().join(', ') || 'none'}`)
    const s: Schema = { name: model, objects: {} }
    const nodes = this.db.prepare('SELECT id, kind, owner, body FROM g_node WHERE model = ? ORDER BY rowid').all(model) as any[]
    for (const n of nodes) if (['entity', 'calendar', 'fact'].includes(n.kind)) s.objects[n.id] = { kind: n.kind, ...JSON.parse(n.body) }
    for (const n of nodes) {
      const body = JSON.parse(n.body)
      if (n.kind === 'measure') ((s.objects[n.owner].measures ??= {}))[n.id.slice(n.owner.length + 1)] = body
      else if (n.kind === 'attribute') ((s.objects[n.owner].attributes ??= {}))[n.id.slice(n.owner.length + 1)] = body
      else if (n.kind === 'condition') ((s.conditions ??= {}))[n.id.slice('condition:'.length)] = body
      else if (n.kind === 'equation') (s.equations ??= []).push(body)
      else if (n.kind === 'conversion') s.conversion = body
      else if (n.kind === 'schema') Object.assign(s, body)
    }
    for (const e of this.db.prepare('SELECT source, role, target, body FROM g_edge WHERE model = ? ORDER BY rowid').all(model) as any[]) {
      const body = JSON.parse(e.body)
      ;((s.objects[e.source].arrows ??= {}))[e.role] = Object.keys(body).length ? { to: e.target, ...body } : e.target
    }
    const sources: Sources = { facts: {}, entities: {} }
    for (const b of this.db.prepare('SELECT object, body FROM g_binding WHERE model = ? ORDER BY rowid').all(model) as any[]) {
      const kind = s.objects[b.object]?.kind
      if (kind === 'fact') sources.facts[b.object] = JSON.parse(b.body)
      else sources.entities[b.object] = JSON.parse(b.body)
    }
    const programs = Object.fromEntries((this.db.prepare('SELECT name, body FROM g_program WHERE model = ? ORDER BY rowid').all(model) as any[]).map((p) => [p.name, JSON.parse(p.body)]))
    const settings = Object.fromEntries((this.db.prepare('SELECT key, value FROM g_setting WHERE model = ? ORDER BY rowid').all(model) as any[]).map((x) => [x.key, JSON.parse(x.value)]))
    return { schema: s, sources, settings, programs }
  }

  /** Apply one operation: checked on the state it would leave, written with its change record — or refused and recorded. */
  apply(model: string, op: Operation, ctx: ChangeContext): Applied {
    const before = this.state(model)
    let next: { state: ModelState; notes: string[]; touched: string[] }
    try {
      next = step(before, op)
      const problems = (st: ModelState) => [...schemaProblems(st.schema), ...(Object.keys(st.sources.facts).length || Object.keys(st.sources.entities).length ? sourcesProblems(st.schema, st.sources).map((p) => `binding: ${p}`) : [])]
      const had = new Set(problems(before))
      const added = problems(next.state).filter((p) => !had.has(p))
      if (added.length) refuse(`it would leave the model with ${added.length === 1 ? 'a problem' : 'problems'}: ${added.join('; ')}`)
    } catch (e: any) {
      if (!(e instanceof Refused)) throw e
      return this.record(model, op, targetOf(op), ctx, e.message)
    }
    if (ctx.dryRun) return { ok: true, change: null, notes: next.notes, state: next.state }
    this.db.exec('BEGIN')
    try {
      this.write(model, before, next.state)
      const change = this.log(model, op.op, targetOf(op), op, ctx, null, next.touched)
      this.db.exec('COMMIT')
      return { ok: true, change, notes: next.notes, state: next.state }
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }

  /** Every recorded change, newest first; or those that touched one node. */
  changes(model: string, o: { id?: string; limit?: number } = {}) {
    const rows = this.db.prepare(`SELECT * FROM g_change WHERE model = ? ${o.id ? 'AND (target = ? OR EXISTS (SELECT 1 FROM json_each(g_change.touched) WHERE value = ?))' : ''} ORDER BY id DESC LIMIT ?`)
      .all(...[model, ...(o.id ? [o.id, o.id] : []), o.limit ?? 50]) as any[]
    return rows.map((r) => ({ id: r.id, at: Number(r.at), by: r.by, op: r.op, target: r.target, args: JSON.parse(r.args), reason: r.reason, from: r.source, applied: !!r.applied, refusal: r.refusal }))
  }

  /** The model as files: schema.json, sources.json, settings.json, and each program's definition and code. */
  export(model: string) {
    const st = this.state(model)
    return { schema: st.schema, sources: st.sources, settings: st.settings, programs: st.programs }
  }

  /** Build a model from exported files, one recorded operation per node, so the change log says how it came to be. */
  import(model: string, files: { schema: Schema; sources?: Sources; settings?: Record<string, unknown>; programs?: Record<string, ProgramDef> }, ctx: ChangeContext): { applied: number; refused: Array<{ op: Operation; reason: string }> } {
    if (!this.has(model)) { const c = this.createModel(model, ctx); if (!c.ok) return { applied: 0, refused: [{ op: { op: 'create-model' } as any, reason: c.reason }] } }
    const ops = operationsFor(files)
    let applied = 0
    const refused: Array<{ op: Operation; reason: string }> = []
    for (const op of ops) {
      const r = this.apply(model, op, ctx)
      if (r.ok) applied++
      else refused.push({ op, reason: r.reason })
    }
    return { applied, refused }
  }

  private record(model: string, op: Operation, target: string | null, ctx: ChangeContext, reason: string): Applied {
    if (!ctx.dryRun) this.log(model, op.op, target, op, ctx, reason, [])
    return { ok: false, reason }
  }
  private log(model: string, op: string, target: string | null, args: unknown, ctx: ChangeContext, refusal: string | null, touched: string[]): number {
    const r = this.db.prepare('INSERT INTO g_change (model, at, by, op, target, args, reason, source, applied, refusal, touched) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(model, Date.now(), ctx.by, op, target, JSON.stringify(args), ctx.reason ?? null, ctx.from ?? null, refusal ? 0 : 1, refusal, JSON.stringify(touched))
    return Number(r.lastInsertRowid)
  }

  /** Write a state as rows: only what changed is touched, and a changed row's version goes up. */
  private write(model: string, before: ModelState, after: ModelState) {
    const now = Date.now()
    const put = (table: 'g_node' | 'g_edge' | 'g_binding' | 'g_program', key: string, keyCol: string, rows: Map<string, Record<string, unknown>>, old: Map<string, Record<string, unknown>>) => {
      for (const [id, row] of rows) {
        const was = old.get(id)
        if (was && JSON.stringify(was) === JSON.stringify(row)) continue
        const cols = Object.keys(row)
        if (was) this.db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, version = version + 1, updated_at = ? WHERE model = ? AND ${keyCol} = ?`).run(...(cols.map((c) => row[c]) as any[]), now, model, id)
        else this.db.prepare(`INSERT INTO ${table} (model, ${keyCol}, ${cols.join(', ')}, updated_at) VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?)`).run(model, id, ...(cols.map((c) => row[c]) as any[]), now)
      }
      for (const id of old.keys()) if (!rows.has(id)) this.db.prepare(`DELETE FROM ${table} WHERE model = ? AND ${keyCol} = ?`).run(model, id)
      void key
    }
    put('g_node', 'id', 'id', nodeRows(after.schema), nodeRows(before.schema))
    put('g_edge', 'id', 'id', edgeRows(after.schema), edgeRows(before.schema))
    const bind = (st: ModelState) => new Map(Object.entries({ ...st.sources.entities, ...st.sources.facts }).map(([o, b]) => [o, { body: JSON.stringify(b) }]))
    put('g_binding', 'object', 'object', bind(after), bind(before))
    const prog = (st: ModelState) => new Map(Object.entries(st.programs).map(([n, p]) => [n, { body: JSON.stringify(p) }]))
    put('g_program', 'name', 'name', prog(after), prog(before))
    this.db.prepare('DELETE FROM g_setting WHERE model = ?').run(model)
    for (const [k, v] of Object.entries(after.settings)) this.db.prepare('INSERT INTO g_setting (model, key, value, updated_at) VALUES (?, ?, ?, ?)').run(model, k, JSON.stringify(v), now)
  }
}

const emptyState = (model: string): ModelState => ({ schema: { name: model, objects: {} }, sources: { facts: {}, entities: {} }, settings: {}, programs: {} })

function nodeRows(s: Schema): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  const top = Object.fromEntries(Object.entries(s).filter(([k]) => !['name', 'objects', 'conditions', 'equations', 'conversion'].includes(k)))
  if (Object.keys(top).length) out.set('schema', { kind: 'schema', owner: null, body: JSON.stringify(top) })
  for (const [name, o] of Object.entries(s.objects)) {
    const { kind, arrows: _a, measures, attributes, ...rest } = o
    out.set(name, { kind, owner: null, body: JSON.stringify(rest) })
    for (const [m, d] of Object.entries(measures ?? {})) out.set(`${name}.${m}`, { kind: 'measure', owner: name, body: JSON.stringify(d) })
    for (const [a, d] of Object.entries(attributes ?? {})) out.set(`${name}.${a}`, { kind: 'attribute', owner: name, body: JSON.stringify(d) })
  }
  for (const [n, c] of Object.entries(s.conditions ?? {})) out.set(`condition:${n}`, { kind: 'condition', owner: null, body: JSON.stringify(c) })
  for (const e of s.equations ?? []) out.set(`equation:${e.on}:${e.paths[0].join('.')}=${e.paths[1].join('.')}`, { kind: 'equation', owner: null, body: JSON.stringify(e) })
  if (s.conversion) out.set('conversion', { kind: 'conversion', owner: null, body: JSON.stringify(s.conversion) })
  return out
}
function edgeRows(s: Schema): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  for (const [name, o] of Object.entries(s.objects)) for (const [role, a] of Object.entries(o.arrows ?? {})) {
    const { to, ...rest } = typeof a === 'string' ? { to: a } : a
    out.set(`${name}.${role}`, { source: name, role, target: to, body: JSON.stringify(rest) })
  }
  return out
}

const targetOf = (op: Operation): string | null =>
  'id' in op ? op.id : 'name' in op ? (op.op === 'add-condition' ? `condition:${op.name}` : op.name) : op.op === 'bind' ? op.object : op.op === 'add-equation' ? `equation:${op.on}` : op.op === 'set-setting' ? `setting:${op.key}` : op.op === 'set-conversion' ? 'conversion' : null

// ── Operations as steps from one state to the next ──

/** What an id names in a state. */
function resolve(s: Schema, id: string): { kind: 'object' | 'measure' | 'attribute' | 'arrow' | 'condition' | 'equation' | 'conversion'; owner?: string; name: string } {
  if (id.startsWith('condition:')) { const name = id.slice(10); return s.conditions?.[name] ? { kind: 'condition', name } : refuse(`there is no condition "${name}"`) }
  if (id === 'conversion') return s.conversion ? { kind: 'conversion', name: 'conversion' } : refuse('the model has no conversion')
  if (s.objects[id]) return { kind: 'object', name: id }
  const dot = id.indexOf('.')
  if (dot > 0) {
    const owner = id.slice(0, dot), name = id.slice(dot + 1), o = s.objects[owner]
    if (!o) refuse(`there is no ${owner} — the model's objects are ${Object.keys(s.objects).join(', ') || 'none yet'}`)
    if (o.measures?.[name]) return { kind: 'measure', owner, name }
    if (o.attributes?.[name]) return { kind: 'attribute', owner, name }
    if (o.arrows?.[name] !== undefined) return { kind: 'arrow', owner, name }
    refuse(`${owner} has no measure, attribute or arrow "${name}"`)
  }
  return refuse(`there is no "${id}" — an object is named by itself (Store), a measure, attribute or arrow by its owner (Sale.units, Store.region), a condition as condition:<name>`)
}

/** Every name and synonym that already means something, for the duplicate check. */
function meanings(s: Schema): Array<{ word: string; means: string; scope: 'object' | 'member' }> {
  const out: Array<{ word: string; means: string; scope: 'object' | 'member' }> = []
  for (const [name, o] of Object.entries(s.objects)) {
    out.push({ word: name, means: name, scope: 'object' })
    for (const syn of o.synonyms ?? []) out.push({ word: syn, means: name, scope: 'object' })
  }
  for (const [n, c] of Object.entries(s.conditions ?? {})) {
    out.push({ word: n, means: `condition:${n}`, scope: 'object' })
    for (const syn of c.synonyms ?? []) out.push({ word: syn, means: `condition:${n}`, scope: 'object' })
  }
  return out
}
function unique(s: Schema, words: string[], self?: string) {
  for (const w of words) {
    const clash = meanings(s).find((m) => same(m.word, w) && m.means !== self)
    if (clash) refuse(`"${w}" already means ${clash.means}${same(clash.word, clash.means) ? '' : ` (as a synonym)`} — one word, one meaning: use that, or say how this differs`)
  }
}
const nameOk = (name: string, what: string) => { if (!name?.trim() || /[.]/.test(name) || name.startsWith('condition:')) refuse(`${what} name "${name}" — a name has no dots and is not empty`) }
const splitId = (id: string, what: string) => { const dot = id.indexOf('.'); if (dot <= 0) refuse(`${what} is named <Owner>.<name>, e.g. Sale.units`); return [id.slice(0, dot), id.slice(dot + 1)] as const }
const clean = <T extends Record<string, unknown>>(x: T): T => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))) as T

/** Where each thing is referred to — what a remove would leave dangling, and what a rename rewrites. */
function references(st: ModelState, id: string): string[] {
  const s = st.schema, out: string[] = []
  const r = resolve(s, id)
  for (const [name, o] of Object.entries(s.objects)) {
    for (const [role, a] of Object.entries(o.arrows ?? {})) {
      const to = typeof a === 'string' ? a : a.to
      if (r.kind === 'object' && to === r.name && name !== r.name) out.push(`the arrow ${name}.${role} leads to it`)
    }
    for (const [m, d] of Object.entries(o.measures ?? {})) {
      if (r.kind === 'measure' && r.owner === name && d.weight === r.name) out.push(`${name}.${m} is weighted by it`)
      if (r.kind === 'arrow' && r.owner === name && (d.of === r.name || d.versions === r.name || (Array.isArray(d.currency) && d.currency[0] === r.name))) out.push(`${name}.${m} names it`)
      if (r.kind === 'attribute' && r.owner === name && !Array.isArray(d.currency) && d.currency?.attribute === r.name) out.push(`${name}.${m} takes its currency from it`)
    }
    if (r.kind === 'condition' && o.keptTo?.includes(r.name)) out.push(`${name} is kept to it`)
    for (const [t, p] of Object.entries(o.defaults ?? {})) {
      if (r.kind === 'object' && t === r.name) out.push(`${name}'s default path to it`)
      if (r.kind === 'arrow' && r.owner === name && p[0] === r.name) out.push(`${name}'s default path to ${t} goes along it`)
    }
  }
  for (const [n, c] of Object.entries(s.conditions ?? {})) {
    if (r.kind === 'object' && c.on === r.name) out.push(`the condition "${n}" is about it`)
    if (r.kind !== 'object' && r.kind !== 'condition' && JSON.stringify(c.where).includes(JSON.stringify(r.name))) out.push(`the condition "${n}" may use it`)
  }
  if (r.kind === 'object' && s.conversion && [s.conversion.fact].includes(r.name)) out.push('the conversion reads it')
  if (r.kind === 'object') for (const [p, d] of Object.entries(st.programs)) if (d.produces === r.name || d.reads.objects.includes(r.name)) out.push(`the program "${p}" ${d.produces === r.name ? 'produces' : 'reads'} it`)
  return out
}

function step(before: ModelState, op: Operation): { state: ModelState; notes: string[]; touched: string[] } {
  const st = clone(before)
  const s = st.schema
  const notes: string[] = []
  const touched: string[] = [targetOf(op) ?? op.op]
  switch (op.op) {
    case 'add-entity': case 'add-calendar': case 'add-fact': {
      nameOk(op.name, 'an object')
      unique(s, [op.name, ...(op.synonyms ?? [])])
      const kind = op.op === 'add-entity' ? 'entity' : op.op === 'add-calendar' ? 'calendar' : 'fact'
      const { op: _o, name, ...props } = op as any
      s.objects[name] = clean({ kind, ...props })
      if (kind === 'calendar' && !props.level && !props.fiscal && !props.periods) refuse('a calendar has a level (day, week, month, quarter, year), a fiscal definition or listed periods')
      break
    }
    case 'add-arrow': {
      const [owner, role] = splitId(op.id, 'an arrow')
      const o = s.objects[owner] ?? refuse(`there is no ${owner}`)
      if (!s.objects[op.to]) refuse(`there is no ${op.to} for ${op.id} to lead to`)
      if (o.arrows?.[role] !== undefined || o.measures?.[role] || o.attributes?.[role]) refuse(`${owner} already has "${role}"`)
      const rest = clean({ kind: op.kind, partial: op.partial || undefined, synonyms: op.synonyms })
      ;(o.arrows ??= {})[role] = Object.keys(rest).length ? { to: op.to, ...rest } : op.to
      break
    }
    case 'add-measure': {
      const [fact, name] = splitId(op.id, 'a measure')
      const o = s.objects[fact] ?? refuse(`there is no ${fact}`)
      if (o.kind !== 'fact') refuse(`${fact} is ${o.kind === 'entity' ? 'an entity' : 'a calendar'}; measures belong to facts — an entity's numbers are attributes, or a fact with one row per ${fact}`)
      if (o.measures?.[name] || o.attributes?.[name] || o.arrows?.[name] !== undefined) refuse(`${fact} already has "${name}"`)
      const { op: _o, id: _i, ...m } = op as any
      ;(o.measures ??= {})[name] = clean(m)
      const shared = Object.entries(s.objects).flatMap(([f, x]) => Object.entries(x.measures ?? {}).filter(([n, d]) => `${f}.${n}` !== op.id && (d.synonyms ?? []).some((w) => (op.synonyms ?? []).some((v) => same(v, w)))).map(([n]) => `${f}.${n}`))
      if (shared.length) notes.push(`a synonym is shared with ${shared.join(', ')}: a question using it will be asked which`)
      break
    }
    case 'add-attribute': {
      const [owner, name] = splitId(op.id, 'an attribute')
      const o = s.objects[owner] ?? refuse(`there is no ${owner}`)
      if (o.kind === 'calendar') refuse('a calendar has no attributes')
      if (o.attributes?.[name] || o.measures?.[name] || o.arrows?.[name] !== undefined) refuse(`${owner} already has "${name}"`)
      const { op: _o, id: _i, ...a } = op as any
      ;(o.attributes ??= {})[name] = clean(a)
      break
    }
    case 'add-condition': {
      nameOk(op.name, 'a condition')
      unique(s, [op.name, ...(op.synonyms ?? [])])
      if (!s.objects[op.on]) refuse(`there is no ${op.on} for the condition to be about`)
      if (!op.where?.length) refuse('a condition keeps to at least one filter')
      for (const w of op.where as any[]) {
        if (w.to && !s.objects[w.to]) refuse(`a filter of the condition names ${w.to}, which is not in the model`)
        if (w.attribute && !s.objects[w.of ?? op.on]?.attributes?.[w.attribute]) refuse(`${w.of ?? op.on} has no attribute "${w.attribute}"`)
      }
      ;(s.conditions ??= {})[op.name] = clean({ on: op.on, description: op.description, synonyms: op.synonyms, where: op.where })
      break
    }
    case 'add-equation': (s.equations ??= []).push({ on: op.on, paths: op.paths }); break
    case 'set': {
      const r = resolve(s, op.id)
      const allowed: Record<string, string[]> = {
        object: ['description', 'synonyms', 'members', 'names', 'level', 'fiscal', 'periods', 'grain', 'keptTo', 'history', 'defaults'],
        measure: ['description', 'synonyms', 'unit', 'kind', 'aggregate', 'currency', 'overTime', 'of', 'weight', 'versions'],
        attribute: ['description', 'synonyms', 'type', 'members'],
        arrow: ['kind', 'partial', 'synonyms'],
        condition: ['description', 'synonyms', 'where', 'on'],
        conversion: ['fact', 'from', 'to', 'day', 'rate', 'at'],
      }
      if (!allowed[r.kind]?.includes(op.property)) refuse(`${op.id} is ${r.kind === 'arrow' || r.kind === 'attribute' ? 'an' : 'a'} ${r.kind}; what can be set on it: ${allowed[r.kind]?.join(', ') ?? 'nothing'}`)
      if (op.property === 'synonyms') unique(s, (op.value as string[]) ?? [], r.kind === 'condition' ? op.id : r.kind === 'object' ? r.name : undefined)
      const target: any = r.kind === 'object' ? s.objects[r.name] : r.kind === 'measure' ? s.objects[r.owner!].measures![r.name] : r.kind === 'attribute' ? s.objects[r.owner!].attributes![r.name]
        : r.kind === 'condition' ? s.conditions![r.name] : r.kind === 'conversion' ? s.conversion : null
      if (r.kind === 'arrow') {
        const o = s.objects[r.owner!], a = o.arrows![r.name]
        const full: any = typeof a === 'string' ? { to: a } : { ...a }
        if (op.value === undefined || op.value === null || op.value === false) delete full[op.property]; else full[op.property] = op.value
        o.arrows![r.name] = Object.keys(full).length === 1 ? full.to : full
      } else if (op.value === undefined || op.value === null) delete target[op.property]
      else target[op.property] = op.value
      break
    }
    case 'rename': rename(st, op.id, op.to); touched.push(op.to); break
    case 'remove': {
      const refs = references(st, op.id)
      if (refs.length) refuse(`${op.id} is still used: ${refs.join('; ')}`)
      const r = resolve(s, op.id)
      if (r.kind === 'object') { delete s.objects[r.name]; delete st.sources.facts[r.name]; delete st.sources.entities[r.name] }
      else if (r.kind === 'measure') delete s.objects[r.owner!].measures![r.name]
      else if (r.kind === 'attribute') delete s.objects[r.owner!].attributes![r.name]
      else if (r.kind === 'arrow') delete s.objects[r.owner!].arrows![r.name]
      else if (r.kind === 'condition') delete s.conditions![r.name]
      else if (r.kind === 'conversion') delete s.conversion
      if (r.kind !== 'object' && r.owner) {
        const b: any = st.sources.facts[r.owner] ?? st.sources.entities[r.owner]
        if (b) { delete b.measures?.[r.name]; delete b.attributes?.[r.name]; delete b.arrows?.[r.name] }
      }
      break
    }
    case 'promote-attribute': {
      const [owner, attr] = splitId(op.id, 'an attribute')
      const o = s.objects[owner] ?? refuse(`there is no ${owner}`)
      const def = o.attributes?.[attr] ?? refuse(`${owner} has no attribute "${attr}"`)
      nameOk(op.entity, 'an entity')
      unique(s, [op.entity])
      if (Object.values(o.measures ?? {}).some((m) => !Array.isArray(m.currency) && m.currency?.attribute === attr)) refuse(`${op.id} is the currency of a measure; say where the currency comes from before promoting it`)
      s.objects[op.entity] = clean({ kind: 'entity' as const, description: def.description, synonyms: def.synonyms, members: def.members ? Object.fromEntries(def.members.map((v) => [v, v])) : undefined })
      delete o.attributes![attr]
      if (!Object.keys(o.attributes!).length) delete o.attributes
      ;(o.arrows ??= {})[attr] = o.kind === 'fact' ? op.entity : { to: op.entity, partial: true }
      // A condition that kept to the attribute keeps to the entity along the new arrow.
      for (const c of Object.values(s.conditions ?? {})) {
        c.where = c.where.map((w: any) => {
          if (w.attribute !== attr || (w.of ?? c.on) !== owner) return w
          const { attribute: _a, of: _of, ...rest } = w
          return c.on === owner ? { to: op.entity, via: [attr], ...rest } : { to: op.entity, via: [...(w.via ?? []), attr], ...rest }
        })
      }
      const b: any = st.sources.facts[owner] ?? st.sources.entities[owner]
      if (b?.attributes?.[attr]) { (b.arrows ??= {})[attr] = b.attributes[attr]; delete b.attributes[attr] }
      notes.push(`${op.entity} lists ${def.members ? def.members.length : 'no'} members taken from the attribute's values${def.members ? '' : ' — bind it to a source, or list its members'}; questions that grouped by {"attribute": "${attr}"} now group by {"to": "${op.entity}"}`)
      touched.push(op.entity, `${owner}.${attr}`)
      break
    }
    case 'bind': {
      const o = s.objects[op.object] ?? refuse(`there is no ${op.object} to bind`)
      if (o.kind === 'calendar') refuse('a calendar is computed; it has no source')
      if (o.kind === 'fact') { st.sources.facts[op.object] = op.binding as FactSource; delete st.sources.entities[op.object] }
      else { st.sources.entities[op.object] = op.binding as EntitySource; delete st.sources.facts[op.object] }
      break
    }
    case 'add-program': {
      if (!s.objects[op.program.produces]) refuse(`the program produces ${op.program.produces}, which is not in the model`)
      st.programs[op.name] = op.program
      break
    }
    case 'set-setting': if (op.value === null) delete st.settings[op.key]; else st.settings[op.key] = op.value; break
    case 'set-conversion': if (op.conversion) s.conversion = op.conversion; else delete s.conversion; break
  }
  return { state: st, notes, touched }
}

/** Rename a node, rewriting everything that refers to it. */
function rename(st: ModelState, id: string, to: string) {
  const s = st.schema
  const r = resolve(s, id)
  const mapKey = <T>(rec: Record<string, T> | undefined, from: string, next: string) => rec && from in rec ? Object.fromEntries(Object.entries(rec).map(([k, v]) => [k === from ? next : k, v])) : rec
  if (r.kind === 'object') {
    nameOk(to, 'an object'); unique(s, [to], r.name)
    s.objects = mapKey(s.objects, r.name, to)!
    for (const o of Object.values(s.objects)) {
      for (const [role, a] of Object.entries(o.arrows ?? {})) {
        if (typeof a === 'string' ? a === r.name : a.to === r.name) o.arrows![role] = typeof a === 'string' ? to : { ...a, to }
      }
      if (o.defaults) o.defaults = mapKey(o.defaults, r.name, to)
    }
    for (const c of Object.values(s.conditions ?? {})) {
      if (c.on === r.name) c.on = to
      c.where = c.where.map((w: any) => ({ ...w, ...(w.to === r.name ? { to } : {}), ...(w.of === r.name ? { of: to } : {}) }))
    }
    for (const e of s.equations ?? []) if (e.on === r.name) e.on = to
    if (s.conversion?.fact === r.name) s.conversion.fact = to
    st.sources.facts = mapKey(st.sources.facts, r.name, to)!
    st.sources.entities = mapKey(st.sources.entities, r.name, to)!
    for (const p of Object.values(st.programs)) { if (p.produces === r.name) p.produces = to; p.reads.objects = p.reads.objects.map((x) => (x === r.name ? to : x)) }
    return
  }
  if (r.kind === 'condition') {
    nameOk(to, 'a condition'); unique(s, [to], id)
    s.conditions = mapKey(s.conditions, r.name, to)
    for (const o of Object.values(s.objects)) if (o.keptTo) o.keptTo = o.keptTo.map((c) => (c === r.name ? to : c))
    return
  }
  if (r.kind === 'conversion' || r.kind === 'equation') refuse(`${id} has no name to change`)
  nameOk(to, 'a name')
  const o = s.objects[r.owner!]
  if (o.measures?.[to] || o.attributes?.[to] || o.arrows?.[to] !== undefined) refuse(`${r.owner} already has "${to}"`)
  const b: any = st.sources.facts[r.owner!] ?? st.sources.entities[r.owner!]
  if (r.kind === 'measure') {
    o.measures = mapKey(o.measures, r.name, to)
    for (const m of Object.values(o.measures ?? {})) if (m.weight === r.name) m.weight = to
    if (b?.measures) b.measures = mapKey(b.measures, r.name, to)
  } else if (r.kind === 'attribute') {
    o.attributes = mapKey(o.attributes, r.name, to)
    for (const m of Object.values(o.measures ?? {})) if (!Array.isArray(m.currency) && m.currency?.attribute === r.name) m.currency = { attribute: to }
    for (const c of Object.values(s.conditions ?? {})) c.where = c.where.map((w: any) => (w.attribute === r.name && (w.of ?? c.on) === r.owner ? { ...w, attribute: to } : w))
    if (b?.attributes) b.attributes = mapKey(b.attributes, r.name, to)
  } else if (r.kind === 'arrow') {
    o.arrows = mapKey(o.arrows, r.name, to)
    const swap = (p: string[]) => (p[0] === r.name ? [to, ...p.slice(1)] : p)
    for (const m of Object.values(o.measures ?? {})) {
      if (m.of === r.name) m.of = to
      if (m.versions === r.name) m.versions = to
      if (Array.isArray(m.currency)) m.currency = swap(m.currency)
    }
    if (o.defaults) o.defaults = Object.fromEntries(Object.entries(o.defaults).map(([t, p]) => [t, swap(p)]))
    if (o.grain) o.grain = o.grain.map((g) => (g === r.name ? to : g))
    for (const e of s.equations ?? []) if (e.on === r.owner) e.paths = e.paths.map(swap) as [string[], string[]]
    if (s.conversion && s.conversion.fact === r.owner) for (const k of ['from', 'to', 'day'] as const) if (s.conversion[k] === r.name) s.conversion[k] = to
    for (const c of Object.values(s.conditions ?? {})) c.where = c.where.map((w: any) => (c.on === r.owner && Array.isArray(w.via) && w.via[0] === r.name ? { ...w, via: swap(w.via) } : w))
    if (b?.arrows) b.arrows = mapKey(b.arrows, r.name, to)
  }
}

/** The operations that build a model from its files: objects, then arrows, measures and attributes, conditions,
 *  equations, conversion, the properties that refer to others, bindings, programs, settings. */
export function operationsFor(files: { schema: Schema; sources?: Sources; settings?: Record<string, unknown>; programs?: Record<string, ProgramDef> }): Operation[] {
  const s = files.schema, ops: Operation[] = []
  for (const [name, o] of Object.entries(s.objects)) {
    const base = clean({ description: o.description, synonyms: o.synonyms })
    if (o.kind === 'entity') ops.push({ op: 'add-entity', name, ...base, ...clean({ members: o.members, names: o.names, history: o.history }) })
    else if (o.kind === 'calendar') ops.push({ op: 'add-calendar', name, ...base, ...clean({ level: o.level, fiscal: o.fiscal, periods: o.periods }) })
    else ops.push({ op: 'add-fact', name, ...base, ...clean({ history: o.history }) })
  }
  for (const name of Object.keys(s.objects)) for (const a of arrows(s, name)) {
    const raw = s.objects[name].arrows![a.role]
    const def = typeof raw === 'string' ? { to: raw } : raw
    ops.push({ op: 'add-arrow', id: `${name}.${a.role}`, to: def.to, ...clean({ kind: def.kind, partial: def.partial, synonyms: def.synonyms }) })
  }
  for (const [name, o] of Object.entries(s.objects)) {
    for (const [a, d] of Object.entries(o.attributes ?? {})) ops.push({ op: 'add-attribute', id: `${name}.${a}`, ...d })
    for (const [m, d] of Object.entries(o.measures ?? {})) ops.push({ op: 'add-measure', id: `${name}.${m}`, ...d } as Operation)
  }
  for (const [n, c] of Object.entries(s.conditions ?? {})) ops.push({ op: 'add-condition', name: n, ...c })
  for (const e of s.equations ?? []) ops.push({ op: 'add-equation', on: e.on, paths: e.paths })
  if (s.conversion) ops.push({ op: 'set-conversion', conversion: s.conversion })
  for (const [name, o] of Object.entries(s.objects)) {
    for (const p of ['defaults', 'keptTo', 'grain'] as const) if (o[p] !== undefined) ops.push({ op: 'set', id: name, property: p, value: o[p] })
  }
  for (const [name, b] of Object.entries({ ...(files.sources?.entities ?? {}), ...(files.sources?.facts ?? {}) })) ops.push({ op: 'bind', object: name, binding: b })
  for (const [name, p] of Object.entries(files.programs ?? {})) ops.push({ op: 'add-program', name, program: p })
  for (const [k, v] of Object.entries(files.settings ?? {})) ops.push({ op: 'set-setting', key: k, value: v })
  return ops
}
