// Consolidation: notice which signals keep firing TOGETHER across many
// distinct episodes, and bundle them into one new composite signal. This is
// a scoped, practical stand-in for full MDL compression-gain scoring --
// support (how often) and lift (how much more often than chance) are the
// proxy for "does naming this save real description length," the same way
// association-rule mining uses them as a tractable substitute for an exact
// bits-saved calculation.

import type { Entry } from './ports.js'
import type { DecisionData } from './engine.js'
import { SignalRegistry, signalId, type SignalSpec } from './signal.js'

export interface CoOccurrenceCandidate {
  a: string
  b: string
  support: number
  lift: number
}

export function findCoOccurrenceCandidates(
  episodes: string[][],
  { minSupport = 5, minLift = 1.3 }: { minSupport?: number; minLift?: number } = {},
): CoOccurrenceCandidate[] {
  const total = episodes.length
  const singleCount = new Map<string, number>()
  const pairCount = new Map<string, number>()

  for (const ids of episodes) {
    const unique = [...new Set(ids)]
    for (const id of unique) singleCount.set(id, (singleCount.get(id) ?? 0) + 1)
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const key = [unique[i], unique[j]].sort().join('|')
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1)
      }
    }
  }

  const out: CoOccurrenceCandidate[] = []
  for (const [key, support] of pairCount) {
    if (support < minSupport) continue
    const [a, b] = key.split('|')
    const pA = singleCount.get(a)! / total
    const pB = singleCount.get(b)! / total
    const pAB = support / total
    const lift = pAB / (pA * pB)
    if (lift >= minLift) out.push({ a, b, support, lift })
  }
  return out.sort((x, y) => y.support - x.support)
}

// Pulls the per-episode active-signal-id lists straight out of the journal --
// the journal is the only ground truth; this never needs its own storage.
export function episodesFromJournal(entries: Entry[], model?: string): string[][] {
  return entries
    .filter((e) => e.kind === 'decision' && (!model || e.model === model) && Array.isArray((e.data as DecisionData).activeSignalIds))
    .map((e) => (e.data as DecisionData).activeSignalIds!)
}

export interface PromotionResult {
  candidate: CoOccurrenceCandidate
  newSignalId: string
  spec: SignalSpec
}

// Looks up the real spec behind each hash via the registry (never by name),
// builds a new AND-composite, and registers it -- a genuinely new,
// content-addressed concept, distinct from either ingredient, provenance
// intact because nothing about the ingredients was mutated.
export function promote(candidates: CoOccurrenceCandidate[], registry: SignalRegistry): PromotionResult[] {
  const out: PromotionResult[] = []
  for (const c of candidates) {
    const specA = registry.get(c.a)
    const specB = registry.get(c.b)
    if (!specA || !specB) continue // can't promote what we don't have the definition for
    const spec: SignalSpec = { op: 'AND', args: [specA, specB] }
    const newSignalId = registry.define(spec)
    if (newSignalId === signalId(specA) || newSignalId === signalId(specB)) continue
    out.push({ candidate: c, newSignalId, spec })
  }
  return out
}
