// Standalone round-trip proof for the fast-router DO wiring. Works against ANY running DO — a local
// `wrangler dev` or a deployed hub. It opens THREE real WebSockets to one fast-router DO and checks:
//   • the worker registers as role 'fast-router' (key auth)
//   • TWO code-engines register as role 'runtime' (key auth) and COEXIST — no eviction
//   • a runtime's { to:{type:'fast-router'} } reaches the worker with the stamped `from`
//   • the worker's reply { to:{id} } reaches ONLY that runtime, not the other
//
//   HUB=ws://127.0.0.1:8787  FR_ID=fr-test  KEY=shared-key-123  node scripts/roundtrip.mjs
import WebSocket from 'ws'

const HUB = (process.env.HUB || 'ws://127.0.0.1:8787').replace(/\/+$/, '')
const ID = process.env.FR_ID || 'fr-test'
const KEY = process.env.KEY || 'shared-key-123'
const URL = `${HUB}/_ws/${encodeURIComponent(ID)}?key=${encodeURIComponent(KEY)}`

function open(role) {
  const ws = new WebSocket(URL)
  const msgs = []
  const pending = []
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    msgs.push(m)
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].pred(m)) { pending[i].resolve(m); pending.splice(i, 1) }
    }
  })
  const waitFor = (pred, ms = 4000) => {
    const hit = msgs.find(pred)
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting (role ${role})`)), ms)
      pending.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m) } })
    })
  }
  const opened = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  const send = (o) => ws.send(JSON.stringify(o))
  return { ws, msgs, waitFor, send, opened, role }
}

const isT = (t) => (m) => m?.payload?.t === t

async function hello(c) {
  await c.opened
  c.send({ type: 'hello', key: KEY, role: c.role })
  const w = await c.waitFor(isT('welcome'))
  return w.payload.wsId
}

const checks = []
const check = (name, ok) => { checks.push({ name, ok }); console.log(`  ${ok ? '✅' : '❌'} ${name}`) }

async function main() {
  console.log(`[roundtrip] ${URL.replace(KEY, '***')}`)

  const worker = open('fast-router')
  const workerId = await hello(worker)
  check('worker registered as fast-router', !!workerId)

  const a = open('runtime'); const aId = await hello(a)
  const b = open('runtime'); const bId = await hello(b)
  check('runtime A registered', !!aId)
  check('runtime B registered', !!bId)
  check('A and B have distinct wsIds', aId && bId && aId !== bId)
  check('A was NOT evicted when B joined (multi-connection)', !a.msgs.find(isT('evicted')))

  // runtime A → the worker (role-routed to the single fast-router)
  a.send({ to: { type: 'fast-router' }, payload: { t: 'suggest', projectId: 'p', userId: 'uA', inputId: 'iA', seq: 1, text: 'hi' } })
  const got = await worker.waitFor(isT('suggest'))
  check('worker received A\'s suggest', !!got)
  check('DO stamped from.id = A', got?.from?.id === aId)
  check('DO stamped from.type = runtime', got?.from?.type === 'runtime')

  // worker replies to A by wsId — only A gets it
  worker.send({ to: { id: aId }, payload: { t: 'suggestions', seq: 1, items: [] } })
  const aReply = await a.waitFor(isT('suggestions'))
  check('A received the reply', aReply?.payload?.seq === 1)
  await new Promise(r => setTimeout(r, 300))   // give any mis-route a chance to arrive
  check('B did NOT receive A\'s reply (wsId isolation)', !b.msgs.find(isT('suggestions')))

  for (const c of [worker, a, b]) c.ws.close()
  const passed = checks.filter(c => c.ok).length
  console.log(`\n[roundtrip] ${passed}/${checks.length} checks passed`)
  process.exit(passed === checks.length ? 0 : 1)
}

main().catch((e) => { console.error('[roundtrip] FAILED:', e.message); process.exit(1) })
