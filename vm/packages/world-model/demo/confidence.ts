import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEngine } from '../src/engine.js'

const DATA_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', '.data', 'confidence-demo')
rmSync(DATA_DIR, { recursive: true, force: true })

const engine = createEngine({ dataDir: DATA_DIR, snapshotIntervalMs: 999_999, minConfidentN: 5, maxConfidentWidth: 0.3 })
const FP = 'fp-steep'

console.log('=== Before any evidence ===')
console.log(engine.decide(FP, ['escalate', 'skip']))

console.log('\n=== After 2 observations (still shouldn\'t be confident) ===')
for (let i = 0; i < 2; i++) {
  const { decisionId } = engine.decide(FP, ['escalate', 'skip'], {}, 'escalate')
  engine.recordOutcome(decisionId, true)
}
console.log(engine.decide(FP, ['escalate', 'skip']))

console.log('\n=== After 20 consistent observations (should be confident now) ===')
for (let i = 0; i < 20; i++) {
  const { decisionId } = engine.decide(FP, ['escalate', 'skip'], {}, 'escalate')
  engine.recordOutcome(decisionId, Math.random() < 0.85)
}
console.log(engine.decide(FP, ['escalate', 'skip']))

engine.close()
