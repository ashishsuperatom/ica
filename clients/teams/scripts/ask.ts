// Engine smoke test — the fastest "does it work" check, with NO Teams/Azure.
// It exercises the exact path the bot uses (engine-client → hub → code-engine)
// and prints the JSON answer. Run this FIRST to prove the transport + a project
// (e.g. totalgroup) end to end, before wiring any Teams/bot infrastructure.
//
//   cd clients/teams
//   cp .env.example .env      # fill SA_HUB_WS, SA_PROJECT_ID, SA_ENGINE_KEY
//   pnpm install
//   pnpm ask "which branches make money"
//
// (pnpm ask runs: tsx --env-file=.env scripts/ask.ts <question>)

import { askEngine } from '../src/engine-client.js'

const question = process.argv.slice(2).join(' ').trim() || 'which branches make money'
const sessionId = `smoke:${Date.now()}`

console.log(`→ asking: ${question}\n`)

askEngine({
  question,
  sessionId,
  onWaking: () => console.log('… engine is suspended, waking it (can take ~30s) …'),
  onStatus: (t) => console.log(`… ${t}`),
})
  .then(({ category, answer }) => {
    console.log(`\n✅ answer (category: ${category ?? 'n/a'}):\n`)
    console.log(JSON.stringify(answer, null, 2))
    process.exit(0)
  })
  .catch((err) => {
    console.error(`\n❌ ${err?.message ?? err}`)
    process.exit(1)
  })
