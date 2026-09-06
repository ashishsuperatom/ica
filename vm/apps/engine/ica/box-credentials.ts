// ── CREDENTIALS THIS BOX MUST HOLD ITSELF ────────────────────────────────────────────────────────────────
// Fetched at boot from the vault, so a freshly spawned engine needs nothing pasted into it.
//
// Most providers never reach this file: a key that can be attached in flight belongs at the proxy, where it
// is chosen per project and never touches the machine. But some clients insist on a LOCAL credential —
// claude-code refuses to make any request at all without one, printing "Not logged in" while not a single
// byte leaves for a proxy to intercept. For those, the credential has to be here, and the only question is
// how it arrives: pasted into every box by hand, or fetched from the one place that holds it.
//
// This is the last credential that was still being copied from machine to machine.
//
// WHAT IT DOES NOT DO. It never writes the credential to disk. It sets an environment variable in this
// process, which the agent inherits when it is spawned — so the token lives as long as the process and
// vanishes with it. A box that is stopped keeps nothing.
//
// FAILING TO FETCH IS NOT FATAL. A machine may already have a working login (a developer's laptop does), and
// an engine that refused to start because the control plane was briefly unreachable would be worse than one
// that carries on with what it has. It says what happened either way, because "which credential am I using"
// is the question that costs hours when nobody can answer it.

import { UPSTREAMS } from '../../../../agent-proxy/contract.mjs'

interface Fetched { provider: string; envVar: string; keyId: string | null; expiresAt: number | null }

/** Ask the proxy for every credential this box must hold locally, and put each where its client looks. */
export async function fetchBoxCredentials(): Promise<Fetched[]> {
  const platform = process.env.SUPERATOM_PLATFORM
  const project = process.env.ICA_PROJECT
  const key = process.env.ICA_KEY
  if (!platform || !project || !key) return []

  const boxSide = Object.entries(UPSTREAMS as Record<string, any>)
    .filter(([, u]) => u.boxOnly && u.envVar)
    .map(([name, u]) => ({ name, envVar: u.envVar as string }))

  const got: Fetched[] = []
  for (const { name, envVar } of boxSide) {
    // Something already in the environment WINS. A box deliberately configured with its own token, or a
    // developer's laptop with a login, must not be quietly overridden by the fleet's shared credential.
    if (process.env[envVar]) {
      console.log(`[ica] ${envVar} already set — leaving it alone`)
      continue
    }
    try {
      const r = await fetch(`https://proxy.${platform}/p/${encodeURIComponent(project)}/_key/${name}`,
        { headers: { authorization: `Bearer ${key}` } })
      if (!r.ok) {
        const body = await r.text()
        console.warn(`[ica] no ${name} credential from the vault (${r.status}) — ${body.slice(0, 120)}`)
        continue
      }
      const b = await r.json() as any
      if (!b?.key) { console.warn(`[ica] vault answered for ${name} without a credential`); continue }
      process.env[envVar] = b.key
      got.push({ provider: name, envVar, keyId: b.keyId ?? null, expiresAt: b.expiresAt ?? null })
      // The id and the expiry, never the value. Enough to answer "which credential is this box using, and how
      // long does it have" from a log, which is the question that matters when one lapses.
      const days = b.expiresAt ? Math.round((b.expiresAt - Date.now()) / 86_400_000) : null
      console.log(`[ica] ${envVar} ← vault (${name}/${b.keyId ?? '?'}${days !== null ? `, expires in ${days}d` : ''})`)
    } catch (e: any) {
      console.warn(`[ica] could not reach the vault for ${name} (${e?.message ?? e}) — continuing with whatever this box has`)
    }
  }
  return got
}
