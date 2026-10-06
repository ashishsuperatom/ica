// For tests: agents as an engine gets them — nodes of the platform's graph, here written straight into the engine's
// replica (<projectDir>/db/composition.sqlite) as the platform would have given them.
import { join } from 'node:path'
import { openStore } from '@superatom/composition-graph/node'

export function agentsInGraph(projectDir: string, specs: Record<string, any>[]) {
  const s = openStore(join(projectDir, 'db', 'composition.sqlite'))
  try {
    for (const a of specs) {
      const { id, name, scope, owner, ...rest } = a
      s.put(String(id), 'agent', { ...(name !== undefined ? { title: name } : {}), ...rest }, { by: 'test' }, { ...(scope ? { scope } : {}), ...(owner ? { owner } : {}) })
    }
  } finally { s.close() }
}
