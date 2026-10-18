// A signal is a typed, content-addressed spec that evaluates against a raw
// context and produces a boolean or graded activation. Primitive signals are
// schema-agnostic (they discover roles by type/shape, never by field name);
// composite signals combine other signals through a small typed algebra.
// Identity is the hash of the spec itself, never a human-given name.

import { createHash } from 'node:crypto'
import { findNumericFields, findTimeSeriesFields } from './discovery.js'

export type SignalSpec =
  | { op: 'FIND_NUMERIC' }
  | { op: 'FIND_TIMESERIES' }
  | { op: 'FIELD'; path: string[] }
  | { op: 'TREND'; input: SignalSpec }
  | { op: 'THRESHOLD_CROSS'; input: SignalSpec; bound: number }
  | { op: 'AND'; args: SignalSpec[] }
  | { op: 'OR'; args: SignalSpec[] }
  | { op: 'NOT'; arg: SignalSpec }
  | { op: 'WEIGHTED_SUM'; args: { weight: number; spec: SignalSpec }[] }
  // The honest scope of this op: pure multi-criteria weighted RANKING over a
  // fixed candidate list, no combinatorial constraints. It's what a MILP
  // reduces to when there's no "pick a subset under a capacity cap" kind of
  // constraint -- a real solver drops in behind the same typed interface
  // the moment those constraints show up, without touching anything else.
  | { op: 'BEST_OPTION'; candidates: SignalSpec; criteria: Criterion[] }

export interface Criterion {
  field: string
  weight: number
  direction: 'maximize' | 'minimize'
}

export type EvalResult =
  | { type: 'role'; found: false }
  | { type: 'role'; found: true; path: string[]; shape: 'numeric' | 'timeseries' | 'records'; value: number | number[] | Record<string, unknown>[] }
  | { type: 'boolean'; value: boolean }
  | { type: 'graded'; value: number }
  | { type: 'selection'; found: false }
  | { type: 'selection'; found: true; winner: Record<string, unknown>; score: number; drivingCriterion: string; ranked: { record: Record<string, unknown>; score: number }[] }

// Canonical JSON (sorted keys) so two structurally identical specs always
// hash the same, regardless of key insertion order.
function canonicalize(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(canonicalize)
  if (x !== null && typeof x === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(x as Record<string, unknown>).sort()) {
      out[k] = canonicalize((x as Record<string, unknown>)[k])
    }
    return out
  }
  return x
}

export function signalId(spec: SignalSpec): string {
  const h = createHash('sha1')
  h.update(JSON.stringify(canonicalize(spec)))
  return h.digest('hex').slice(0, 16)
}

// The fingerprint should identify WHICH KIND of question a signal asks, not
// the exact value of a tunable parameter -- otherwise every small weight
// nudge mints a brand-new signal identity and the attractor tree never
// shares statistics across nearby settings of the same underlying question.
// signalId() (above) stays the full, exact hash -- used for the registry,
// re-evaluation, and provenance, where the exact weights genuinely matter.
export function structuralId(spec: SignalSpec): string {
  if (spec.op === 'BEST_OPTION') {
    const shape = {
      op: spec.op,
      candidates: spec.candidates,
      criteria: spec.criteria.map(c => ({ field: c.field, direction: c.direction })),
    }
    const h = createHash('sha1')
    h.update(JSON.stringify(canonicalize(shape)))
    return h.digest('hex').slice(0, 16)
  }
  return signalId(spec)
}

// Content-addressed store: a signal's identity is its hash, never a name.
// Names, when attached, are decoration looked up through this registry --
// never part of how two signals are compared or matched.
export class SignalRegistry {
  private specs = new Map<string, SignalSpec>()
  private names = new Map<string, string>()

  define(spec: SignalSpec): string {
    const id = signalId(spec)
    if (!this.specs.has(id)) this.specs.set(id, spec)
    return id
  }

  get(id: string): SignalSpec | undefined {
    return this.specs.get(id)
  }

  nameOf(id: string): string | undefined {
    return this.names.get(id)
  }

  setName(id: string, name: string): void {
    this.names.set(id, name)
  }

  all(): [string, SignalSpec][] {
    return [...this.specs.entries()]
  }
}

export function evaluate(spec: SignalSpec, context: unknown): EvalResult {
  switch (spec.op) {
    case 'FIND_NUMERIC': {
      const fields = findNumericFields(context)
      if (!fields.length) return { type: 'role', found: false }
      return { type: 'role', found: true, path: fields[0].path, shape: 'numeric', value: fields[0].value }
    }
    case 'FIND_TIMESERIES': {
      const fields = findTimeSeriesFields(context)
      if (!fields.length) return { type: 'role', found: false }
      return { type: 'role', found: true, path: fields[0].path, shape: 'timeseries', value: fields[0].values }
    }
    case 'FIELD': {
      const value = spec.path.reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], context)
      if (typeof value === 'number') return { type: 'role', found: true, path: spec.path, shape: 'numeric', value }
      if (Array.isArray(value) && value.every(v => typeof v === 'number')) {
        return { type: 'role', found: true, path: spec.path, shape: 'timeseries', value: value as number[] }
      }
      if (Array.isArray(value) && value.every(v => v !== null && typeof v === 'object' && !Array.isArray(v))) {
        return { type: 'role', found: true, path: spec.path, shape: 'records', value: value as Record<string, unknown>[] }
      }
      return { type: 'role', found: false }
    }
    case 'TREND': {
      const role = evaluate(spec.input, context)
      if (role.type !== 'role' || !role.found || role.shape !== 'timeseries') return { type: 'graded', value: 0 }
      return { type: 'graded', value: normalizedSlope(role.value as number[]) }
    }
    case 'THRESHOLD_CROSS': {
      const input = evaluate(spec.input, context)
      const numeric = input.type === 'graded' ? input.value
        : input.type === 'role' && input.found && input.shape === 'numeric' ? (input.value as number)
        : null
      if (numeric === null) return { type: 'boolean', value: false }
      return { type: 'boolean', value: numeric <= spec.bound }
    }
    case 'AND': {
      const vals = spec.args.map(a => asBoolean(evaluate(a, context)))
      return { type: 'boolean', value: vals.every(Boolean) }
    }
    case 'OR': {
      const vals = spec.args.map(a => asBoolean(evaluate(a, context)))
      return { type: 'boolean', value: vals.some(Boolean) }
    }
    case 'NOT': {
      return { type: 'boolean', value: !asBoolean(evaluate(spec.arg, context)) }
    }
    case 'WEIGHTED_SUM': {
      let totalWeight = 0
      let sum = 0
      for (const { weight, spec: s } of spec.args) {
        sum += weight * asGraded(evaluate(s, context))
        totalWeight += weight
      }
      return { type: 'graded', value: totalWeight > 0 ? sum / totalWeight : 0 }
    }
    case 'BEST_OPTION': {
      const role = evaluate(spec.candidates, context)
      if (role.type !== 'role' || !role.found || role.shape !== 'records') return { type: 'selection', found: false }
      const records = role.value as Record<string, unknown>[]
      if (!records.length) return { type: 'selection', found: false }

      // Each criterion is normalized (min-max) ACROSS THIS CANDIDATE SET at
      // evaluation time -- so "esg weight 0.3" means the same thing whether
      // esg scores run 0-1 or 0-100, the same normalization discipline as
      // TREND's slope being scaled by its own series mean.
      const ranges = spec.criteria.map(c => {
        const vals = records.map(r => Number(r[c.field]))
        return { field: c.field, lo: Math.min(...vals), hi: Math.max(...vals) }
      })

      const ranked = records
        .map(record => {
          let score = 0
          let topContribution = -Infinity
          let drivingCriterion = spec.criteria[0]?.field ?? ''
          for (const c of spec.criteria) {
            const { lo, hi } = ranges.find(r => r.field === c.field)!
            const raw = Number(record[c.field])
            const norm = hi > lo ? (raw - lo) / (hi - lo) : 0.5
            const contribution = c.weight * (c.direction === 'minimize' ? 1 - norm : norm)
            score += contribution
            if (contribution > topContribution) {
              topContribution = contribution
              drivingCriterion = c.field
            }
          }
          return { record, score, drivingCriterion }
        })
        .sort((a, b) => b.score - a.score)

      // drivingCriterion (which single criterion contributed most to the
      // winner's score) is what actually distinguishes "FastFreight wins
      // because it's fast" from "GreenSource wins because of ESG" -- the top
      // score bucket alone can't tell those regimes apart.
      return { type: 'selection', found: true, winner: ranked[0].record, score: ranked[0].score, drivingCriterion: ranked[0].drivingCriterion, ranked }
    }
  }
}

function asBoolean(r: EvalResult): boolean {
  if (r.type === 'boolean') return r.value
  if (r.type === 'graded') return r.value > 0
  return r.found
}

function asGraded(r: EvalResult): number {
  if (r.type === 'graded') return r.value
  if (r.type === 'boolean') return r.value ? 1 : 0
  if (r.type === 'selection') return r.found ? r.score : 0
  return 0
}

// Slope normalized by the series' own mean, so magnitude is comparable
// across fields with wildly different raw scales -- this is the mechanism
// validated earlier: different numbers, same shape, same fingerprint.
function normalizedSlope(values: number[]): number {
  const n = values.length
  const xs = values.map((_, i) => i)
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = values.reduce((a, b) => a + b, 0) / n
  let num = 0, den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (values[i] - meanY)
    den += (xs[i] - meanX) ** 2
  }
  const slope = den === 0 ? 0 : num / den
  const scale = Math.abs(meanY) > 1e-9 ? Math.abs(meanY) : 1
  return Math.max(-1, Math.min(1, slope / scale))
}
