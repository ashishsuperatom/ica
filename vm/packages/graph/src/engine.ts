// ── THE ENGINE: WHERE EVERY PROGRAM IS RUN ────────────────────────────────────────────────────────────────
//
// Programs never call each other directly. They ask the engine, by name, and the engine resolves the name to
// the exact program it points at right now, runs it, and remembers the call. Going through here every time is
// what makes three things true that could not be true otherwise:
//
//   a correction lands once       a caller names an idea, so repointing the name fixes every caller
//   every answer is traceable     each call records the precise program that produced it
//   the contract is enforced      a program reads only what it declared it reads
//
// This file is the four things done to programs — define, call, replay, counterfactual. The work they rely on is
// in its own modules: answer.ts, composition.ts, assumptions.ts, interventions.ts, definition.ts.

import { randomUUID } from 'node:crypto'
import { answerRelation } from './answer.js'
import { difference } from './compare.js'
import { catalog, members } from './discovery.js'
import { compareAt, readingContext } from './composition.js'
import { contractProblem, type Contract } from './contract.js'
import type { Coordinates } from './coordinates.js'
import { calendarFor, zoneFor } from './assumptions.js'
import { Grains } from './calendar.js'
import { expect, lineageOf, observationsOf, surprisesAmong, surprisesIn, triage, withinLimit } from './expectations.js'
import { MAX_OBSERVATIONS_PER_CALL, type CallRecord } from './store.js'
import { checkRelation, interfaceMisfit, programParamMisfit, reachesName } from './definition.js'
import { programHash } from './hash.js'
import { namespaceOf } from './registry.js'
import { sessions } from './session.js'
import { createRuntime, newTrail, type CallOptions, type EngineOptions, type Intervention, type ProgramContext, type Scope } from './runtime.js'

export type { CallOptions, EngineOptions, Intervention, ProgramContext, Query, SqlAnalysis } from './runtime.js'
export { managerInspect } from './definition.js'

export interface DefineResult { hash: string; name: string; created: boolean }
export interface CallResult<T = unknown> { value: T; callId: string; hash: string }

/** Values checked against memory in one answer. Beyond this, an answer is remembered but not checked value by value. */
const MAX_CHECKED_PER_CALL = 500
const round = (x: number | null) => (x == null ? '—' : Math.abs(x) >= 100 ? Math.round(x).toLocaleString('en') : Number(x.toPrecision(3)).toString())

export function createEngine(o: EngineOptions) {
  const rt = createRuntime(o)

  async function define(input: { body: string; contract: Contract },
                        meta: { by: string; reason?: string; replace?: boolean }): Promise<DefineResult> {
    const bad = contractProblem(input.contract)
    if (bad) throw new Error(`not defined — ${bad}`)
    const { contract, body } = input

    // EVERY PROGRAM IT READS MUST ALREADY EXIST. A missing one is a hole in the graph, and the moment of
    // definition is where it is cheapest to say so — not at the first call, in front of someone's question.
    // A LIBRARY IS NOT CHANGED FROM HERE. Its programs are someone else's; they are used, not redefined.
    const library = rt.programs.libraryOf(contract.name)
    if (library) throw new Error(`not defined — "${contract.name}" is in the library "${library.namespace}", which is read-only here`)
    const ns = namespaceOf(contract.name)
    for (const read of contract.reads.programs) {
      if (!rt.programs.resolve(read, ns)) throw new Error(`not defined — "${contract.name}" reads "${read}", which does not exist`)
    }

    const hash = programHash(body, contract)
    const created = !o.store.getProgram(hash)
    const current = o.store.resolve(contract.name)

    // A NAME MAY NOT BE MADE TO REACH ITSELF. A new program only reads names that already exist, so it cannot close
    // a loop; a replacement can, because every caller of the old name now reaches the new program's reads.
    const loop = reachesName(rt, contract.reads.programs, contract.name, ns)
    if (loop) throw new Error(`not defined — "${contract.name}" would reach itself: ${[contract.name, ...loop].join(' → ')}`)

    // A REPLACEMENT MUST STILL FIT ITS CALLERS. Every caller was written against the old program's interface; a
    // correction that drops a column, changes a unit or turns a stock into a flow would fix one thing and break
    // every program above it — at their next run, in front of someone else's question.
    if (current && current !== hash && meta.replace) {
      const misfit = interfaceMisfit(o.store.getProgram(current)!.contract, contract)
      if (misfit) throw new Error(`not defined — "${contract.name}" cannot replace ${current}: ${misfit}`)
    }
    if (contract.returns === 'relation') {
      try { await checkRelation(rt, hash, body, contract) }
      catch (e: any) { throw new Error(`not defined — "${contract.name}": ${e?.message ?? e}`) }
    }
    o.store.putProgram({ hash, contract, body, createdAt: Date.now(), createdBy: meta.by })

    // A NAME IS CHECKED BEFORE IT IS TAKEN. Pointing an existing name somewhere new changes what every caller of
    // that name gets — right for a correction, wrong for an accidental collision. Only an explicit replace may.
    if (current && current !== hash && !meta.replace) {
      throw new Error(`not defined — "${contract.name}" already names ${current}. Give this program a name of ` +
        `its own, or replace that one deliberately.`)
    }
    if (current !== hash) o.store.point(contract.name, hash, meta.by, meta.reason)
    return { hash, name: contract.name, created }
  }

  async function run<T>(asked: string, request: Record<string, unknown>, parentId: string | null,
                        scope: Scope, path: string[], from = ''): Promise<CallResult<T>> {
    const found = rt.programs.resolve(asked, from)
    if (!found) throw new Error(`no program named "${asked}"`)
    const { name, hash } = found
    const program = rt.programs.program(hash)!
    const { contract } = program

    const id = randomUUID()
    const started = Date.now()
    const trail = newTrail()
    if (scope.zone && !parentId) trail.assumed.push({ name: 'timezone', value: scope.zone.zone, from: scope.zone.from })
    if (!scope.zone && !parentId && !o.today) trail.caveats.push(`today is taken as ${scope.today} in UTC — the request did not say where the asker is`)

    const ctx: ProgramContext = {
      ...readingContext(rt, contract, scope, trail),
      async call<U>(child: string, childRequest: Record<string, unknown> = {}, options: { assume?: Record<string, unknown> } = {}) {
        // A program may call what its contract names, or a program its caller named in a program parameter.
        const passed = Object.entries(contract.params).some(([p, spec]) => typeof spec !== 'string' && request[p] === child)
        if (!contract.reads.programs.includes(child) && !passed) {
          throw new Error(`"${name}" called "${child}", which its contract does not declare it reads and no parameter names`)
        }
        const childScope = options.assume ? { ...scope, context: { ...scope.context, ...options.assume } } : scope
        return (await run<U>(child, childRequest, id, childScope, [...path, hash], namespaceOf(name))).value
      },
      decide(label, took, reason) { trail.decisions.push({ label, took, reason }); return took },
      decideAt(label, value, op, threshold, reason) {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`"${label}" was decided on ${value}, which is not a number`)
        const took = compareAt(value, op, threshold)
        trail.decisions.push({ label, took, reason: reason ?? `${value} ${op} ${threshold}`, boundary: { value, op, threshold, margin: value - threshold } })
        return took
      },
      expectation(program, ask) {
        const passed = Object.entries(contract.params).some(([p, spec]) => typeof spec !== 'string' && request[p] === program)
        if (!contract.reads.programs.includes(program) && !passed) throw new Error(`"${name}" read the memory of "${program}", which its contract does not declare it reads`)
        const grain = grainOf(ask.period)
        return expect(o.store, { name: program, request: ask.request, context: scope.context, lineage: o.store.latestLineage(program), measure: ask.measure, member: ask.member, period: ask.period, grain, window: ask.window })
      },
      async verify(label, holds, detail) {
        const held = Boolean(await holds())
        trail.verifications.push({ label, held, detail })
        if (!held) throw new Error(`invariant failed: ${label}${detail ? ` — ${detail}` : ''}`)
      },
      caveat(text) { trail.caveats.push(text) },
    }

    let value: unknown
    let error: string | null = null
    try {
      for (const [p, spec] of Object.entries(contract.params)) {
        if (typeof spec === 'string' || request[p] === undefined) continue
        const misfit = programParamMisfit(rt, String(request[p]), spec)
        if (misfit) throw new Error(`"${name}": parameter "${p}" — ${misfit}`)
      }
      // A program that reaches itself again through its calls would never finish.
      if (path.includes(hash)) throw new Error(`"${name}" calls itself: ${[...path, hash].map((h) => rt.programs.program(h)?.contract.name ?? h).join(' → ')}`)
      const iv = scope.interventions[name]
      if (iv && 'value' in iv) {
        if (contract.returns === 'relation') throw new Error(`"${name}" is a relation; intervene on its rows with where or add, not value`)
        trail.decisions.push({ label: 'intervened', took: true, reason: 'this request gives the program\'s value instead of running it' })
        value = iv.value
      } else if (contract.returns === 'relation') {
        value = await answerRelation(rt, { name, hash, contract, body: program.body }, request as Coordinates, scope, trail, path)
      } else {
        value = await (await rt.load(hash, program.body))(ctx, request)
      }
      if (contract.returns === 'rows' && !Array.isArray(value)) {
        throw new Error(`"${name}" declares it returns rows but returned ${value === null ? 'null' : typeof value}`)
      }
      if (value === undefined) throw new Error(`"${name}" returned nothing`)
    } catch (e: any) {
      error = String(e?.message ?? e)
    }

    const interventions = Object.keys(scope.interventions).length ? scope.interventions : null
    // LINEAGE: the exact programs this answer came from, so memory never mixes versions across a correction.
    const lineage = lineageOf(hash, [...o.store.children(id).map((k) => k.lineage), ...trail.used.keys()])
    // MEMORY, AND WHAT IT EXPECTED. Every real answer leaves its values in memory, and each is first compared with what
    // memory expected of it; a hypothetical answer leaves nothing, or what was imagined would become what is expected.
    let surprises: CallRecord['surprises'] = []
    if (!error && !interventions) {
      const grains = new Grains(calendarFor(o.assumptions, scope, newTrail()))
      const { kept, series, keptSeries } = withinLimit(observationsOf({ id, name, hash, request, at: started, today: scope.today, lineage }, scope.context, value, (g) => grains.has(g)), MAX_OBSERVATIONS_PER_CALL)
      if (kept.length <= MAX_CHECKED_PER_CALL) {
        surprises = surprisesAmong(o.store, kept, request, scope.context, lineage).map((s) =>
          ({ member: s.member, period: s.period, measure: s.measure, value: s.expectation.value ?? null, median: s.expectation.median!, z: s.expectation.z! }))
        for (const s of surprises.slice(0, 5)) {
          const who = Object.values(s.member).filter((v) => v != null).join(', ')
          trail.caveats.push(`unusual: ${s.measure}${who ? ` for ${who}` : ''} in ${s.period} is ${round(s.value)}, where ${round(s.median)} was expected`)
        }
        if (surprises.length > 5) trail.caveats.push(`and ${surprises.length - 5} more unusual values`)
      }
      o.store.recordObservations(kept)
      if (keptSeries < series) trail.caveats.push(`memory keeps ${keptSeries} of this answer's ${series} series, the largest — one answer adds at most ${MAX_OBSERVATIONS_PER_CALL} values`)
    }
    if (interventions && !parentId) trail.caveats.push(`hypothetical: this answer changes ${Object.keys(interventions).map((k) => `"${k}"`).join(', ')} for this request only`)
    const shared = { at: started, today: scope.today, interventions, who: scope.who ?? null }
    o.store.recordCall({ id, parentId, name, hash, request, output: error ? null : value, error, decisions: trail.decisions,
                         verifications: trail.verifications, caveats: [...new Set(trail.caveats)], queries: trail.queries,
                         ms: Date.now() - started, assumptions: trail.assumed, context: parentId ? null : scope.context, lineage, surprises, ...shared })
    // Relations inlined into this one, and entities joined, ran inside its SQL. They are remembered as calls with no
    // queries of their own, so lineage still finds every answer that went through them.
    for (const [usedHash, usedName] of trail.used) {
      o.store.recordCall({ id: randomUUID(), parentId: id, name: usedName, hash: usedHash, request: { inlinedInto: name }, output: null,
                           error: null, decisions: [], verifications: [], caveats: [], queries: [], ms: 0, assumptions: [], context: null, lineage: usedHash, ...shared })
    }
    if (error) throw Object.assign(new Error(error), { callId: id })
    return { value: value as T, callId: id, hash }
  }

  /** Ask a program, by name. `today` fixes the day it is answered as of; by default, the engine's clock. */
  async function call<T = unknown>(name: string, request: Record<string, unknown> = {}, options: CallOptions = {}): Promise<CallResult<T>> {
    const context = options.assume ?? {}
    const zone = zoneFor(o.assumptions, context, options.who) ?? undefined
    return run<T>(name, request, null, { today: options.today ?? rt.clock(zone?.zone), context, zone, checks: options.checks ?? o.checks ?? 'thorough',
                                         interventions: options.intervene ?? {}, who: options.who, access: options.access }, [])
  }

  /** The options a recorded call was asked with — except access, which is always that of whoever asks again. */
  function recorded(callId: string, access?: Record<string, unknown[]>) {
    const c = o.store.getCall(callId)
    if (!c) throw new Error(`no call ${callId}`)
    const options: CallOptions = { today: c.today ?? undefined, assume: c.context ?? {}, intervene: (c.interventions as Record<string, Intervention>) ?? {},
                                   who: c.who ?? undefined, access }
    return { c, options }
  }

  /** Ask a past call's question again, as of the same day, through whatever its names point at now. Access is
   *  not replayed: it is whatever the person replaying may read now, given here. */
  async function replay<T = unknown>(callId: string, options: { access?: Record<string, unknown[]> } = {}): Promise<CallResult<T>> {
    const { c, options: as } = recorded(callId, options.access)
    return call<T>(c.name, c.request as Record<string, unknown>, as)
  }

  // ── COUNTERFACTUALS: WHAT A PAST ANSWER WOULD HAVE BEEN ──────────────────────────────────────────────────────
  //
  // A past question is asked again as of its own day, under its own assumptions and interventions, twice: once as
  // it was, once with the change. The difference is the change's effect and nothing else. Comparing the change with
  // the RECORDED answer instead would mix in every correction made since — a fixed concept would look like an
  // effect of the hires.
  //
  // What the change does not touch is held as it was. For a definitional graph — capacity is FTE times a week —
  // that is exact. Where the world would have responded (more people, more hours booked), nothing here models it,
  // and the answer says so.
  async function counterfactual<T = unknown>(callId: string, change: { assume?: Record<string, unknown>; intervene?: Record<string, Intervention> },
                                             options: { access?: Record<string, unknown[]> } = {}) {
    if (!change.assume && !change.intervene) throw new Error('a counterfactual needs a change: assume, intervene, or both')
    const { c, options: as } = recorded(callId, options.access)
    const factual = await call<T>(c.name, c.request as Record<string, unknown>, as)
    const counter = await call<T>(c.name, c.request as Record<string, unknown>,
      { ...as, assume: { ...as.assume, ...change.assume }, intervene: { ...as.intervene, ...change.intervene } })
    const drifted = JSON.stringify(c.output) !== JSON.stringify(o.store.getCall(factual.callId)!.output)
    return {
      question: { name: c.name, request: c.request, asOf: c.today },
      change,
      factual, counterfactual: counter,
      difference: difference(factual.value, counter.value),
      caveats: [
        `held as it was: everything the change does not alter — ${[...Object.keys(change.intervene ?? {}), ...Object.keys(change.assume ?? {})].map((k) => `"${k}"`).join(', ')} changed, and nothing responds to it`,
        ...(drifted ? ['the answer as it was differs from the one recorded: the programs or data it reads have changed since, so both sides are recomputed now'] : []),
      ],
    }
  }

  /** The grain a period label belongs to, by its form: 2026-05-03 day, 2026-05 month, 2026-Q2 quarter, 2026 year,
   *  FY2027-Q1 a fiscal quarter. A week is labelled by its Monday, like a day, so a weekly series is asked by grain. */
  function grainOf(period: string): string {
    if (/^\d{4}-\d{2}-\d{2}$/.test(period)) return 'day'
    if (/^\d{4}-\d{2}$/.test(period)) return 'month'
    if (/^\d{4}-Q\d$/.test(period)) return 'quarter'
    if (/^\d{4}$/.test(period)) return 'year'
    const custom = Object.entries(calendarFor(o.assumptions, { today: '', context: {}, interventions: {}, checks: 'light' }, newTrail()))
      .find(([g]) => new Grains(calendarFor(o.assumptions, { today: '', context: {}, interventions: {}, checks: 'light' }, newTrail())).periods(g, '1990-01-01', '2060-01-01').some((p) => p.label === period))
    if (custom) return custom[0]
    throw new Error(`cannot tell which grain the period "${period}" belongs to`)
  }

  const contextOf = (c: CallRecord) => o.store.root(c.id)?.context ?? null
  const isGrainFor = () => { const g = new Grains(calendarFor(o.assumptions, { today: '', context: {}, interventions: {}, checks: 'light' }, newTrail())); return (n: string) => g.has(n) }

  /** Every value in a recorded answer outside what memory expected of it. */
  function surprises(callId: string, options: { threshold?: number; window?: number } = {}) {
    const c = o.store.getCall(callId) ?? (() => { throw new Error(`no call ${callId}`) })()
    return surprisesIn(o.store, c, contextOf(c), isGrainFor(), options)
  }

  /** Where a surprise in a recorded answer comes from: its parts, against their own memory. */
  function explain(callId: string, at: { member: Record<string, unknown>; period: string; measure: string }, options: { threshold?: number; window?: number } = {}) {
    const c = o.store.getCall(callId) ?? (() => { throw new Error(`no call ${callId}`) })()
    return triage(o.store, c, contextOf(c), isGrainFor(), at, options)
  }

  // ── DECISIONS, REVIEWED ─────────────────────────────────────────────────────────────────────────────────────
  // A decision made on a number records how far that number was from the threshold. Reviewing asks each deciding
  // question again as of a later day — its relative dates now meaning later periods — and reports every decision
  // that would now go the other way, with the numbers either side. A decision is never silently kept once the
  // data has crossed its boundary.
  async function review(options: { today: string; access?: Record<string, unknown[]> }) {
    const latest = new Map<string, CallRecord>()
    for (const c of o.store.decidingCalls()) latest.set(JSON.stringify([c.name, c.request, c.context, c.who]), c)
    const out = []
    for (const c of latest.values()) {
      const again = await call(c.name, c.request as Record<string, unknown>, { today: options.today, assume: c.context ?? {}, who: c.who ?? undefined, access: options.access })
      const now = o.store.getCall(again.callId)!.decisions
      const flipped = c.decisions.filter((d) => d.boundary).flatMap((d) => {
        const n = now.find((x) => x.label === d.label)
        return n && n.took !== d.took ? [{ label: d.label, was: { took: d.took, ...d.boundary! }, now: { took: n.took, ...(n.boundary ?? {}) } }] : []
      })
      out.push({ name: c.name, request: c.request, decidedOn: c.today, reviewedOn: options.today, callId: c.id, reviewCallId: again.callId, flipped, reopened: flipped.length > 0 })
    }
    return out
  }

  return {
    define, call, replay, counterfactual, surprises, explain, review,
    /** Data sessions: a person's questions as states, each follow-up a message. See session.ts. */
    sessions: sessions(o.store, rt.programs, () => new Grains(calendarFor(o.assumptions, { today: '', context: {}, interventions: {}, checks: 'light' }, newTrail())), call),
    /** What programs exist, with each relation's measures, dimensions and entities. */
    catalog: () => catalog(rt.programs),
    /** Which members of a relation's dimension match what someone typed. */
    members: (relation: string, ask: Parameters<typeof members>[3], options: CallOptions = {}) => members(rt.programs, call, relation, ask, options),
    store: o.store,
  }
}

export type Engine = ReturnType<typeof createEngine>
