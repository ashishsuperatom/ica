import { computeState } from '../src/state.js'
import { SignalRegistry, type SignalSpec } from '../src/signal.js'

const registry = new SignalRegistry()

const decliningTrend: SignalSpec = { op: 'TREND', input: { op: 'FIND_TIMESERIES' } }
const steepDecline: SignalSpec = { op: 'THRESHOLD_CROSS', input: decliningTrend, bound: -0.05 }
const watch: SignalSpec[] = [decliningTrend, steepDecline]

const contexts: Record<string, unknown> = {
  'revenue, small numbers': { quarterlyRevenue: [100, 98, 95, 90, 85] },
  'revenue, large numbers, different key': { rev_q3: [5000, 4800, 4600, 4300, 4000] },
  'unrelated metric, same shape': { commuteMinutes: [20, 19, 18, 17, 16] },
  'flat / noisy': { widgetCount: [50, 52, 49, 51, 50] },
}

for (const [label, ctx] of Object.entries(contexts)) {
  const state = computeState(ctx, watch, registry)
  console.log(`${label.padEnd(32)} fingerprint=${state.fingerprint}`)
  for (const a of state.activations) {
    console.log(`   ${a.id}  active=${a.active}  bucket=${a.bucket ?? '-'}  result=${JSON.stringify(a.result)}`)
  }
}
