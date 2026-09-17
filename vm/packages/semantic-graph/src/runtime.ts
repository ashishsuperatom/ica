// ── THE SEMANTIC GRAPH, RUNNING ─────────────────────────────────────────────────────────────────────────────
//
// Everything asked goes through here, so three things hold that could not otherwise:
//
//   a correction lands once       a schema or its sources are definitions by content hash, reached by name; moving the
//                                 name corrects every later answer, and earlier answers still name what they ran on
//   every answer is recorded      question, canonical form, plan, the exact definitions, each statement with its SQL,
//                                 rows and time, caveats, the day, who asked — or the rule that refused it
//   memory is of the graph        each answer is filed under the nodes it went through, and its values by calendar
//                                 period become series, so what a change to a node reaches is a lookup
//
// A data session is a tree of steps; each step is a question and the answer to it, and each follow-up is a move on the
// step it follows, checked before anything runs.

import { createHash, randomUUID } from 'node:crypto'
import { check, type Plan, type Question } from './algebra.js'
import { pathsFrom } from './paths.js'
import { plansOf, type Result } from './evaluate.js'
import { addDays, endsPeriod, periodOf as calendarPeriod, shiftPeriods, startsPeriod } from './calendar.js'
import { expectation, THRESHOLD, WINDOW, type Expectation } from './expectations.js'
import { applyMove, canonical, type Move } from './moves.js'
import { runSql, sqlite, type Dialect, type Query, type Sources } from './sql.js'
import { schemaProblems, walk, type Schema } from './schema.js'
import { Store, type CallRecord, type DefinitionKind, type Observation, type StatementRecord } from './store.js'
import { facts, setting, type Assumed } from './rules.js'
import { intervenedSources, interventionProblems, type Intervention } from './interventions.js'
import { declaredColumns, expandSources, LOCAL, loadModule, namedIn, sourcesProblems, type ProgramDef } from './producers.js'
import { DatabaseSync } from 'node:sqlite'
import { bestMembers, find, type Found } from './discovery.js'
import { resolveTerms, recordPhrases } from './terms.js'
import { hashNode, type Memo } from './plan-graph.js'
import { pushable } from './pushdown.js'
import { renderAnswer, trace, type AnswerDoc } from './answers.js'
import { CappedError, detailSql, spanParams, type FactSource, type EntitySource } from './sql.js'
import { arrows as arrowsOf, timeArrow } from './schema.js'
import type { Key } from './instance.js'
import { dayIn, resolveSpan, validZone, type QuestionAsked } from './time.js'

/** Key order never changes a hash: the same definition written twice is one definition. */
export const canonicalJson = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`).join(',')}}`
  return JSON.stringify(v ?? null)
}
export const hashOf = (kind: string, body: unknown) => `${kind}:${createHash('sha256').update(canonicalJson(body)).digest('hex').slice(0, 24)}`

export interface GraphOptions {
  store: Store
  query: Query
  /** The dialect of every source, or of each source by name. Rows computed here are always SQLite. */
  dialect?: Dialect
  dialects?: Record<string, Dialect>
  /** Other organisations' or teams' models, each mounted read-only under a namespace. */
  libraries?: Array<{ namespace: string; store: Store }>
  /** Results kept against the hash of the work that produced them. A program's rows are the expensive thing, so
   *  they are what is kept: the same program, span and pushed-down filters is the same work, however often it is
   *  asked for. Scope it to a turn unless a source has declared how long its rows stay true. */
  memo?: Memo
  /** A fixed day for every question (a test, a replay harness). Otherwise today is the day where the asker is. */
  today?: () => string
  /** The clock, for today in the asker's zone. */
  now?: () => Date
  checks?: 'thorough' | 'light'
}
export interface AskOptions {
  /** The schema, sources and settings to answer on, by name. */
  model: string
  /** Exact definitions to answer on instead of what the name points at now — a replay. */
  on?: { schema: string; sources: string | null; settings: string | null; programs?: Record<string, string> }
  who?: Record<string, unknown>
  access?: Record<string, unknown[]>
  today?: string
  /** Changes to the data for this request only: the answer is hypothetical. */
  intervene?: Intervention[]
  /** Settings for this request only; they win over the asker's and the organisation's. */
  assume?: Record<string, unknown>
  sessionId?: string
  parentId?: string
}
export type Answer =
  | { ok: true; callId: string; result: Result; plan: Plan; canonical: string; caveats: string[]; surprises: NonNullable<CallRecord['surprises']> }
  | { ok: false; callId: string; rule?: string; reason: string; choices?: unknown }

export function createGraph(o: GraphOptions) {
  const { store } = o
  const modules = new Map<string, Function>()

  // ── WHERE A NAME IS LOOKED UP: THIS ORGANISATION'S STORE, AND THE LIBRARIES IT MOUNTS ──
  // A name may carry a namespace — `hr/people` — and a library is a namespace whose definitions live in a store of its
  // own, mounted read-only: another team's model, a shared one. Its models are asked exactly as this organisation's are,
  // and every answer is remembered in this organisation's memory; nothing here can change them. Inside a namespace, a
  // name without one means that namespace's first — a library's sources name its own programs — and only then the top.
  const libraries = new Map((o.libraries ?? []).map((l) => [l.namespace, l.store]))
  const namespaceOf = (name: string) => (name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '')
  const storeOf = (name: string) => libraries.get(namespaceOf(name))
  const localName = (name: string) => (storeOf(name) ? name.slice(namespaceOf(name).length + 1) : name)
  const resolveName = (kind: DefinitionKind, name: string, within = '') => {
    for (const full of within && !name.includes('/') ? [`${within}/${name}`, name] : [name]) {
      const lib = storeOf(full)
      const hash = lib ? lib.resolve(kind, localName(full)) : store.resolve(kind, full)
      if (hash) return hash
    }
    return null
  }
  const definition = (hash: string) => store.getDefinition(hash) ?? [...libraries.values()].map((l) => l.getDefinition(hash)).find(Boolean) ?? null
  const dialect = o.dialect ?? sqlite
  const dialectFor = (source: string): Dialect => (source === LOCAL ? sqlite : o.dialects?.[source] ?? dialect)

  /** Define a schema under a name. Refused unless well formed — and, when it replaces one, unless the model's sources
   *  still fit it and every question a session is on still checks against it: a correction that breaks what people
   *  are looking at is made deliberately (`breaking`), never by accident. */
  function defineSchema(name: string, schema: Schema, by: string, reason?: string, options: { breaking?: boolean } = {}) {
    const problems = schemaProblems(schema)
    if (problems.length) throw new Error(`the schema "${name}" is not well formed:\n  ${problems.join('\n  ')}`)
    const current = store.resolve('schema', name)
    if (current && current !== hashOf('schema', schema) && !options.breaking) {
      const broken: string[] = []
      const sourcesHash = store.resolve('sources', name)
      if (sourcesHash) broken.push(...sourcesProblems(schema, store.getDefinition(sourcesHash)!.body as Sources).map((p) => `sources: ${p}`))
      for (const sess of store.listSessions(10_000)) {
        const stepNow = sess.currentStep && store.steps(sess.id).find((x) => x.id === sess.currentStep)
        if (!stepNow || !stepNow.callId) continue
        const call = store.getCall(stepNow.callId)
        if (call?.schema !== current) continue
        const v = check(schema, stepNow.question as Question)
        if (!v.ok) broken.push(`session "${sess.title ?? sess.id}" is on a question that would be refused: ${v.reason}`)
      }
      if (broken.length) throw new Error(`the schema "${name}" would break what exists — replace it with breaking: true to do so deliberately:\n  ${broken.join('\n  ')}`)
    }
    return define('schema', name, schema, by, reason)
  }
  /** Define where a schema's objects' rows are, under the same name as the schema. Checked before it is stored: every
   *  object named exists, every arrow, attribute and measure has its column, braces name objects with sources and never
   *  go round, programs exist and produce the object they are given for — and, at the sources, every declared column is
   *  there, every entity has one row per key, and no history has two values in effect at once. */
  async function defineSources(name: string, sources: Sources, by: string, reason?: string) {
    // The same sources already named here were checked when they were defined.
    if (store.resolve('sources', name) === hashOf('sources', sources)) return { hash: hashOf('sources', sources), created: false, moved: false }
    const hash = store.resolve('schema', name)
    if (!hash) throw new Error(`there is no schema "${name}" to give sources to`)
    const schema = store.getDefinition(hash)!.body as Schema
    const problems = sourcesProblems(schema, sources)
    for (const [o, x] of [...Object.entries(sources.facts), ...Object.entries(sources.entities)] as Array<[string, FactSource | EntitySource]>) {
      if (!x.program) continue
      const ph = resolveName('program', x.program, namespaceOf(name))
      if (!ph) { problems.push(`${o} is produced by the program "${x.program}", which does not exist`); continue }
      const def = definition(ph)!.body as ProgramDef
      if (def.produces !== o) problems.push(`the program "${x.program}" produces ${def.produces}, not ${o}`)
    }
    if (problems.length) throw new Error(`the sources of "${name}" do not fit its schema:\n  ${problems.join('\n  ')}`)
    const expanded = (() => { try { return expandSources(onlyStatements(sources)) } catch (e: any) { throw new Error(`the sources of "${name}": ${e.message}`) } })()
    // A statement bound to the span asked is checked over one day: its columns are what is checked, not its rows.
    const today = dayIn('UTC', o.now?.())
    const probe = { from: today, to: addDays(today, 1) }
    const at = async (source: string, sql: string, params: Record<string, unknown> = {}) => o.query(source, sql, { ...params, ...spanParams(sql, probe) })
    for (const [obj, x] of [...Object.entries(expanded.facts), ...Object.entries(expanded.entities)] as Array<[string, FactSource | EntitySource]>) {
      if (!x.sql) continue
      const cols = declaredColumns(x)
      const dx = dialectFor(x.source), q = dx.quote
      try { await at(x.source, `SELECT ${cols.map((c, i) => `COUNT(t.${q(c)}) AS c${i}`).join(', ')} FROM (${dx.limit(`SELECT * FROM (${x.sql}) x`, 1)}) t`, x.params) }
      catch (e: any) { throw new Error(`the source of ${obj} does not give its declared columns (${cols.join(', ')}): ${e.message}`) }
      if ('key' in x) {
        const [r] = await at(x.source, `SELECT COUNT(*) AS n, COUNT(DISTINCT g.${q(x.key)}) AS d FROM (${x.sql}) g`, x.params)
        if (Number(r?.n) !== Number(r?.d)) throw new Error(`${obj} is an entity, but its source has ${r?.n} rows for ${r?.d} keys`)
        for (const [role, h] of Object.entries(x.history ?? {})) {
          const [c] = await at(x.source, `SELECT COUNT(*) AS n FROM (${h.sql}) a JOIN (${h.sql}) b ON a.${q(h.key)} = b.${q(h.key)} AND a.${q(h.from)} < b.${q(h.from)} AND (a.${q(h.to)} IS NULL OR a.${q(h.to)} > b.${q(h.from)})`, h.params)
          if (Number(c?.n) > 0) throw new Error(`${obj}.${role} has ${c?.n} places where two values are in effect at once`)
        }
      }
    }
    return define('sources', name, sources, by, reason)
  }
  /** A program that produces an object's rows, under a name. */
  function defineProgram(name: string, program: ProgramDef, by: string, reason?: string) {
    if (!program.produces || typeof program.body !== 'string' || !Array.isArray(program.reads?.sources) || !Array.isArray(program.reads?.objects)) {
      throw new Error(`the program "${name}" says what it produces, what sources and objects it reads, and its body`)
    }
    return define('program', name, program, by, reason)
  }
  /** The organisation's settings for a model: values or rules, by name. */
  function defineSettings(name: string, settings: Record<string, unknown>, by: string, reason?: string) {
    if (!store.resolve('schema', name)) throw new Error(`there is no schema "${name}" to give settings to`)
    return define('settings', name, settings, by, reason)
  }
  function define(kind: 'schema' | 'sources' | 'settings' | 'program', name: string, body: unknown, by: string, reason?: string) {
    if (storeOf(name)) throw new Error(`"${name}" is in the library "${namespaceOf(name)}", which is read-only here`)
    const hash = hashOf(kind, body)
    const created = !store.getDefinition(hash)
    // A definition already held is only read, so opening the graph writes nothing when nothing changed.
    if (created) store.putDefinition({ hash, kind, body, createdAt: Date.now(), createdBy: by })
    const moved = store.resolve(kind, name) !== hash
    if (moved) store.point(kind, name, hash, by, reason)
    return { hash, created, moved }
  }
  function model(name: string, on?: AskOptions['on']) {
    const schemaHash = on?.schema ?? resolveName('schema', name) ?? (() => { throw new Error(`there is no schema "${name}"`) })()
    const sourcesHash = on ? on.sources : resolveName('sources', name)
    const settingsHash = on ? on.settings : resolveName('settings', name)
    const get = (h: string) => definition(h) ?? (() => { throw new Error(`the definition ${h} is not in memory or any library mounted here`) })()
    return { schemaHash, sourcesHash, settingsHash, namespace: namespaceOf(name), schema: get(schemaHash).body as Schema, sources: sourcesHash ? get(sourcesHash).body as Sources : null,
             settings: settingsHash ? get(settingsHash).body as Record<string, unknown> : {} }
  }

  async function ask(asked: QuestionAsked, a: AskOptions): Promise<Answer> {
    const started = Date.now()
    const m = model(a.model, a.on)
    // Settings read for this answer, from the nearest layer, for who asks and what is asked about.
    const assumed: Assumed[] = []
    const known = facts(a.who, aboutOf(asked))
    const layers = { caller: a.assume, asker: a.who?.settings as Record<string, unknown> | undefined, organisation: m.settings }
    const read = (name: string, fallback?: unknown) => setting(name, { ...layers, default: fallback }, known, assumed)
    const id = randomUUID()
    const said: string[] = []
    // What a reader needs to read the numbers right, in the organisation's words; `said` is the whole working record.
    const forReader: string[] = []
    let today = a.today ?? o.today?.() ?? dayIn('UTC', o.now?.())
    let zone = 'UTC'
    let q = asked as Question
    let surprise = { threshold: THRESHOLD, window: WINDOW }
    try {
      // Today is the day where the asker is; a question never takes the server's day for it.
      const z = read('timezone', a.who?.timezone) as string | undefined
      if (z !== undefined && (typeof z !== 'string' || !validZone(z))) throw new Error(`timezone "${String(z)}" is not a time zone — use a name like UTC or Pacific/Auckland`)
      if (z) zone = z
      if (!a.today && !o.today) { today = dayIn(zone, o.now?.()); if (!z) said.push(`today is taken as ${today} in UTC — nobody said where the asker is`) }
      // A relative span becomes dates against that day and the schema's calendars, and says which.
      if (asked.span && !('to' in asked.span)) {
        const r = resolveSpan(m.schema, asked.span, today); q = { ...q, span: r.span }
        if (r.said) said.push(r.said)
        if (!('through' in asked.span)) forReader.push(`${r.said!.slice(0, r.said!.indexOf(' is '))[0].toUpperCase()}${r.said!.slice(1, r.said!.indexOf(' is '))}: ${readableSpan(r.span)}`)
      }
      const currency = q.currency ?? (needsCurrency(m.schema, q) ? read('currency') as string | undefined : undefined)
      if (currency && !q.currency) q = { ...q, currency }
      surprise = { threshold: read('surprise threshold', THRESHOLD) as number, window: read('expectation window', WINDOW) as number }
    } catch (e: any) {
      store.recordCall({ id, parentId: a.parentId ?? null, sessionId: a.sessionId ?? null, question: asked, canonical: null, plan: null, schema: m.schemaHash, sources: m.sourcesHash, settings: m.settingsHash,
        output: null, refusal: { rule: 'settings', reason: e.message }, error: null, statements: [], caveats: [], ms: Date.now() - started, at: started, today, asOf: asked.asOf ?? null,
        who: a.who ?? null, assumptions: assumed, interventions: null, nodes: [] })
      return { ok: false, callId: id, rule: 'settings', reason: e.message }
    }
    const statements: StatementRecord[] = []
    const programs: Record<string, string> = {}
    const decisions: NonNullable<CallRecord['decisions']> = []
    const base: Omit<CallRecord, 'canonical' | 'plan' | 'output' | 'refusal' | 'error' | 'caveats' | 'nodes' | 'ms'> = {
      id, parentId: a.parentId ?? null, sessionId: a.sessionId ?? null, question: asked, schema: m.schemaHash, sources: m.sourcesHash, settings: m.settingsHash,
      statements, programs, decisions, at: started, today, asOf: q.asOf ?? null, who: a.who ?? null, assumptions: assumed, interventions: a.intervene?.length ? a.intervene : null,
    }
    const hypothetical = !!a.intervene?.length
    if (hypothetical) {
      const problems = interventionProblems(m.schema, a.intervene!)
      if (problems.length) {
        store.recordCall({ ...base, canonical: null, plan: null, output: null, refusal: { rule: 'intervention', reason: problems.join('; ') }, error: null, caveats: said, nodes: [], ms: Date.now() - started })
        return { ok: false, callId: id, rule: 'intervention', reason: problems.join('; ') }
      }
      said.push(`hypothetical: ${a.intervene!.map(describeIntervention).join('; ')}`)
      forReader.push(`What if: ${a.intervene!.map(describeIntervention).join('; ')}`)
    }
    // A THRESHOLD IS NAMED, NOT RETYPED. `having` may say which setting it compares against; it is read here, from
    // the nearest layer for who is asking, and the answer says which setting gave which number — so changing the
    // organisation's mind about it changes every question that referred to it, and none that copied it.
    if (q.having?.some((h) => h.setting)) {
      q = { ...q, having: q.having.map((h) => {
        if (!h.setting) return h
        const v = read(h.setting)
        if (typeof v === 'number') forReader.push(`Kept to ${h.output} ${h.op} ${v}, from the setting "${h.setting}"`)
        return { ...h, value: typeof v === 'number' ? v : undefined }
      }) }
    }
    const verdict = check(m.schema, q, { today })
    if (!verdict.ok) {
      store.recordCall({ ...base, canonical: null, plan: null, output: null, refusal: { rule: verdict.rule, reason: verdict.reason }, error: null, caveats: said, nodes: [], ms: Date.now() - started })
      return { ok: false, callId: id, rule: verdict.rule, reason: verdict.reason, ...(verdict.choices ? { choices: verdict.choices } : {}) }
    }
    const plan = verdict.plan
    const key = canonical(m.schema, q, { today })!
    const nodes = nodesOf(m.schema, plan)
    try {
      if (!m.sources) throw new Error(`the schema "${a.model}" has no sources, so nothing can be read`)
      const prepared = await prepare(m.schema, m.sources, plan, nodes, a.intervene ?? [], { today, access: a.access, read, statements, programs, decisions, onProgram: (p) => said.push(p), onReader: (p) => forReader.push(p), pinned: a.on?.programs, namespace: m.namespace })
      const r = await runSql(m.schema, prepared.sources, plan, prepared.query, dialectFor, { access: a.access, checks: o.checks, zone, onStatement: (s) => statements.push(s) })
      // Names are for reading: an answer whose names cannot be read is given with its keys, and the record says why.
      const labels = await labelsFor(m.schema, m.sources, plan, r.rows, a.access, statements).catch((e: any) => { said.push(`names not read: ${e?.message ?? e}`); return {} })
      const result: Result = { columns: r.columns, rows: r.rows, ...(r.totals ? { totals: r.totals } : {}), ...(Object.keys(labels).length ? { labels } : {}), notes: [...forReader, ...readerNotes(m.schema, plan, { columns: r.columns, rows: r.rows })] }
      const caveats = [...said, ...r.notes, ...r.caveats]
      // A hypothetical answer is not something that happened: it adds nothing to memory's series.
      const observations = hypothetical ? [] : observationsOf(m.schema, plan, q, result, id, started, `${m.schemaHash}|${m.sourcesHash}`)
      const kept = withinLimit(observations, store.limits.observationsPerCall)
      if (kept.length < observations.length) caveats.push(`memory kept ${kept.length} of this answer's ${observations.length} values, as whole series`)
      // Each value against what memory expected of its period, before this answer joins memory.
      const surprises = kept.flatMap((x) => {
        const e = expectation(store.series({ series: x.series, group: x.group, output: x.output, level: x.level, before: x.period }).map((h) => h.value), x.value, surprise)
        return e.surprising ? [{ group: JSON.parse(x.group), period: x.period, output: x.output, value: x.value, median: e.median!, z: e.z! }] : []
      })
      store.recordObservations(kept)
      store.recordCall({ ...base, canonical: key, plan, output: result, refusal: null, error: null, caveats, nodes, ms: Date.now() - started, surprises })
      return { ok: true, callId: id, result, plan, canonical: key, caveats, surprises }
    } catch (e: any) {
      store.recordCall({ ...base, canonical: key, plan, output: null, refusal: null, error: e?.message ?? String(e), caveats: said, nodes, ms: Date.now() - started })
      return { ok: false, callId: id, reason: e?.message ?? String(e) }
    }
  }

  /** The names people read for the keys an answer shows: the members a schema lists, or the label column of an entity's
   *  source, read for those keys only. */
  async function labelsFor(s: Schema, sources: Sources, plan: Plan, rows: Result['rows'], access: Record<string, unknown[]> | undefined, statements: StatementRecord[]) {
    const out: Record<number, Record<string, string>> = {}
    const fp = plan.facts[0]
    for (const [i, b] of fp.by.entries()) {
      if (!('path' in b)) continue
      const object = walk(s, fp.fact, b.path)!.object
      const def = s.objects[object]
      if (def.kind !== 'entity') continue
      const keys = [...new Set(rows.map((r) => r[i]).filter((k): k is string => k !== null && k !== undefined).map(String))]
      if (!keys.length) continue
      if (def.members) { out[i] = Object.fromEntries(keys.filter((k) => def.members![k]).map((k) => [k, def.members![k]])); continue }
      const es = sources.entities[object]
      if (!es?.sql || !es.label || es.source === LOCAL) continue
      const d = dialectFor(es.source), q = d.quote
      const labels: Record<string, string> = {}
      for (let at = 0; at < keys.length; at += 500) {
        const chunk = keys.slice(at, at + 500)
        const sql = `SELECT r.${q(es.key)} AS k, r.${q(es.label)} AS l FROM (${es.sql}) r WHERE r.${q(es.key)} IN (${chunk.map((_, j) => `@k${j}`).join(', ')})`
        const t = Date.now()
        const got = await o.query(es.source, sql, { ...es.params, ...Object.fromEntries(chunk.map((k, j) => [`k${j}`, k])) }, { policies: access?.[es.source] })
        statements.push({ fact: `${object} names`, source: es.source, sql, params: {}, rows: got.length, ms: Date.now() - t, capped: false })
        for (const r of got) labels[String(r.k)] = String(r.l)
      }
      out[i] = labels
    }
    return out
  }

  /** The nodes a word is: exactly, in the schema's own words — and, for entities whose members live at their source, a
   *  member whose name is that word — a word that names one record of one kind. */
  async function matchWord(modelName: string, word: string, a: { access?: Record<string, unknown[]> } = {}) {
    const m = model(modelName)
    const found: Array<Record<string, unknown>> = find(m.schema, word)
    const w = word.trim().toLowerCase()
    await Promise.all(Object.entries(m.sources?.entities ?? {}).map(async ([object, es]) => {
      if (m.schema.objects[object]?.members || !es.sql || !es.label || es.source === LOCAL) return
      const q = dialectFor(es.source).quote
      try {
        const rows = await o.query(es.source, `SELECT r.${q(es.key)} AS k, r.${q(es.label)} AS l FROM (${es.sql}) r WHERE LOWER(r.${q(es.label)}) = @w`, { ...es.params, w }, { policies: a.access?.[es.source] })
        for (const r of rows.slice(0, 10)) found.push({ kind: 'member', node: object, key: String(r.k), label: String(r.l), as: 'its name at the source' })
      } catch { /* an entity whose source cannot be searched by name is not a match */ }
    }))
    return found
  }

  /** What each term of a question is in the graph: its phrases looked up as names at every entity source that has
   *  them — one lookup per entity — then read whole with the schema (terms.ts). */
  /** `spans`: the parts of the question, as whoever read the language marked them out. Without them every run of one
   *  to four words is tried, which is how a name of seven words is never found whole and a common word is looked up
   *  for nothing. A span is a CLAIM about where a name begins and ends — what it means is still settled here. */
  async function resolveQuestionTerms(modelName: string, text: string, a: { today: string; access?: Record<string, unknown[]>; spans?: string[] }) {
    const m = model(modelName)
    const phrases = a.spans?.length ? [...new Set(a.spans.map((x) => x.toLowerCase().replace(/[^\p{L}\p{N}&+]+/gu, ' ').trim()).filter(Boolean))] : recordPhrases(text)
    const records = new Map<string, Found[]>()
    const unread: string[] = []
    await Promise.all(Object.entries(m.sources?.entities ?? {}).map(async ([object, es]) => {
      if (m.schema.objects[object]?.members || !es.sql || !es.label || es.source === LOCAL || !phrases.length) return
      const q = dialectFor(es.source).quote
      const params = Object.fromEntries(phrases.map((p, i) => [`t${i}`, p]))
      try {
        const rows = await o.query(es.source, `SELECT r.${q(es.key)} AS k, r.${q(es.label)} AS l FROM (${es.sql}) r WHERE LOWER(r.${q(es.label)}) IN (${phrases.map((_, i) => `@t${i}`).join(', ')})`, { ...es.params, ...params }, { policies: a.access?.[es.source] })
        for (const r of rows.slice(0, 50)) {
          const phrase = String(r.l).toLowerCase().replace(/[^\p{L}\p{N}&+]+/gu, ' ').trim()
          records.set(phrase, [...(records.get(phrase) ?? []), { kind: 'member', node: object, key: String(r.k), label: String(r.l), as: 'its name at the source' }])
        }
      } catch { unread.push(object) }
    }))
    const read = resolveTerms(m.schema, text, a.today, records)
    return unread.length ? { ...read, notes: [...(read.notes ?? []), `names of ${unread.join(', ')} could not be searched`] } : read
  }

  /** Sources ready for one answer: programs run, in the order they read each other, on data already intervened on; the
   *  objects built in braces put in place; and, where a fact's rows are computed here, the objects joined to it read here
   *  too — or refused if their source holds rows back. */
  async function prepare(s: Schema, sources: Sources, plan: Plan | null, nodes: string[], ivs: Intervention[],
                         c: { today: string; access?: Record<string, unknown[]>; read: (name: string, fallback?: unknown) => unknown; statements: StatementRecord[]; programs: Record<string, string>; onProgram?: (said: string) => void; onReader?: (said: string) => void; pinned?: Record<string, string>; namespace?: string; decisions?: NonNullable<CallRecord['decisions']> }) {
    const local = new DatabaseSync(':memory:')
    let tables = 0
    const query: Query = async (source, sql, params, options) => source === LOCAL ? local.prepare(sql).all(params as any) as any[] : o.query(source, sql, params, options)
    const readAt = async (what: string, source: string, sql: string, params: Record<string, unknown>) => {
      const t = Date.now()
      const rows = await query(source, sql, params, { policies: c.access?.[source] })
      const capped = Array.isArray((rows as any).notes) && (rows as any).notes.length > 0
      c.statements.push({ fact: what, source, sql, params, rows: rows.length, ms: Date.now() - t, capped })
      if (capped) throw new CappedError(`${what}: ${source} stopped at ${rows.length} rows, so they cannot be read here to compute from`)
      return rows
    }
    const table = (columns: string[], rows: Array<Record<string, unknown>>) => {
      const name = `t${tables++}`
      local.exec(`CREATE TABLE ${sqlite.quote(name)} (${columns.map((x) => sqlite.quote(x)).join(', ')})`)
      const insert = local.prepare(`INSERT INTO ${sqlite.quote(name)} VALUES (${columns.map(() => '?').join(', ')})`)
      for (const r of rows) insert.run(...columns.map((x) => { const v = r[x]; return v === undefined ? null : typeof v === 'boolean' ? Number(v) : v as any }))
      return `SELECT * FROM ${sqlite.quote(name)}`
    }
    let src = intervenedSources(s, sources, ivs.filter((x) => !(sources.facts[x.on] ?? sources.entities[x.on])?.program), dialectFor)
    const produced = [...Object.entries(src.facts), ...Object.entries(src.entities)].filter(([, x]) => x.program).map(([o]) => o)
    const readsOf = (obj: string) => {
      const x = (src.facts[obj] ?? src.entities[obj])!
      const def = definition(c.pinned?.[x.program!] ?? resolveName('program', x.program!, c.namespace) ?? '')?.body as ProgramDef | undefined
      return def?.reads.objects ?? []
    }
    const ordered: string[] = []
    const visit = (obj: string, trail: string[]) => {
      if (ordered.includes(obj)) return
      if (trail.includes(obj)) throw new Error(`programs read each other in a circle: ${[...trail, obj].join(' → ')}`)
      for (const r of readsOf(obj)) if (produced.includes(r)) visit(r, [...trail, obj])
      ordered.push(obj)
    }
    for (const obj of produced) visit(obj, [])
    // A program runs when the question needs its object, or a program that runs reads it.
    const needed = new Set(nodes)
    for (const obj of [...ordered].reverse()) if (needed.has(obj)) for (const r of readsOf(obj)) needed.add(r)
    for (const obj of ordered) {
      const x = (src.facts[obj] ?? src.entities[obj])!
      const hash = c.pinned?.[x.program!] ?? resolveName('program', x.program!, c.namespace) ?? (() => { throw new Error(`${obj} is produced by the program "${x.program}", which does not exist`) })()
      const def = definition(hash)!.body as ProgramDef
      c.programs[x.program!] = hash
      if (!needed.has(obj)) continue
      const fn = await loadModule(hash, def.body, modules)
      const ctx = {
        today: c.today,
        assume: (n: string, fallback?: unknown) => c.read(n, fallback),
        /** A choice the program made, and why — recorded with the answer. */
        decide: (label: string, took: boolean, reason: string) => { c.decisions?.push({ program: x.program!, label, took, reason }); return took },
        /** A choice on a threshold: recorded with the value, the threshold, and how far the value was from it. */
        decideAt: (label: string, value: number, op: '<' | '<=' | '>' | '>=', threshold: number, reason = '') => {
          const took = op === '<' ? value < threshold : op === '<=' ? value <= threshold : op === '>' ? value > threshold : value >= threshold
          c.decisions?.push({ program: x.program!, label, took, reason, boundary: { value, op, threshold, margin: value - threshold } })
          return took
        },
        /** Something a person reading the answer should know. */
        caveat: (text: string) => { c.onProgram?.(`${x.program}: ${text}`); c.onReader?.(text) },
        query: async (source: string, sql: string, params: Record<string, unknown> = {}) => {
          if (!def.reads.sources.includes(source)) throw new Error(`the program "${x.program}" read ${source}, which it does not declare`)
          return readAt(obj, source, sql, params)
        },
        rows: async (other: string) => {
          if (!def.reads.objects.includes(other)) throw new Error(`the program "${x.program}" read ${other}, which it does not declare`)
          const e = expandSources(onlyStatements(src))
          const y = e.facts[other] ?? e.entities[other] ?? (() => { throw new Error(`${other} has no statement to read`) })()
          const span = plan?.span
          const dy = dialectFor(y.source)
          const time = 'measures' in y && y.time ? ` WHERE r.${dy.quote(y.time)} >= ${dy.date('@from')} AND r.${dy.quote(y.time)} < ${dy.date('@to')}` : ''
          return readAt(obj, y.source, `SELECT * FROM (${y.sql}) r${time && span ? time : ''}`, { ...y.params, ...spanParams(y.sql!, span), ...(time && span ? { from: span.from, to: span.to } : {}) })
        },
      }
      const span = plan?.span
      const t = s.objects[obj].kind === 'fact' ? timeArrow(s, obj) : undefined
      if (t && !span) throw new Error(`${obj} is produced by a program over a span, and the question has none`)
      // WHAT THE PROGRAM IS GIVEN. A filter on one of the produced fact's own arrows, whose members are listed, is
      // handed over when the program says it accepts that arrow — so it reads what the question is about instead of
      // everything. The filter is STILL applied afterwards: pushing it down is an optimisation, never the guarantee.
      const fp = plan?.facts.find((f) => f.fact === obj)
      const pushed = fp ? pushable(s, fp, def.ports).pushed : []
      const keep = Object.fromEntries(pushed.map((k) => [k.role, k.keys]))
      if (pushed.length) c.onProgram?.(`${x.program} is given ${pushed.map((k) => `${k.keys.length} ${k.role}`).join(', ')}`)
      const params = { ...(span ? { from: span.from, to: span.to } : {}), ...(pushed.length ? { keep } : {}) }
      // THE SAME WORK IS THE SAME ROWS. A program, a span and what it was given identify its output exactly; a memo
      // is therefore about work, not about a question, and two questions that need the same rows read them once.
      const work = hashNode('produce', { program: hash, params }, [])
      const held = o.memo?.get(work)
      const started = Date.now()
      const rows = (held ? held.value : await fn(ctx, params)) as Array<Record<string, unknown>>
      if (held) c.onProgram?.(`${obj} from what "${x.program}" produced earlier (${rows.length} rows)`)
      if (!Array.isArray(rows)) throw new Error(`the program "${x.program}" returned something other than rows`)
      const columns = declaredColumns(x)
      const missing = columns.filter((col) => rows.length && !rows.some((r: any) => col in r))
      if (missing.length) throw new Error(`the program "${x.program}" produced rows without ${missing.join(', ')}`)
      // Its rows are held to the object's grain: a fact's arrows and time, an entity's key, never repeated.
      const fx = x as Partial<FactSource & EntitySource>
      const grain: string[] = fx.key ? [fx.key] : [...Object.values(fx.arrows ?? {}), ...(fx.time ? [fx.time] : [])]
      const seen = new Set<string>()
      for (const r of rows) { const k = JSON.stringify(grain.map((g) => r[g])); if (seen.has(k)) throw new Error(`the program "${x.program}" produced two rows for ${grain.map((g) => `${g} ${r[g]}`).join(', ')}`); seen.add(k) }
      if (!held) o.memo?.put(work, rows)
      c.statements.push({ fact: obj, source: `program ${x.program}`, sql: '', params: span ?? {}, rows: rows.length, ms: Date.now() - started, capped: false })
      c.onProgram?.(`${obj} produced by the program "${x.program}" (${rows.length} rows)`)
      x.source = LOCAL; x.sql = table(columns, rows); delete x.program
      src = intervenedSources(s, src, ivs.filter((iv) => iv.on === obj), dialectFor)
    }
    src = expandSources(src)
    // A statement runs in one place: what a locally computed fact joins is read here too — for that fact's statements only.
    const factsHere = plan ? plansOf(plan).flatMap((p) => p.facts.map((f) => f.fact)).filter((f) => src.facts[f]?.source === LOCAL) : []
    const everywhere = src
    if (factsHere.length) {
      src = structuredClone(src)
      // Only what the computed rows lead to is read: the keys each path reaches, hop by hop, in chunks the source
      // answers whole. An entity followed "under" a self arrow, or rates on each row's date, are read in full.
      const q = (x: string) => sqlite.quote(x)
      const rowsOf = new Map<string, Map<string, Record<string, unknown>>>()
      const histories = new Map<string, Array<Record<string, unknown>>>()
      const whole = new Set<string>()
      const fetch = async (obj: string, keys: string[]) => {
        const e = src.entities[obj]
        if (!e?.sql || e.source === LOCAL) return
        const have = rowsOf.get(obj) ?? new Map<string, Record<string, unknown>>()
        rowsOf.set(obj, have)
        const dq = dialectFor(e.source).quote
        const missing = [...new Set(keys)].filter((k) => k !== null && k !== undefined && k !== '' && !have.has(String(k)))
        const chunks = whole.has(obj) ? [null] : Array.from({ length: Math.ceil(missing.length / 500) }, (_, i) => missing.slice(i * 500, i * 500 + 500))
        for (const chunk of chunks) {
          const where = chunk ? ` WHERE r.${dq(e.key)} IN (${chunk.map((_, i) => `@k${i}`).join(', ')})` : ''
          const params = { ...e.params, ...(chunk ? Object.fromEntries(chunk.map((k, i) => [`k${i}`, k])) : {}) }
          for (const r of await readAt(obj, e.source, `SELECT * FROM (${e.sql}) r${where}`, params)) have.set(String(r[e.key]), r)
          for (const [role, h] of Object.entries(e.history ?? {})) {
            const hw = chunk ? ` WHERE r.${dq(h.key)} IN (${chunk.map((_, i) => `@k${i}`).join(', ')})` : ''
            const hr = await readAt(`${obj}.${role}`, e.source, `SELECT * FROM (${h.sql}) r${hw}`, { ...h.params, ...(chunk ? Object.fromEntries(chunk.map((k, i) => [`k${i}`, k])) : {}) })
            histories.set(`${obj}.${role}`, [...(histories.get(`${obj}.${role}`) ?? []), ...hr])
          }
        }
      }
      const valuesAt = (obj: string, role: string): string[] => {
        const e = src.entities[obj]
        const h = e?.history?.[role]
        if (h) return (histories.get(`${obj}.${role}`) ?? []).map((r) => String(r[h.value])).filter((v) => v !== 'null')
        const col = e?.arrows[role]
        return col ? [...(rowsOf.get(obj)?.values() ?? [])].map((r) => r[col]).filter((v) => v !== null && v !== undefined).map(String) : []
      }
      for (const p of plansOf(plan!)) for (const fp of p.facts.filter((f) => factsHere.includes(f.fact))) {
        const fs = src.facts[fp.fact]
        const paths = [...fp.by, ...fp.where].flatMap<{ path: string[]; end: any }>((x) => ('path' in x ? [{ path: x.path, end: x }] : 'attribute' in x && x.at?.length ? [{ path: x.at, end: x }] : []))
        for (const m of fp.measures) { const c = s.objects[fp.fact].measures![m].currency; if (Array.isArray(c) && fp.convert) paths.push({ path: c, end: {} as any }) }
        for (const { path, end } of paths) {
          if (!fs.arrows[path[0]]) continue
          let obj = walk(s, fp.fact, [path[0]])!.object
          if (s.objects[obj].kind !== 'entity') continue
          let keys = (local.prepare(`SELECT DISTINCT ${q(fs.arrows[path[0]])} AS k FROM (${fs.sql}) f`).all() as Array<{ k: unknown }>).map((r) => String(r.k))
          const needsEnd = 'under' in end && end.under || 'contains' in end || 'startsWith' in end || 'attribute' in end
          if ('under' in end && end.under) whole.add(walk(s, fp.fact, path)!.object)
          for (let i = 1; i <= path.length; i++) {
            if (i === path.length && !needsEnd) break
            await fetch(obj, keys)
            if (i === path.length) break
            keys = valuesAt(obj, path[i])
            obj = walk(s, obj, [path[i]])!.object
            if (s.objects[obj].kind !== 'entity') break
          }
        }
      }
      for (const [obj, rows] of rowsOf) {
        const e = src.entities[obj]
        e.sql = table([...new Set([...declaredColumns(e), ...(e.label ? [e.label] : [])])], [...rows.values()]); e.source = LOCAL; e.params = {}
        for (const [role, h] of Object.entries(e.history ?? {})) { h.sql = table([h.key, h.value, h.from, h.to], histories.get(`${obj}.${role}`) ?? []); h.params = {} }
      }
      // Rates on each row's date are read here in full; rates at the span's end are read once, where they are.
      const conv = s.conversion
      if (conv && plansOf(plan!).some((p) => p.facts.some((f) => factsHere.includes(f.fact) && f.convert?.at === 'row'))) {
        const rf = src.facts[conv.fact]
        if (rf?.sql && rf.source !== LOCAL) { const rows = await readAt(conv.fact, rf.source, `SELECT * FROM (${rf.sql}) r`, { ...rf.params, ...spanParams(rf.sql, plan!.span) }); rf.sql = table(declaredColumns(rf), rows); rf.source = LOCAL; rf.params = {} }
      }
    }
    const here = src
    return { sources: (fact: string) => (factsHere.includes(fact) ? here : everywhere), query }
  }

  /** The rows behind one group of a recorded answer, read at their sources as it was asked. */
  async function detail(callId: string, key: Array<Key | null>, a: { model: string; access?: Record<string, unknown[]>; limit?: number }) {
    const c = store.getCall(callId) ?? (() => { throw new Error(`there is no call ${callId}`) })()
    if (!c.plan) throw new Error('that call has no answer to look behind')
    const m = model(a.model, { schema: c.schema, sources: c.sources, settings: c.settings })
    const plan = c.plan as Plan
    const statements: StatementRecord[] = []
    const prepared = await prepare(m.schema, m.sources!, plan, c.nodes, (c.interventions as Intervention[]) ?? [], { today: c.today, access: a.access, read: () => undefined, statements, programs: {}, pinned: c.programs, namespace: m.namespace })
    return detailSql(m.schema, prepared.sources, plan, key, prepared.query, { access: a.access, limit: a.limit, onStatement: (x) => statements.push(x) }, dialectFor)
  }

  // ── data sessions ──

  /** Open a data session — with the id of the conversation it belongs to, or a new one. Opening one that exists keeps it. */
  function openSession(who: Record<string, unknown> | null = null, title: string | null = null, id: string = randomUUID()): string {
    if (!store.getSession(id)) store.openSession(id, who, title)
    return id
  }

  /** A step: a new question, or a move on the step it follows (the current step unless another is named — which
   *  branches the session). A refused move is kept as a step with its refusal and does not become current. */
  async function step(sessionId: string, input: { question: QuestionAsked } | { move: Move | ContextMove; from?: number }, a: Omit<AskOptions, 'sessionId' | 'parentId'>) {
    const session = store.getSession(sessionId) ?? (() => { throw new Error(`there is no session ${sessionId}`) })()
    const m = model(a.model)
    let question: QuestionAsked
    let parent: number | null = null
    // What a step is answered under — settings, interventions, the day — carries to the steps after it.
    let context: SessionContext = { assume: {}, intervene: [] }
    if ('question' in input) {
      question = input.question
      parent = session.currentStep
      const current = parent !== null ? store.steps(sessionId).find((x) => x.id === parent) : undefined
      if (current?.context) context = current.context
    } else {
      parent = input.from ?? session.currentStep
      const from = store.steps(sessionId).find((x) => x.id === parent)
      if (!from) throw new Error('a move needs a step to move from')
      context = from.context ?? context
      question = from.question
      const mv = input.move
      if (mv.move === 'assume') context = { ...context, assume: { ...context.assume, ...mv.set } }
      else if (mv.move === 'unassume') context = { ...context, assume: Object.fromEntries(Object.entries(context.assume).filter(([k]) => !mv.names.includes(k))) }
      else if (mv.move === 'intervene') context = { ...context, intervene: [...context.intervene, ...mv.add] }
      else if (mv.move === 'unintervene') context = { ...context, intervene: mv.on ? context.intervene.filter((x) => !mv.on!.includes(x.on)) : [] }
      else if (mv.move === 'as of') context = { ...context, ...(mv.date ? { today: mv.date } : { today: undefined }) }
      else {
        // A relative span stays relative in the session; the move is checked against the days it means today.
        const asked = from.question as QuestionAsked
        const relative = asked.span && !('to' in asked.span) ? asked.span : undefined
        const day = context.today ?? a.today ?? o.today?.() ?? dayIn(typeof a.who?.timezone === 'string' ? a.who.timezone : 'UTC', o.now?.())
        const dated = relative ? resolveSpan(m.schema, relative, day).span : undefined
        const moved = applyMove(m.schema, (dated ? { ...asked, span: dated } : asked) as Question, mv as Move)
        if (moved.verdict.ok && relative && JSON.stringify(moved.question.span) === JSON.stringify(dated)) moved.question = { ...moved.question, span: relative as any }
        if (!moved.verdict.ok) {
          const refusal = { rule: moved.verdict.rule, reason: moved.verdict.reason }
          const id = store.addStep({ sessionId, parent, move: mv, question: from.question, canonical: from.canonical, callId: null, refusal, context }, false)
          return { stepId: id, answer: { ok: false as const, callId: '', ...refusal } }
        }
        question = moved.question
      }
    }
    const answer = await ask(question, { ...a, sessionId, who: a.who ?? session.who ?? undefined, assume: { ...context.assume, ...a.assume },
      ...(context.intervene.length ? { intervene: context.intervene } : {}), ...(context.today ? { today: context.today } : {}) })
    const stepId = store.addStep({ sessionId, parent, move: 'question' in input ? { question: input.question } : input.move, question,
      canonical: answer.ok ? answer.canonical : null, callId: answer.callId, refusal: answer.ok ? null : { rule: answer.rule, reason: answer.reason }, context }, answer.ok)
    return { stepId, answer }
  }

  /** Where a surprising value comes from. The value's group is asked over the periods before it and drilled down along
   *  the graph — each grouping path one arrow shorter, kept to the group — and a computed output is split into the
   *  measures it is computed from. Every part is judged against its own history; the deepest surprising parts are
   *  where to look first. Each question asked is recorded under the answer being explained. */
  async function triage(callId: string, at: { group: Array<string | null>; period: string; output: string }, a: Omit<AskOptions, 'parentId'> & { depth?: number; window?: number; threshold?: number }) {
    const call = store.getCall(callId) ?? (() => { throw new Error(`there is no call ${callId}`) })()
    const m = model(a.model)
    const q = call.question as Question
    const v = check(m.schema, q)
    if (!v.ok) throw new Error('the call being explained no longer checks against the model')
    const fact = v.plan.facts[0]
    const t = fact.by.findIndex((b) => 'path' in b && m.schema.objects[walk(m.schema, fact.fact, b.path)!.object].kind === 'calendar')
    if (t < 0) throw new Error('only an answer by a calendar level has periods to explain')
    const calendar = m.schema.objects[walk(m.schema, fact.fact, (fact.by[t] as { path: string[] }).path)!.object]
    const window = a.window ?? WINDOW
    const span = { from: calendarPeriod(calendar, shiftPeriods(calendar, at.period, -window)).from, to: calendarPeriod(calendar, at.period).to }

    type Part = { question: Question; group: Array<string | null>; output: string; callId: string; expectation: Expectation; parts: Part[] }
    const node = async (question: Question, group: Array<string | null>, output: string, depth: number): Promise<Part | null> => {
      const asked = await ask({ ...question, span, compare: undefined, totals: undefined, share: undefined, order: undefined, limit: undefined, having: undefined }, { ...a, parentId: callId })
      if (!asked.ok) return null
      const n = asked.plan.targets.length
      const col = n + asked.plan.outputs.findIndex((x) => x.name === output)
      const same = (row: unknown[]) => row.slice(0, n).every((k, i) => i === t || k === group[i < t ? i : i - 1])
      const rows = asked.result.rows.filter(same).sort((x, y) => String(x[t]).localeCompare(String(y[t])))
      const value = (rows.find((r) => r[t] === at.period)?.[col] ?? null) as number | null
      const e = expectation(rows.filter((r) => String(r[t]) < at.period).map((r) => r[col] as number | null), value, a)
      const parts: Part[] = []
      if (depth < (a.depth ?? 2)) {
        // A computed output: the measures it is computed from, for the same group.
        const out = asked.plan.outputs.find((x) => x.name === output)!
        if (!('ref' in out.expr)) for (const ref of refsOf(out.expr)) { const p = await node({ ...question, measures: [ref] }, group, ref, depth + 1); if (p) parts.push(p) }
        // Each grouping path one arrow shorter, kept to this group.
        const targets = question.by ?? []
        for (const [i, target] of targets.entries()) {
          if (i === t || !('to' in target)) continue
          const down = applyMove(m.schema, question, { move: 'drill down', target: i })
          if (!down.verdict.ok) continue
          const via = Object.fromEntries(asked.plan.facts.map((f) => [f.fact, (f.by[i] as { path: string[] }).path]))
          const member = group[i < t ? i : i - 1]
          if (member === null) continue
          const narrowed = applyMove(m.schema, down.question, { move: 'slice', where: { to: target.to, via, in: [member] } })
          if (!narrowed.verdict.ok) continue
          const child = await ask({ ...narrowed.question, span }, { ...a, parentId: callId })
          if (!child.ok) continue
          const members = [...new Set(child.result.rows.map((r) => JSON.stringify(r.slice(0, child.plan.targets.length).filter((_, j) => j !== t))))]
          for (const g of members) { const p = await node(narrowed.question, JSON.parse(g), output, depth + 1); if (p) parts.push(p) }
        }
      }
      return { question, group, output, callId: asked.callId, expectation: e, parts }
    }
    const root = await node(q, at.group, at.output, 0)
    const leads: Part[] = []
    const walkParts = (p: Part) => { const deeper = p.parts.filter((x) => x.expectation.surprising); if (p.expectation.surprising && !deeper.length) leads.push(p); p.parts.forEach(walkParts) }
    if (root) walkParts(root)
    return { root, leads }
  }

  /** The same question with and without the interventions, aligned group by group with the difference. Both answers
   *  are recorded; the comparison names them. */
  async function counterfactual(q: QuestionAsked, intervene: Intervention[], a: Omit<AskOptions, 'intervene'>) {
    const actual = await ask(q, a)
    if (!actual.ok) return { ok: false as const, actual, intervened: null }
    const intervened = await ask(q, { ...a, intervene, parentId: actual.callId })
    if (!intervened.ok) return { ok: false as const, actual, intervened }
    const n = actual.plan.targets.length
    const index = (rows: Result['rows']) => new Map(rows.map((r) => [JSON.stringify(r.slice(0, n)), r.slice(n)]))
    const x = index(actual.result.rows), y = index(intervened.result.rows)
    const keys = [...new Set([...x.keys(), ...y.keys()])].sort()
    const width = actual.plan.outputs.length
    return {
      ok: true as const, actual, intervened, outputs: actual.plan.outputs.map((o) => o.name),
      rows: keys.map((k) => {
        const was = (x.get(k) ?? Array(width).fill(null)).slice(0, width) as Array<number | null>
        const would = (y.get(k) ?? Array(width).fill(null)).slice(0, width) as Array<number | null>
        return { key: JSON.parse(k), actual: was, intervened: would, difference: was.map((v, i) => (v === null || would[i] === null ? null : would[i]! - v)) }
      }),
    }
  }

  /** Which member of an entity was meant by what someone typed: the members the schema lists, or else the entity's
   *  source, searched by its labels — exact, starting with, containing, then within a few typing mistakes. A source that
   *  holds back rows is searched only by what it gives for the text itself, and says so. */
  async function members(modelName: string, object: string, typed: string, a: { access?: Record<string, unknown[]>; limit?: number } = {}) {
    const m = model(modelName)
    const o = m.schema.objects[object]
    if (o?.kind !== 'entity') throw new Error(`${object} is not an entity of "${modelName}"`)
    const named = Object.entries(o.names ?? {}).filter(([n]) => n.toLowerCase() === typed.trim().toLowerCase()).map(([n, key]) => ({ key, label: o.members?.[key] ?? key, how: 'exact' as const, name: n }))
    if (named.length) return { matches: named, ambiguous: named.length > 1, from: 'names people use' }
    if (o.members) return { ...bestMembers(Object.entries(o.members).map(([key, label]) => ({ key, label })), typed), from: 'the schema' }
    const es = m.sources?.entities[object]
    if (!es?.sql || !es.label) throw new Error(`the source of ${object} names no label column, so its members cannot be searched`)
    const dm = dialectFor(es.source), q = dm.quote
    const run = async (sql: string, params: Record<string, unknown>) => o_query(es.source, sql, { ...es.params, ...params }, a.access?.[es.source])
    // Names are searched as typed: LIKE with no ESCAPE, which every source accepts (some refuse ESCAPE).
    const pattern = `%${typed.trim().toLowerCase()}%`
    const near = await run(dm.limit(`SELECT e.${q(es.key)} AS k, e.${q(es.label)} AS l FROM (${es.sql}) e WHERE LOWER(e.${q(es.label)}) LIKE @m`, a.limit ?? 200), { m: pattern })
    const found = bestMembers(near.rows.map((r) => ({ key: String(r.k), label: String(r.l) })), typed)
    if (found.matches.length) return { ...found, from: `the source of ${object}` }
    // NOTHING HOLDS THE WHOLE PHRASE. A name of several words is seldom written the way it is asked for: a word
    // spelled wrong, something in front of it the asker never saw, punctuation where the question had none. So the
    // source is asked for the rows that hold ALL of the words, and if it has none, for the rows that hold all but
    // one — each word dropped in turn — and so on while there is more than one word left.
    //
    // WHY THIS AND NOT A CLEVERER SEARCH. A word that cannot be satisfied is exactly the word that was mistyped,
    // and dropping it is how the rest of the phrase is allowed to speak. Nothing has to guess which word is the
    // distinctive one, or how much of a word to trust, or how common a word is in this particular data — the
    // source answers that by whether it can satisfy the conjunction, and it answers it with its own index.
    const words = [...new Set(typed.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((w) => w.length > 1))]
    const keyCol = q(es.key), labelCol = q(es.label), from = es.sql
    const holding = async (ws: string[]) => {
      const where = ws.map((_, i) => `LOWER(e.${labelCol}) LIKE @w${i}`).join(' AND ')
      const r = await run(dm.limit(`SELECT e.${keyCol} AS k, e.${labelCol} AS l FROM (${from}) e WHERE ${where}`, a.limit ?? 200),
        Object.fromEntries(ws.map((w, i) => [`w${i}`, `%${w}%`])))
      return r.rows.map((x) => ({ key: String(x.k), label: String(x.l) }))
    }
    // A word the source cannot satisfy is a word that was not written the way the source holds it, so it is let
    // go and the rest of the phrase is asked again — one word at a time, then two, while more than one remains.
    // The work is bounded, and when the bound is reached that is SAID, because "I stopped looking" and "it is not
    // there" are different answers and only one of them invites asking again.
    const BUDGET = 24
    let spent = 0
    for (let drop = 0; words.length - drop > 1; drop++) {
      const found = new Map<string, { key: string; label: string }>()
      for (const ws of combinations(words, words.length - drop)) {
        if (spent >= BUDGET) break
        spent++
        for (const c of await holding(ws)) found.set(c.key, c)
      }
      // Scored against EVERYTHING that was typed, including any word let go to find it: a name that holds it after
      // all — one mistake away — is what was meant, and one that never holds it is a different thing.
      const held = found.size ? bestMembers([...found.values()], typed) : { matches: [], ambiguous: false }
      if (held.matches.length) return { ...held, from: `the source of ${object}` }
      if (spent >= BUDGET) return { matches: [], ambiguous: false, from: `the source of ${object}`, note: `no ${object} holds those words; not every way of reading them as a name was tried` }
    }
    // Last, every label, for a mistake in a single short name. A source that stops early is SAID to have stopped:
    // scoring a prefix of the rows as though it were all of them is how a wrong record is returned as the only one.
    const LABELS = 20000
    const all = await run(dm.limit(`SELECT e.${q(es.key)} AS k, e.${q(es.label)} AS l FROM (${es.sql}) e`, LABELS), {})
    if (all.capped || all.rows.length >= LABELS) return { matches: [], ambiguous: false, from: `the source of ${object}`, note: `${es.source} gives only part of ${object}'s members, so typing mistakes were not looked for` }
    return { ...bestMembers(all.rows.map((r) => ({ key: String(r.k), label: String(r.l) })), typed), from: `the source of ${object}` }
  }
  async function o_query(source: string, sql: string, params: Record<string, unknown>, policies?: unknown[]) {
    const rows = await o.query(source, sql, params, { policies })
    return { rows, capped: Array.isArray((rows as any).notes) && (rows as any).notes.length > 0 }
  }

  /** An answer document delivered: datasets from memory, narration written from cited cells, next steps checked. */
  function render(modelName: string, doc: AnswerDoc) {
    return renderAnswer(model(modelName).schema, doc, (id) => store.getCall(id))
  }
  /** How an answer was reached, from memory. */
  function traceOf(callId: string, options: { sql?: boolean } = {}) {
    return trace((id) => store.getCall(id), (id) => store.children(id), callId, options)
  }

  /** Ask a recorded question again on the exact definitions it ran on, as of the day it was answered, for the same
   *  asker with the same settings passed for it — and say whether the answer is the same. Access is always that of
   *  whoever replays. A different answer means the data changed. */
  async function replay(callId: string, a: { model: string; access?: Record<string, unknown[]> }) {
    const c = store.getCall(callId) ?? (() => { throw new Error(`there is no call ${callId}`) })()
    const assume = Object.fromEntries((c.assumptions ?? []).filter((x) => x.from === 'caller').map((x) => [x.name, x.value]))
    const answer = await ask(c.question as QuestionAsked, { model: a.model, on: { schema: c.schema, sources: c.sources, settings: c.settings, programs: c.programs }, today: c.today,
      who: c.who ?? undefined, assume, access: a.access, ...(c.interventions ? { intervene: c.interventions as Intervention[] } : {}) })
    const before = (c.output as Result | null)?.rows
    return { answer, same: answer.ok && before !== undefined ? JSON.stringify(answer.result.rows) === JSON.stringify(before) : c.refusal !== null && !answer.ok }
  }

  return { store, defineSchema, defineSources, defineSettings, defineProgram, detail, members, matchWord, resolveQuestionTerms, render, trace: traceOf, model, ask, openSession, step, triage, replay, counterfactual }
}

/** The nodes of the graph a plan goes through: facts, measures, attributes, each arrow walked and each object reached. */
export function nodesOf(s: Schema, plan: Plan): string[] {
  const out = new Set<string>()
  for (const p of plansOf(plan)) {
    for (const fp of p.facts) {
      out.add(fp.fact)
      for (const m of fp.measures) out.add(`${fp.fact}.${m}`)
      for (const step of [...fp.by, ...fp.where]) {
        if ('attribute' in step) {
          const owner = step.at?.length ? walk(s, fp.fact, step.at)!.object : fp.fact
          out.add(`${owner}.@${step.attribute}`)
          if (step.at?.length) { for (const a of walk(s, fp.fact, step.at)!.walked) out.add(a.to); let at = fp.fact; for (const role of step.at) { out.add(`${at}.${role}`); at = walk(s, at, [role])!.object } }
          continue
        }
        for (const a of walk(s, fp.fact, step.path)!.walked) out.add(a.to)
        let at = fp.fact
        for (const role of step.path) { out.add(`${at}.${role}`); at = walk(s, at, [role])!.object }
      }
      if (fp.convert && s.conversion) out.add(s.conversion.fact)
    }
  }
  return [...out].sort()
}

/** An answer grouped by one calendar level, as observations: one per output, group and period. The series is the
 *  question apart from its span, on the exact definitions it ran on, so a corrected model starts new series. */
export function observationsOf(s: Schema, plan: Plan, q: Question, result: Result, callId: string, at: number, definitions: string): Observation[] {
  const time = plan.facts[0].by.map((b, i) => ('path' in b && s.objects[walk(s, plan.facts[0].fact, b.path)!.object].kind === 'calendar' ? i : -1)).filter((i) => i >= 0)
  if (time.length !== 1) return []
  const t = time[0]
  const level = walk(s, plan.facts[0].fact, (plan.facts[0].by[t] as { path: string[] }).path)!.object
  const series = `${definitions}|${canonicalJson({ ...q, span: undefined, asOf: undefined, order: undefined, limit: undefined, limitPer: undefined, having: undefined, totals: undefined, share: undefined, compare: undefined, fill: undefined })}`
  const n = plan.targets.length
  return result.rows.flatMap((row) => plan.outputs.map((out, i) => ({
    callId, series, group: JSON.stringify(row.slice(0, n).filter((_, j) => j !== t)), level, period: String(row[t]), output: out.name,
    value: typeof row[n + i] === 'number' ? (row[n + i] as number) : null, at,
  })))
}

/** An answer with more values than memory takes at once keeps its largest whole series, never a part of one. */
export function withinLimit(observations: Observation[], limit: number): Observation[] {
  if (observations.length <= limit) return observations
  const bySeries = new Map<string, Observation[]>()
  for (const x of observations) { const k = `${x.group}|${x.output}`; bySeries.set(k, [...(bySeries.get(k) ?? []), x]) }
  const kept: Observation[] = []
  for (const s of [...bySeries.values()].sort((a, b) => Math.abs(total(b)) - Math.abs(total(a)))) if (kept.length + s.length <= limit) kept.push(...s)
  return kept
}
const total = (xs: Observation[]) => xs.reduce((a, x) => a + (x.value ?? 0), 0)

const refsOf = (e: import('./algebra.js').Expr): string[] => ('ref' in e ? [e.ref] : [...refsOf(e.args[0]), ...refsOf(e.args[1])])

/** What a question is about, for rules: the members it keeps, by the object they are members of. */
export function aboutOf(q: Pick<Question, "where">): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const w of q.where ?? []) if ('to' in w && 'in' in w) out[w.to] = [...(out[w.to] ?? []), ...w.in]
  return out
}

/** Whether a question asks for money it would have to convert, so the reporting currency is a setting it reads. */
function needsCurrency(s: Schema, q: Question): boolean {
  const v = check(s, q)
  return !v.ok && v.rule === 'E1' && /say the currency/.test(v.reason)
}

const describeIntervention = (x: Intervention) => 'keys' in x
  ? `${x.on} ${x.keys.join(', ')}: ${Object.entries(x.arrows).map(([r, v]) => `${r} → ${v ?? 'none'}`).join(', ')}${x.from ? ` from ${x.from}` : ''}`
  : `${x.on}${x.match ? ` where ${Object.entries(x.match).map(([k, v]) => `${k} ${[v].flat().join('|')}`).join(', ')}` : ''}: ${[
      x.remove ? 'rows left out' : '', ...Object.entries(x.set ?? {}).map(([m, v]) => `${m} set to ${v}`), ...Object.entries(x.scale ?? {}).map(([m, f]) => `${m} × ${f}`),
      x.add?.length ? `${x.add.length} rows added` : ''].filter(Boolean).join(', ')}`

/** Sources without the objects programs produce — what statements can be put in place of braces before programs run. */
function onlyStatements(src: Sources): Sources {
  return { facts: Object.fromEntries(Object.entries(src.facts).filter(([, x]) => x.sql)), entities: Object.fromEntries(Object.entries(src.entities).filter(([, x]) => x.sql)) }
}
void arrowsOf; void namedIn

/** Moves on what a session's steps are answered under, rather than on the question. */
export type ContextMove =
  | { move: 'assume'; set: Record<string, unknown> }
  | { move: 'unassume'; names: string[] }
  | { move: 'intervene'; add: Intervention[] }
  | { move: 'unintervene'; on?: string[] }
  | { move: 'as of'; date: string | null }
export interface SessionContext { assume: Record<string, unknown>; intervene: Intervention[]; today?: string }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const readableDay = (d: string) => `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`
export const readableSpan = (s: { from: string; to: string }) => `${readableDay(s.from)} – ${readableDay(addDays(s.to, -1))}`

/** What changes how an answer's numbers read, from what the plan did: currency converted, groups with nothing there, a
 *  comparison cut to like for like. Everything else about how it was computed stays in the record.
 *
 *  A NOTE EARNS ITS PLACE ONLY IF THE ANSWER READS DIFFERENTLY WITHOUT IT. What the plan COULD have done is not
 *  news; what it DID, where a reader would otherwise read the number wrongly, is. So the rows are consulted: a
 *  group that is empty of nothing needs no warning about "none", and a path nobody could mistake — a project's
 *  kind is named after the arrow that reaches it — is not worth a line. Ten true sentences that change nothing are read as noise, and the
 *  two that matter are lost among them. */
export function readerNotes(s: Schema, plan: Plan, result?: { columns: Array<{ name: string }>; rows: unknown[][] }): string[] {
  const out = new Set<string>()
  // Did this grouping actually produce a row with nothing there? The column is found by the object it groups by;
  // when that cannot be told apart from another, the note is kept rather than wrongly dropped.
  const hasNone = (object: string): boolean => {
    if (!result) return true
    const at = plan.targets.map((t, i) => [t, i] as const).filter(([t]) => t === object || t.startsWith(`${object} by `))
    if (at.length !== 1) return true
    return result.rows.some((r) => r[at[0][1]] === null || r[at[0][1]] === undefined)
  }
  for (const p of plansOf(plan)) for (const fp of p.facts) {
    if (fp.convert) {
      const on = fp.convert.at === 'end' && p.span ? (p.asOf && p.asOf < addDays(p.span.to, -1) ? p.asOf : addDays(p.span.to, -1)) : undefined
      out.add(`Amounts in other currencies are converted to ${fp.convert.currency} at ${on ? `the rate on ${readableDay(on)}` : "each day's rate"}`)
    }
    for (const b of fp.by) {
      if (!('path' in b)) continue
      const walked = walk(s, fp.fact, b.path)!.walked
      const i = walked.findIndex((a) => a.partial)
      if (i < 0) continue
      const from = i === 0 ? fp.fact : walked[i - 1].to
      if (hasNone(walk(s, fp.fact, b.path)!.object)) out.add(`${from} rows with no ${walked[i].role} are shown as "none"`)
    }
  }
  for (const p of [plan]) for (const fp of p.facts) {
    // A dimension reached more than one way: say which way this answer took.
    for (const step of [...fp.by, ...fp.where]) {
      if (!('path' in step) || step.path.length < 2) continue
      const object = walk(s, fp.fact, step.path)!.object
      if (s.objects[object].kind === 'calendar') continue
      const ways = pathsFrom(s, fp.fact).filter((x) => x.object === object && !walk(s, fp.fact, x.steps)!.walked.some((a) => a.kind === 'self'))
      // Which way this answer took matters only when a reader could have taken another. A note naming an object by
      // the arrow of the same name says the same word twice; one naming a different arrow says WHICH of them it is.
      const role = String(step.path.at(-1))
      if (ways.length > 1 && role.toLowerCase() !== object.toLowerCase()) {
        out.add(`${object} is the ${step.path.slice(0, -1).map((r) => r).join("'s ")}'s ${role}`)
      }
    }
    // A span that cuts the periods it is grouped by: the first or last is only part of one.
    for (const b of fp.by) {
      if (!('path' in b) || !p.span) continue
      const object = walk(s, fp.fact, b.path)!.object
      const cal = s.objects[object]
      if (cal.kind !== 'calendar' || (startsPeriod(cal, p.span.from) && endsPeriod(cal, p.span.to))) continue
      const cut: string[] = []
      if (!startsPeriod(cal, p.span.from)) cut.push(`the first (from ${readableDay(p.span.from)})`)
      if (!endsPeriod(cal, p.span.to)) cut.push(`the last (to ${readableDay(addDays(p.span.to, -1))})`)
      out.add(`${cal.level ? cal.level.charAt(0).toUpperCase() + cal.level.slice(1) : object}s cut by the dates asked are partial: ${cut.join(' and ')}`)
    }
  }
  for (const n of plan.notes) if (/still running|different numbers of/.test(n)) out.add(n.charAt(0).toUpperCase() + n.slice(1))
  return [...out]
}


/** Every way of choosing k of these, in order — smaller choices are made by leaving more out. */
function* combinations<T>(xs: T[], k: number): Generator<T[]> {
  if (k <= 0) { yield []; return }
  if (k > xs.length) return
  if (k === xs.length) { yield xs; return }
  const head = xs[0]!
  const rest = xs.slice(1)
  for (const c of combinations(rest, k - 1)) yield [head, ...c]
  yield* combinations(rest, k)
}
