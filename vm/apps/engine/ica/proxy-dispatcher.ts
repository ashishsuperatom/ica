// ── SEND *ONLY* THE HOSTS THAT NEED IT THROUGH THE TUNNEL ────────────────────────────────────────────────
// Import ONCE, as early as possible, before anything can make a request.
//
// WHY THIS FILE HAS TO EXIST. Node's fetch IS undici, and undici ignores HTTP_PROXY / HTTPS_PROXY — a
// deliberate Node decision, and the opposite of every other client we drive. claude-code and codex are
// separate binaries that read those variables themselves, so a box with a proxy configured simply obeys it.
// pi runs INSIDE this process and would quietly keep talking to providers directly. The symptom is the worst
// kind: everything works, and one agent is silently bypassing the proxy nobody can see it skipping.
//
// AN ALLOWLIST, NOT A DENYLIST. undici only offers a GLOBAL dispatcher, so the obvious move is to point
// everything at the proxy and then exempt localhost with NO_PROXY. That is backwards: it captures every
// request the engine will ever make — the datasource manager, the hub, anything added later — and relies on
// remembering to exempt each one. Get it wrong and an internal call leaves the box, or dies against a tunnel
// whose allowlist refuses it.
//
// So this routes by DESTINATION. Only hosts we deliberately name go through the tunnel; everything else
// connects directly, exactly as it does today. The tunnel exists for one reason — the ChatGPT backend refuses
// any relayed request, so its traffic has to be carried without being touched — and that is the only traffic
// it should carry.
//
//   SUPERATOM_TUNNEL=http://<projectId>:<projectKey>@tunnel.superatom.site:443
//   SUPERATOM_TUNNEL_HOSTS=chatgpt.com,auth.openai.com        (optional; this is the default)
//
// Unset ⇒ nothing is installed and the process behaves exactly as it does now.

import { setGlobalDispatcher, getGlobalDispatcher, ProxyAgent, Dispatcher } from 'undici'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// LOAD THE ENV OURSELVES. This module must be imported before anything can fetch, and imports run before any
// statement in engine.ts — including its own loadEnvFile. So a dispatcher that read process.env directly saw
// nothing and silently installed nothing, which looks exactly like working correctly.
try { process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), '..', '.env')) } catch { /* fine: pm2 supplies the environment */ }

// ONE variable, and the project credentials the engine already holds. proxy.<platform> and tunnel.<platform>
// follow from the domain, so moving the platform is one edit rather than three that can disagree — and there
// is no way to point the two halves at different places by accident.
const PLATFORM = process.env.SUPERATOM_PLATFORM
const PROJECT = process.env.ICA_PROJECT
const KEY = process.env.ICA_KEY
const tunnel = PLATFORM && PROJECT && KEY
  ? `http://${PROJECT}:${KEY}@tunnel.${PLATFORM}:443`
  : undefined

// The ChatGPT backend and its token endpoint, and nothing else. Fixed rather than configurable because it is a
// FACT about that backend — it refuses any relayed request — not a preference someone should be tuning. Every
// other provider is a public API the Worker can reverse-proxy, which is cheaper and lets us count tokens.
const HOSTS = ['chatgpt.com', 'auth.openai.com']

if (tunnel) {
  const direct = getGlobalDispatcher()
  const viaTunnel = new ProxyAgent(tunnel)
  const tunnelled = (host: string) => HOSTS.some((h) => host === h || host.endsWith('.' + h))

  // A dispatcher is just "given a request, connect it". Ours reads the origin and picks one of two real
  // dispatchers — no interception, no rewriting, nothing to go wrong beyond choosing the wrong door.
  class SplitDispatcher extends Dispatcher {
    override dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
      const host = (() => {
        try { return new URL(String(opts.origin)).hostname.toLowerCase() } catch { return '' }
      })()
      return (tunnelled(host) ? viaTunnel : direct).dispatch(opts, handler)
    }
    override async close() { await viaTunnel.close(); await (direct as any).close?.() }
    override async destroy() { await viaTunnel.destroy(); await (direct as any).destroy?.() }
  }

  setGlobalDispatcher(new SplitDispatcher())
  // Credentials live in that URL, so only its shape is logged: enough to confirm the wiring, never the key.
  console.log(`[ica] tunnelling ${HOSTS.join(', ')} via ${tunnel.replace(/\/\/[^@]*@/, '//<project>:<key>@')} — everything else direct`)
}
