// ── THE CHATGPT LOGIN, from the platform's vault, in memory (control-plane/superadmin/src/proxy/chatgpt-login.ts) ──
//
// ChatGPT refuses relayed requests, so pi signs its own requests to it and needs the login itself. On a box that belongs
// to the platform the login comes from the vault — the one chosen for this project's group — and is held in memory only.
// The PLATFORM renews it, one renewal at a time per login, because each renewal invalidates the one before: this engine
// never renews. When pi finds the token near its end and goes to renew it, it is asked for again instead, and the
// platform hands over the renewed one.
//
// Only where the vault has no login for this project does the machine's own `codex login` serve (a developer's laptop,
// a box signed in by hand) — as for every credential the vault holds (box-credentials.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isFleetBox } from './box-credentials.js'

const CODEX = 'openai-codex'
export interface VaultLogin { access: string; accountId: string | null; expiresAt: number | null; keyId: string }

let held: VaultLogin | null = null
/** None in the vault for this project: the machine's own login serves, and the vault is asked again later. */
let noneUntil = 0

/** The current login from the vault — the one held while it has more than six hours left, else asked for again (the
 *  platform renews it first when it is due). null: the vault has none for this project. */
export async function vaultChatGPTLogin(fresh = false): Promise<VaultLogin | null> {
  if (!isFleetBox()) return null
  if (!fresh && held && (!held.expiresAt || held.expiresAt - Date.now() > 6 * 3_600_000)) return held
  if (!fresh && Date.now() < noneUntil) return null
  const platform = process.env.SUPERATOM_PLATFORM!, project = process.env.ICA_PROJECT!
  const r = await fetch(`https://proxy.${platform}/p/${encodeURIComponent(project)}/_key/${CODEX}`,
    { headers: { authorization: `Bearer ${process.env.SA_MODEL_KEY}` }, signal: AbortSignal.timeout(20_000) })
  const b = await r.json().catch(() => null) as any
  if (r.status === 503 && /no credential in the vault/.test(b?.error ?? '')) { noneUntil = Date.now() + 10 * 60_000; return null }
  if (!r.ok || !b?.key) throw new Error(`the platform gave no ChatGPT login (${r.status}): ${b?.error ?? 'no answer'}`)
  if (!b.login) throw new Error(`the vault's ${CODEX} entry ${b.keyId} is a bare token, not a login the platform can renew — replace it with a ChatGPT login (platform console → Credentials)`)
  const fromVault = held?.keyId !== b.keyId || held?.access !== b.key
  held = { access: b.key, accountId: b.accountId ?? null, expiresAt: b.expiresAt ?? null, keyId: b.keyId }
  if (fromVault) console.log(`[ica] ChatGPT login ← vault (${CODEX}/${b.keyId}${held.expiresAt ? `, good for ${Math.round((held.expiresAt - Date.now()) / 3_600_000)}h` : ''})`)
  return held
}

/** As pi holds a login. Its refresh token is the platform's and never leaves it: pi "renewing" asks the vault again. */
const asPi = (l: VaultLogin) => ({ type: 'oauth' as const, access: l.access, refresh: 'held-by-the-platform', expires: l.expiresAt ?? Date.now() + 3_600_000, ...(l.accountId ? { accountId: l.accountId } : {}) })

/** pi's own credentials file (a laptop's logins), read and written whole — for everything the vault does not answer. */
function fileStore(path: string) {
  const all = (): Record<string, any> => { try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {} } catch { return {} } }
  let chain: Promise<unknown> = Promise.resolve()
  return {
    read: async (p: string) => all()[p],
    list: async () => Object.entries(all()).map(([providerId, c]) => ({ providerId, type: c?.type ?? 'api_key' })),
    modify: (p: string, fn: (c: any) => Promise<any>) => {
      const run = chain.then(async () => {
        const cur = all(), next = await fn(cur[p])
        if (next === undefined) return cur[p]
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, JSON.stringify({ ...cur, [p]: next }, null, 2), { mode: 0o600 })
        return next
      })
      chain = run.catch(() => undefined)
      return run
    },
    delete: async (p: string) => { const cur = all(); if (!(p in cur)) return; delete cur[p]; writeFileSync(path, JSON.stringify(cur, null, 2), { mode: 0o600 }) },
  }
}

/** pi's credential store: the ChatGPT login from the vault where it has one for this project; everything else — and
 *  the ChatGPT login where the vault has none — from pi's own file. */
export function vaultCredentialStore(authPath: string) {
  const file = fileStore(authPath)
  return {
    async read(p: string) {
      if (p === CODEX) { const l = await vaultChatGPTLogin(); if (l) return asPi(l) }
      return file.read(p)
    },
    async list() {
      const rest = (await file.list()).filter((x) => x.providerId !== CODEX)
      const codex = (await vaultChatGPTLogin().catch(() => null)) || (await file.read(CODEX)) ? [{ providerId: CODEX, type: 'oauth' }] : []
      return [...rest, ...codex]
    },
    async modify(p: string, fn: (c: any) => Promise<any>) {
      // Renewing the vault's login is the platform's: ask for the current one instead of renewing it here.
      if (p === CODEX) { const l = await vaultChatGPTLogin(true); if (l) return asPi(l) }
      return file.modify(p, fn)
    },
    async delete(p: string) { return file.delete(p) },
  }
}
