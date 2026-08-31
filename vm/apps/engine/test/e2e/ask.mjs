// ⚠️  TEST-ONLY client. Send ONE question to the ALREADY-RUNNING local hub (start the rig with `run.mjs … --keep`
// first) and print the narrator beats + the final answer. Used to drive scenarios 2 & 3 against the same engine.
//   node ask.mjs "<question>" [sessionId]
// Pass the SAME sessionId as scenario 1 to test exact-question reuse.
import WebSocket from 'ws'

const PORT = Number(process.env.TEST_HUB_PORT || 5174)
const question = process.argv[2] || 'What is our total headcount?'
const sid = process.argv[3] || 'e2e-sess'
const qid = 'ask-' + Math.floor(Date.now() / 1000)
const t0 = Date.now()
const ws = new WebSocket(`ws://localhost:${PORT}/client`)

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'client-hello' }))
  setTimeout(() => ws.send(JSON.stringify({ payload: { t: 'analyse', question, sessionId: sid, questionId: qid } })), 300)
  console.log(`\nQ: "${question}"  (session ${sid})`)
})
ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw.toString()) } catch { return }
  const p = m.payload || {}
  if (p.t === 'narration')        console.log(`  · beat: ${p.text}`)
  if (p.t === 'analyst:progress') console.log(`  · progress: ${p.text}`)
  if (p.t === 'analyst:answer') {
    console.log(`\n=== ANSWER (${p.category}, ${((Date.now() - t0) / 1000).toFixed(0)}s) ===`)
    console.log(typeof p.answer === 'string' ? p.answer : JSON.stringify(p.answer, null, 2))
    process.exit(0)
  }
})
setTimeout(() => { console.error('timeout waiting for answer'); process.exit(1) }, 7 * 60 * 1000)
