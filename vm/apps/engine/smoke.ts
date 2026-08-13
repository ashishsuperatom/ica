// Smoke test — proves the Session interface end-to-end with the mock harness (no external agent).
import { createSession, prepareWorkspace } from './ica/index.js'

const cwd = await prepareWorkspace({ root: new URL('./.ica-workspace', import.meta.url).pathname, projectId: 'demo' })
const s = createSession('mock', { cwd })
console.log(`Session: mock · cwd ${cwd}\n`)

let events = 0
const r = await s.run('What is our total billed revenue for FY2025-26?', {
  onOutput: (chunk) => process.stdout.write(chunk),
  onEvent: () => { events++ },
})
console.log(`\n— final: ${r.lastLines}\n— events: ${events} · ${r.ms}ms`)
