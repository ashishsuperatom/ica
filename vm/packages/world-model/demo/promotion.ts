import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEngine } from '../src/engine.js'
import { computeState } from '../src/state.js'
import { SignalRegistry, type SignalSpec } from '../src/signal.js'
import { findCoOccurrenceCandidates, episodesFromLog, promote } from '../src/promotion.js'

const DATA_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', '.data', 'promotion-demo')
rmSync(DATA_DIR, { recursive: true, force: true })

const registry = new SignalRegistry()

const signalA: SignalSpec = { op: 'THRESHOLD_CROSS', input: { op: 'TREND', input: { op: 'FIELD', path: ['metricA'] } }, bound: -0.05 }
const signalB: SignalSpec = { op: 'THRESHOLD_CROSS', input: { op: 'TREND', input: { op: 'FIELD', path: ['metricB'] } }, bound: -0.05 }
const signalC: SignalSpec = { op: 'THRESHOLD_CROSS', input: { op: 'TREND', input: { op: 'FIELD', path: ['metricC'] } }, bound: -0.05 }
const watch = [signalA, signalB, signalC]

function series(steep: boolean): number[] {
  return steep
    ? [100, 90, 80, 70, 60].map(v => v + (Math.random() - 0.5) * 2)
    : [100, 101, 99, 100, 100].map(v => v + (Math.random() - 0.5) * 2)
}

const engine = createEngine({ dataDir: DATA_DIR, snapshotIntervalMs: 999_999 })

console.log('=== Generating 300 episodes: A and B co-decline together ~30% of the time; C is independent ===')
for (let i = 0; i < 300; i++) {
  const pattern = Math.random() < 0.3 // the real, recurring co-occurrence
  const context = {
    metricA: series(pattern || Math.random() < 0.1),
    metricB: series(pattern || Math.random() < 0.1),
    metricC: series(Math.random() < 0.2), // unrelated to the pattern
  }
  const state = computeState(context, watch, registry)
  const activeIds = state.activations.filter(a => a.active).map(a => a.id)
  engine.decide(state.fingerprint, ['noop'], {}, 'noop', activeIds)
}

console.log('\n=== Mining the log for recurring co-activation (consolidation candidates) ===')
const episodes = episodesFromLog(engine.log.readAllLines())
const candidates = findCoOccurrenceCandidates(episodes, { minSupport: 20, minLift: 1.3 })
for (const c of candidates) {
  console.log(`  ${c.a}  &  ${c.b}   support=${c.support}  lift=${c.lift.toFixed(2)}`)
}

console.log('\n=== Promoting qualifying candidates into new composite signals ===')
const promoted = promote(candidates, registry)
for (const p of promoted) {
  console.log(`  NEW signal ${p.newSignalId}  =  AND(${p.candidate.a}, ${p.candidate.b})  (support=${p.candidate.support}, lift=${p.candidate.lift.toFixed(2)})`)
}

console.log('\n=== Sanity check: does signalA-signalC or signalB-signalC ever qualify? ===')
const idA = registry.define(signalA)
const idB = registry.define(signalB)
const idC = registry.define(signalC)
const unwanted = candidates.filter(c => (c.a === idC || c.b === idC))
console.log(unwanted.length === 0 ? '  correctly absent -- C never co-occurs enough to be promoted with A or B' : `  unexpected: ${JSON.stringify(unwanted)}`)

engine.close()
