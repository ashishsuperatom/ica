import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEngine } from '../src/engine.js'
import { bucketSlope, fingerprint } from '../src/fingerprint.js'
import type { Who } from '../src/attractor.js'

const DATA_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', '.data', 'procurement-demo')
rmSync(DATA_DIR, { recursive: true, force: true }) // clean slate for a repeatable demo run

const THRESHOLD = -0.05
const ACTIONS = ['escalate', 'skip']

// "steep" commodity-price decline vs "mild" decline -- same bucketing idea
// validated earlier, now the thing being scoped per org/group/user.
const STATES = {
  steep: fingerprint({ trend: 'declining', bucket: bucketSlope(-0.2, THRESHOLD) }),
  mild: fingerprint({ trend: 'declining', bucket: bucketSlope(-0.02, THRESHOLD) }),
}

// The hidden ground truth this demo tries to recover, at three levels:
//  - org default:      steep -> escalate, mild -> skip
//  - sales (group):    biased toward escalate even on mild (risk-averse on revenue)
//  - marketing (group): biased toward skip even on steep (less risk-averse)
//  - bob (user, in sales): personally reverts to the org default on mild,
//    despite his own group's bias -- the override-cuts-through-group case.
function trueSuccessProb(who: Who, state: 'steep' | 'mild', action: string): number {
  const orgCorrect = state === 'steep' ? 'escalate' : 'skip'
  let p = action === orgCorrect ? 0.85 : 0.2

  if (who.group === 'group:sales' && state === 'mild') {
    p = action === 'escalate' ? 0.8 : 0.5
  }
  if (who.group === 'group:marketing' && state === 'steep') {
    p = action === 'skip' ? 0.75 : 0.5
  }
  if (who.user === 'user:bob' && state === 'mild') {
    p = action === 'skip' ? 0.85 : 0.3
  }
  return p
}

function sampleOutcome(p: number): boolean {
  return Math.random() < p
}

const actors: Who[] = [
  { group: 'group:sales', user: 'user:alice' },
  { group: 'group:sales', user: 'user:bob' },
  { group: 'group:marketing', user: 'user:carol' },
  { group: 'group:marketing', user: 'user:dave' },
]

function run(): void {
  console.log('=== Phase 1: bootstrap (exploration), like the LLM-driven phase ===')
  let engine = createEngine({ dataDir: DATA_DIR, snapshotIntervalMs: 999_999 })

  for (const who of actors) {
    for (const state of ['steep', 'mild'] as const) {
      for (let i = 0; i < 60; i++) {
        const action = ACTIONS[Math.floor(Math.random() * ACTIONS.length)]
        const { decisionId } = engine.decide(STATES[state], ACTIONS, who, action)
        engine.recordOutcome(decisionId, sampleOutcome(trueSuccessProb(who, state, action)))
      }
    }
  }

  console.log('\n=== Phase 2: engine decides autonomously, per scope, on the SAME fingerprint ===')
  for (const who of actors) {
    for (const state of ['steep', 'mild'] as const) {
      const result = engine.decide(STATES[state], ACTIONS, who)
      const d = result.detail
      console.log(
        `${who.user?.padEnd(10)} state=${state.padEnd(6)} -> ${result.action.padEnd(8)} ` +
        `(escalate: mean=${d.escalate.mean.toFixed(2)} from=${d.escalate.sourceLevel}, ` +
        `skip: mean=${d.skip.mean.toFixed(2)} from=${d.skip.sourceLevel})`
      )
    }
  }

  console.log('\n=== Also check: a brand-new user in sales, never seen before ===')
  const newHire: Who = { group: 'group:sales', user: 'user:erin' }
  for (const state of ['steep', 'mild'] as const) {
    const result = engine.decide(STATES[state], ACTIONS, newHire)
    console.log(`user:erin  state=${state.padEnd(6)} -> ${result.action}  (inherits group:sales' learned bias, zero personal data)`)
  }

  console.log('\n=== Phase 3: durability -- close, reopen as a fresh process, decide again ===')
  engine.close()
  engine = createEngine({ dataDir: DATA_DIR, snapshotIntervalMs: 999_999 })
  for (const who of actors) {
    const result = engine.decide(STATES.mild, ACTIONS, who)
    console.log(`${who.user?.padEnd(10)} state=mild   -> ${result.action}  (after restart, from snapshot+log replay)`)
  }
  engine.close()
}

run()
