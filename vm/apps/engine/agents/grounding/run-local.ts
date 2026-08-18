// Local driver: run the GROUNDING AGENT against a real source via its module (no hub, no Fly). The AGENT
// does all the work — introspect, decide entities/hierarchies/patterns, build(config), verify. We just start
// it and stream its terminal. Workspace root is the engine's real .agent-workspace so @superatom/* resolves
// and grounding.sqlite lands where the engine would put it.
//   pnpm exec tsx apps/engine/agents/grounding/run-local.ts <projectId>
import { createGroundingAgent } from './index.js'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const projectId = process.argv[2]
if (!projectId) { console.error('usage: run-local.ts <projectId>'); process.exit(1) }
const managerUrl = process.env.DATASOURCE_URL || 'http://localhost:4000'
const root = process.env.ENGINE_STATE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '.state')

console.log(`[grounding-local] project=${projectId} · manager=${managerUrl} · root=${root}\n`)
const agent = await createGroundingAgent({
  root, projectId, sources: [projectId], managerUrl,
  ica: { harness: 'claude-code', model: 'claude-sonnet-5' },
})
console.log(`[grounding-local] cwd=${agent.cwd}\n`)
const r = await agent.build({ onOutput: (c) => process.stdout.write(c) })
console.log(`\n\n[grounding-local] DONE in ${(r.ms / 1000).toFixed(1)}s\n--- report ---\n${r.note}`)
process.exit(0)
