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
// NO CROSS-PACKAGE IMPORT. This once read the proxy's contract for the list of box-side providers, which
// broke the deployable: the engine image copies vm/ and nothing else, so agent-proxy/ simply is not there.
// The engine needs one fact — which providers to ask for — and the proxy's answer carries the rest, including
// the environment variable the credential belongs in. One name here, everything else from the reply.
const BOX_SIDE = ['claude-code']

// The variable each box-side provider's client reads. The vault's reply carries this too and is authoritative;
// this is only so we can tell whether a credential is ALREADY present before asking for one.
const ENV_FALLBACK: Record<string, string> = { 'claude-code': 'CLAUDE_CODE_OAUTH_TOKEN' }

export interface Fetched { provider: string; envVar: string; keyId: string | null; expiresAt: number | null }

// ── FLEET BOX VS SOMEBODY'S LAPTOP ───────────────────────────────────────────────────────────────────────
// These used to be treated the same, and a failed fetch was a warning on both. That is right for a laptop —
// it has its own login, and an engine that refused to start because the control plane blinked would be worse
// than one that carries on. It is WRONG for a fleet box, which has no other way to authenticate: there the
// same warning scrolls past, the analyst spawns with no credential, warm-up reports it healthy because the
// TUI came up, and the box prints FULLY READY while being unable to answer anything. The failure surfaces
// hours later, at question time, looking like an expired token rather than a boot that did not finish.
//
// A box that was given a platform, a project and a key has DECLARED it expects its credentials from the
// vault. Not getting them is a broken box, and it should say so.
export const isFleetBox = (): boolean =>
  !!(process.env.SUPERATOM_PLATFORM && process.env.ICA_PROJECT && process.env.ICA_KEY)

/** Providers whose credential this box still lacks — nothing in the environment, nothing fetched. */
function stillMissing(): string[] {
  return BOX_SIDE.filter((p) => {
    const v = ENV_FALLBACK[p]
    return !v || !process.env[v]
  })
}

// ── THE GATE ─────────────────────────────────────────────────────────────────────────────────────────────
// A credential that arrives after the agent has started is a credential the agent never sees: it inherits
// this process's environment once, at spawn. Boot order already handles the warm-up path, but agents are ALSO
// spawned lazily on first use, and that path had no ordering at all — a question arriving during a retry
// would spawn a credential-less agent that then stays broken for its whole life.
//
// So anything about to spawn a box-side client waits here. On a laptop it resolves immediately (nothing is
// expected from the vault). On a fleet box it resolves as soon as the credential lands, or when the wait cap
// expires — never longer, because a hung boot is not better than a failed one, and the agent's own error is
// a clearer thing to read than a request that never returns.
let ready: Promise<void> | null = null
let markReady: (() => void) | null = null

function gate(): Promise<void> {
  if (!ready) ready = new Promise<void>((res) => { markReady = res })
  return ready
}

/** Wait until this box holds the credentials it is supposed to hold. Resolves at once when none are owed. */
export async function boxCredentialsReady(capMs = 30_000): Promise<void> {
  if (!isFleetBox() || stillMissing().length === 0) return
  await Promise.race([gate(), new Promise<void>((res) => setTimeout(res, capMs).unref?.())])
}

/** One attempt per provider. Returns what it managed to place in the environment. */
async function attempt(): Promise<Fetched[]> {
  const platform = process.env.SUPERATOM_PLATFORM
  const project = process.env.ICA_PROJECT
  const key = process.env.ICA_KEY
  if (!platform || !project || !key) return []

  const got: Fetched[] = []
  for (const name of BOX_SIDE) {
    // Something already in the environment WINS. A box deliberately configured with its own token, or a
    // developer's laptop with a login, must not be quietly overridden by the fleet's shared credential.
    const known = ENV_FALLBACK[name]
    if (known && process.env[known]) { console.log(`[ica] ${known} already set — leaving it alone`); continue }
    try {
      const r = await fetch(`https://proxy.${platform}/p/${encodeURIComponent(project)}/_key/${name}`,
        { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) })
      if (!r.ok) {
        const body = await r.text()
        console.warn(`[ica] no ${name} credential from the vault (${r.status}) — ${body.slice(0, 120)}`)
        continue
      }
      const b = await r.json() as any
      if (!b?.key) { console.warn(`[ica] vault answered for ${name} without a credential`); continue }
      const envVar: string | undefined = b.envVar ?? ENV_FALLBACK[name]
      if (!envVar) { console.warn(`[ica] vault did not say where ${name}'s credential belongs`); continue }
      if (process.env[envVar]) { console.log(`[ica] ${envVar} already set — leaving it alone`); continue }
      process.env[envVar] = b.key
      got.push({ provider: name, envVar, keyId: b.keyId ?? null, expiresAt: b.expiresAt ?? null })
      // The id and the expiry, never the value. Enough to answer "which credential is this box using, and how
      // long does it have" from a log, which is the question that matters when one lapses.
      const days = b.expiresAt ? Math.round((b.expiresAt - Date.now()) / 86_400_000) : null
      console.log(`[ica] ${envVar} ← vault (${name}/${b.keyId ?? '?'}${days !== null ? `, expires in ${days}d` : ''})`)
    } catch (e: any) {
      console.warn(`[ica] could not reach the vault for ${name} (${e?.message ?? e})`)
    }
  }
  return got
}

/** Keep trying, slowly, forever. A vault that is briefly unreachable must not cost the box until somebody
 *  notices and restarts it — the engine is up, the connector and datasource paths work, and the moment the
 *  credential lands the agents that were waiting on the gate proceed. Spaced out because the failure being
 *  retried is an outage, and hammering it helps nobody. */
function keepTrying(): void {
  let delay = 15_000
  const tick = async () => {
    if (stillMissing().length === 0) { markReady?.(); return }
    const got = await attempt()
    if (got.length > 0 || stillMissing().length === 0) {
      console.log('[ica] box credentials recovered — agents waiting on them may proceed')
      markReady?.()
      return
    }
    delay = Math.min(delay * 2, 5 * 60_000)
    setTimeout(tick, delay).unref?.()
  }
  setTimeout(tick, delay).unref?.()
}

/** Ask the proxy for every credential this box must hold locally, and put each where its client looks.
 *
 *  Returns what is still missing, so the caller can say so in the readiness banner rather than reporting a
 *  box as fully ready when its main agent cannot authenticate. */
export async function fetchBoxCredentials(): Promise<{ got: Fetched[]; missing: string[]; fleet: boolean }> {
  const fleet = isFleetBox()
  gate()   // created up front, so anything that starts waiting before the first attempt is still released

  // A few quick attempts before giving up on the boot path: the common failure is a two-second blip while the
  // network comes up around a freshly started container, and paying for that with a degraded box — or worse,
  // a box that looks fine — is a bad trade against three seconds of boot.
  let got: Fetched[] = []
  for (const wait of [0, 1_000, 3_000, 6_000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait))
    got = await attempt()
    if (stillMissing().length === 0) break
  }

  const missing = stillMissing()
  if (missing.length === 0) { markReady?.(); return { got, missing, fleet } }

  if (fleet) {
    // LOUD, and specific about what it means. This box has no other way to authenticate, so this is not a
    // warning to scroll past — it is the reason the next question will fail.
    console.error(`[ica] ✗ NO CREDENTIAL for ${missing.join(', ')} — this box expects them from the vault and did not get them.`)
    console.error('[ica]   claude-code cannot answer without one. Check the project is in a vault group that has an entry,')
    console.error('[ica]   and that ICA_KEY is this project\'s key. Retrying in the background.')
    keepTrying()
  } else {
    // A laptop. It has its own login; this is genuinely nothing to worry about.
    console.log(`[ica] no vault credential for ${missing.join(', ')} — using this machine's own login`)
    markReady?.()
  }
  return { got, missing, fleet }
}
