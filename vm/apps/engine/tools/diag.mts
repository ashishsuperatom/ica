// ── WHY DID THE AGENT FAIL? ──────────────────────────────────────────────────────────────────────────────
//
// A failed model call now has six candidate layers: the box's environment, the undici dispatcher, pi's
// provider chain, the Worker or the tunnel, the vault's group assignment, and the upstream itself. Telling
// them apart used to mean SSH-ing into the box and reading logs — which is the thing the proxy was built to
// stop anyone having to do.
//
// This prints one line per provider: its route, whether this box can actually get to it, and what is wrong
// when it cannot. Read-only and cheap by default — it spends no tokens and asks no model anything.
//
//   docker exec <container> pnpm exec tsx apps/engine/tools/diag.mts
//   docker exec <container> pnpm exec tsx apps/engine/tools/diag.mts --live   (also runs one real turn)
//
// Exits non-zero if anything this box depends on is broken, so it is usable as a health check.

import './../ica/proxy-dispatcher.js'   // FIRST: installs the split dispatcher, so our own probes take the same routes the agents do
import { PROVIDERS, providersOn, hostsOn, allHosts, disabledReason } from '../../../packages/agent-contract/contract.mjs'
import { providersInUse } from '../ica/providers.js'

const PLATFORM = process.env.SUPERATOM_PLATFORM
const PROJECT = process.env.ICA_PROJECT
const KEY = process.env.ICA_KEY
const LIVE = process.argv.includes('--live')

type Row = { provider: string; route: string; state: 'ok' | 'broken' | 'unknown' | 'unused' | 'off'; detail: string }
const rows: Row[] = []
const inUse = new Set<string>(providersInUse())
const ms = (t: number) => `${Date.now() - t}ms`

console.log(`box       platform=${PLATFORM ?? '(none)'} project=${PROJECT ?? '(none)'} key=${KEY ? 'set' : 'MISSING'}`)
console.log(`tunnel    ${hostsOn('tunnel').join(', ')} → tunnel.${PLATFORM ?? '?'}`)
console.log(`allowed   ${allHosts().join(', ')}`)
console.log('')

if (!PLATFORM || !PROJECT || !KEY) {
  console.log('This box is not configured for the proxy (SUPERATOM_PLATFORM / ICA_PROJECT / ICA_KEY).')
  console.log('It will use whatever credentials are on the machine itself. Nothing further to check.')
  process.exit(0)
}

// ── BOX-SIDE: is the credential there, and how long does it have? ────────────────────────────────────────
for (const name of providersOn('box')) {
  const t = Date.now()
  const envVar = PROVIDERS[name].envVar!
  try {
    const r = await fetch(`https://proxy.${PLATFORM}/p/${PROJECT}/_key/${name}`,
      { headers: { authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(15_000) })
    const b: any = r.ok ? await r.json() : null
    if (!r.ok) rows.push({ provider: name, route: 'box', state: 'broken', detail: `vault said ${r.status} — check the project's group has an entry for ${name}` })
    else if (!b?.key) rows.push({ provider: name, route: 'box', state: 'broken', detail: 'vault replied without a credential' })
    else {
      const days = b.expiresAt ? Math.round((b.expiresAt - Date.now()) / 86_400_000) : null
      // WHAT IS BEING TESTED is that the vault serves this box a credential — not whether THIS process holds
      // it. A diagnostic run standalone never will (the engine sets it in its own memory at boot, and that
      // memory is not shared), so judging on it would report a healthy box as broken every single time.
      // The engine's own env is reported as a note, because it is worth seeing, not as the verdict.
      const held = process.env[envVar] ? ` · ${envVar} set here` : ''
      rows.push({ provider: name, route: 'box', state: 'ok',
                  detail: `vault serves ${b.keyId ?? '?'}${days !== null ? `, ${days}d left` : ''}${held} · ${ms(t)}` })
    }
  } catch (e: any) {
    rows.push({ provider: name, route: 'box', state: 'broken', detail: `cannot reach the vault — ${e?.message ?? e}` })
  }
}

// ── RELAY: does the Worker answer for this project, and does it hold a key? ──────────────────────────────
// _whoami reports what the proxy would do WITHOUT spending anything, which is the point: a diagnostic that
// costs tokens is one people stop running.
{
  const t = Date.now()
  let whoami: any = null
  try {
    const r = await fetch(`https://proxy.${PLATFORM}/p/${PROJECT}/_whoami`,
      { headers: { authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(15_000) })
    whoami = r.ok ? await r.json() : { error: `HTTP ${r.status}` }
  } catch (e: any) { whoami = { error: String(e?.message ?? e) } }

  if (whoami?.group) console.log(`group     ${whoami.group}\n`)
  for (const name of providersOn('relay')) {
    if (whoami?.error) { rows.push({ provider: name, route: 'relay', state: 'broken', detail: `proxy unreachable — ${whoami.error}` }); continue }
    const has = whoami?.providers?.[name]?.available
    // A DECISION, not a fault. Turned off in the contract means both proxies refuse it — say so plainly
    // rather than reporting the absence of a key as a problem.
    const off = disabledReason(name)
    if (off) { rows.push({ provider: name, route: 'relay', state: 'off', detail: `disabled — ${off}` }); continue }
    // And a provider nothing routes to is not a fault either. It sits in the contract because the proxy knows
    // how to relay it, not because anything here asks for it — a permanent ✗ on a healthy box is how a check
    // stops being read.
    if (!inUse.has(name)) {
      rows.push({ provider: name, route: 'relay', state: 'unused',
                  detail: has ? 'a key exists, but no model on this box routes here' : 'no model on this box routes here' })
      continue
    }
    rows.push({ provider: name, route: 'relay',
                state: has ? 'ok' : 'broken',
                detail: has ? `vault has a key for group "${whoami.group}" · ${ms(t)}`
                            : `NO key in the vault for group "${whoami.group}" — add one, or move this project to a group that has one` })
  }
}

// ── TUNNEL: will a CONNECT socket open to the backend? ───────────────────────────────────────────────────
// Any HTTP answer at all proves the tunnel carried the bytes — the backend refusing us is fine and expected,
// since we send no credential. What we are testing is the socket, not the authorisation.
for (const name of providersOn('tunnel')) {
  const host = (PROVIDERS[name].hosts ?? [])[0]
  const t = Date.now()
  try {
    const r = await fetch(`https://${host}/`, { method: 'HEAD', signal: AbortSignal.timeout(20_000) })
    rows.push({ provider: name, route: 'tunnel', state: 'ok', detail: `CONNECT to ${host} carried (HTTP ${r.status}) · ${ms(t)}` })
  } catch (e: any) {
    rows.push({ provider: name, route: 'tunnel', state: 'broken', detail: `no socket to ${host} — ${e?.message ?? e} (is the EC2 tunnel up?)` })
  }
}

// ── OPTIONAL: one real turn, because a route that works is not yet an agent that answers ─────────────────
if (LIVE) {
  const { createSession } = await import('../ica/index.js')
  const t = Date.now()
  const s = createSession('claude-code-pty', { cwd: process.cwd(), model: 'claude-haiku-4-5-20251001' })
  try {
    const r = await s.run('Reply with exactly: OK')
    const text = (r?.lastLines ?? '').trim()
    const bad = /not logged in|please run \/login|login expired/i.test(text)
    rows.push({ provider: 'claude-code (live turn)', route: 'box', state: bad || !text ? 'broken' : 'ok',
                detail: bad ? 'the agent reports it is not logged in' : text ? `answered in ${ms(t)}` : 'no reply' })
  } catch (e: any) {
    rows.push({ provider: 'claude-code (live turn)', route: 'box', state: 'broken', detail: String(e?.message ?? e).slice(0, 100) })
  } finally { try { s.stop() } catch { /* never started */ } }
}

// ── THE REPORT ───────────────────────────────────────────────────────────────────────────────────────────
const mark = { ok: '✓', broken: '✗', unknown: '?', unused: '–', off: '⊘' }
const w = Math.max(...rows.map(r => r.provider.length), 8)
console.log('PROVIDER'.padEnd(w) + '  ROUTE   STATE  DETAIL')
console.log('─'.repeat(w + 8 + 7 + 40))
for (const r of rows) console.log(`${r.provider.padEnd(w)}  ${r.route.padEnd(6)}  ${mark[r.state].padEnd(5)}  ${r.detail}`)

const broken = rows.filter(r => r.state === 'broken')
console.log('')
if (broken.length === 0) console.log(`✓ every provider this box uses is reachable.  (⊘ = disabled, – = unused here)`)
else {
  console.log(`✗ ${broken.length} broken: ${broken.map(b => b.provider).join(', ')}`)
  console.log('  Read the DETAIL column — it names the layer, so there is nothing to guess at.')
}
process.exit(broken.length === 0 ? 0 : 1)
