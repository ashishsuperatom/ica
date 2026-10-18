import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEngine } from '../src/engine.js'
import { computeState } from '../src/state.js'
import { SignalRegistry, type SignalSpec, type Criterion } from '../src/signal.js'
import { adjustWeight } from '../src/weights.js'

const DATA_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', '.data', 'weight-sensitivity-demo')
rmSync(DATA_DIR, { recursive: true, force: true })

const vendors = [
  { name: 'Acme Co',    esg: 40, delayDays: 2,  quality: 0.95, leadTimeDays: 10 },
  { name: 'GreenSource', esg: 92, delayDays: 6,  quality: 0.88, leadTimeDays: 14 },
  { name: 'FastFreight', esg: 55, delayDays: 1,  quality: 0.90, leadTimeDays: 5  },
  { name: 'ValueVendor', esg: 30, delayDays: 4,  quality: 0.80, leadTimeDays: 8  },
]
const context = { vendors }

const defaultCriteria: Criterion[] = [
  { field: 'esg', weight: 0.25, direction: 'maximize' },
  { field: 'delayDays', weight: 0.25, direction: 'minimize' },
  { field: 'quality', weight: 0.25, direction: 'maximize' },
  { field: 'leadTimeDays', weight: 0.25, direction: 'minimize' },
]

function bestOptionSignal(criteria: Criterion[]): SignalSpec {
  return { op: 'BEST_OPTION', candidates: { op: 'FIELD', path: ['vendors'] }, criteria }
}

function runAndReport(label: string, criteria: Criterion[], registry: SignalRegistry, engine: ReturnType<typeof createEngine>) {
  const spec = bestOptionSignal(criteria)
  const state = computeState(context, [spec], registry)
  const selection = state.activations[0].result
  const activeIds = state.activations.filter(a => a.active).map(a => a.id)
  const decision = engine.decide(state.fingerprint, ['proceed', 'reopen-rfq'], {}, null, activeIds)

  console.log(`\n--- ${label} ---`)
  console.log('weights:', criteria.map(c => `${c.field}=${c.weight.toFixed(3)}`).join('  '))
  if (selection.type === 'selection' && selection.found) {
    console.log(`winner: ${selection.winner.name}  (score=${selection.score.toFixed(3)})`)
    console.log('ranking:', selection.ranked.map(r => `${(r.record as typeof vendors[0]).name}=${r.score.toFixed(3)}`).join('  '))
  }
  console.log(`fingerprint: ${state.fingerprint}`)
  console.log(`decision: ${decision.action}  confident=${decision.confident}`)
  return { fingerprint: state.fingerprint, winner: selection.type === 'selection' && selection.found ? selection.winner.name : null }
}

const registry = new SignalRegistry()
const engine = createEngine({ dataDir: DATA_DIR, snapshotIntervalMs: 999_999 })

const base = runAndReport('Default weights (ESG 25%)', defaultCriteria, registry, engine)

const bumped = adjustWeight(defaultCriteria, 'esg', 10) // "increase ESG weight by 10%"
const after = runAndReport('ESG weight +10% (others rescaled to still sum to 1)', bumped, registry, engine)

console.log('\n--- Did the small tweak actually change anything? ---')
console.log(`winner: ${base.winner} -> ${after.winner}  ${base.winner === after.winner ? '(same vendor still wins)' : '(DIFFERENT vendor wins)'}`)
console.log(`fingerprint: ${base.fingerprint} -> ${after.fingerprint}  ${base.fingerprint === after.fingerprint ? '(same state -- correctly treated as a minor nudge, not a new situation)' : '(DIFFERENT state)'}`)

const bigBump = adjustWeight(defaultCriteria, 'esg', 300) // a much bigger push, to check sensitivity still works
const afterBig = runAndReport('ESG weight +300% (a much bigger push)', bigBump, registry, engine)

console.log('\n--- Did the BIG tweak change anything? ---')
console.log(`winner: ${base.winner} -> ${afterBig.winner}  ${base.winner === afterBig.winner ? '(still the same vendor)' : '(DIFFERENT vendor wins)'}`)
console.log(`fingerprint: ${base.fingerprint} -> ${afterBig.fingerprint}  ${base.fingerprint === afterBig.fingerprint ? '(same state)' : '(DIFFERENT state -- sensitivity correctly detected a real regime change)'}`)

engine.close()
