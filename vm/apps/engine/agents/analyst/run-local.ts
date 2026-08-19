// Local driver: run the ANALYST on ONE question via its module (no hub, no Fly). Same workspace the
// grounding agent populated, so ./grounding/grounding.mjs is live. Streams the analyst's terminal; prints the answer.
//   pnpm exec tsx apps/engine/agents/analyst/run-local.ts <projectId> "the question"
import { createAnalyst } from './index.js'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const projectId = process.argv[2]
const question = process.argv[3]
if (!projectId || !question) { console.error('usage: run-local.ts <projectId> "<question>"'); process.exit(1) }
const managerUrl = process.env.DATASOURCE_URL || 'http://localhost:4000'
const root = process.env.ENGINE_STATE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '.state')

console.log(`[analyst-local] project=${projectId}\n[analyst-local] Q: ${question}\n`)
const analyst = await createAnalyst({
  root, projectId, sources: [projectId], managerUrl,
  ica: { harness: 'claude-code', model: 'claude-sonnet-5' },
})
const qid = 'local_' + projectId
const r = await analyst.ask(question, {
  onOutput: (c) => process.stdout.write(c),
  onCategory: (c) => console.log(`\n[analyst-local] category=${c}\n`),
}, { qid })
console.log(`\n\n[analyst-local] DONE in ${(r.ms / 1000).toFixed(1)}s · category=${r.category}`)
console.log('--- ANSWER ---\n' + JSON.stringify(r.answer, null, 2))
process.exit(0)
