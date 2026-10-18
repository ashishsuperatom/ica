// State is never the raw context -- it's the sparse activation pattern you
// get from running the registered signals against it, recomputed fresh every
// time. Two wildly different raw contexts that activate the same signals the
// same way ARE the same state, by construction.

import { createHash } from 'node:crypto'
import { evaluate, structuralId, type SignalSpec, type SignalRegistry, type EvalResult } from './signal.js'

export type Bucket = 'strong-decline' | 'mild-decline' | 'flat' | 'mild-rise' | 'strong-rise'

function bucketGraded(value: number): Bucket {
  if (value <= -0.5) return 'strong-decline'
  if (value <= -0.1) return 'mild-decline'
  if (value < 0.1) return 'flat'
  if (value < 0.5) return 'mild-rise'
  return 'strong-rise'
}

export interface Activation {
  id: string
  fingerprintKey: string
  result: EvalResult
  active: boolean
  bucket?: Bucket
  tag?: string
}

export interface State {
  fingerprint: string
  activations: Activation[]
}

// Registering each watch signal with the shared registry (rather than
// hashing it locally) is what lets promotion later resolve an id back to its
// definition -- identity and definition live in one place.
export function computeState(context: unknown, watchSignals: SignalSpec[], registry: SignalRegistry): State {
  const activations: Activation[] = watchSignals.map(spec => {
    const id = registry.define(spec)
    const fingerprintKey = structuralId(spec)
    const result = evaluate(spec, context)
    if (result.type === 'boolean') return { id, fingerprintKey, result, active: result.value }
    if (result.type === 'graded') {
      const bucket = bucketGraded(result.value)
      return { id, fingerprintKey, result, active: bucket !== 'flat', bucket }
    }
    if (result.type === 'selection' && result.found) {
      // Bucket the winning score (quantized, not the exact float -- same
      // discipline as TREND's slope) AND tag which criterion is actually
      // driving the win. Score alone can't distinguish "FastFreight wins on
      // speed" from "GreenSource wins on ESG" -- both can land in the same
      // score bucket while being a completely different regime.
      return {
        id, fingerprintKey, result, active: true,
        bucket: bucketGraded(result.score * 2 - 1),
        tag: result.drivingCriterion,
      }
    }
    return { id, fingerprintKey, result, active: result.found }
  })

  // Fingerprint from the STRUCTURAL key (which question) + bucket (what
  // answer), never the exact tunable-parameter hash -- sparse, sorted so key
  // order never matters, and never includes the raw magnitude, only the
  // quantized bucket, so two situations with different numbers but the same
  // shape hash identically, AND two nearby parameter settings of the same
  // signal that land in the same bucket hash identically too.
  const parts = activations
    .filter(a => a.active)
    .map(a => [a.fingerprintKey, a.bucket ?? (a.result.type === 'boolean' ? true : undefined), a.tag])
    .sort((a, b) => (a[0] as string).localeCompare(b[0] as string))

  const fingerprint = createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
  return { fingerprint, activations }
}
