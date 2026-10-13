// ── A ChatGPT login, held and renewed by the platform (docs/storage.md, "the vault") ───────────────────────────────
//
// ChatGPT refuses relayed requests, so an engine signs its own requests to it (the contract's route 'tunnel'): it needs
// the login itself. The login lives in the vault — one entry per login, each serving the project groups it is given to —
// and the PLATFORM renews it: every renewal invalidates the one before, so two engines renewing the same login would
// keep signing each other out. Renewals are made one at a time per login (GlobalDO), before the access token runs out;
// an engine is handed the current access token, never the refresh token, and never renews.
//
// A login is entered as `codex login` leaves it (~/.codex/auth.json) or as { access, refresh, accountId }.

export interface ChatGPTLogin { access: string; refresh: string; accountId?: string }

const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'   // the Codex CLI's, which the login was made with
/** Renewed when less than this is left: an access token lasts about ten days. */
export const RENEW_BEFORE_MS = 2 * 86_400_000

function claims(jwt: string): any {
  const p = jwt.split('.')[1]
  if (!p) return null
  try { const b = p.replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(atob(b + '='.repeat((4 - (b.length % 4)) % 4))) } catch { return null }
}
export const accountOf = (access: string): string | undefined => claims(access)?.['https://api.openai.com/auth']?.chatgpt_account_id
export const expiresOf = (access: string): number | undefined => { const e = claims(access)?.exp; return typeof e === 'number' ? e * 1000 : undefined }

/** A login from what was entered; null when it is not one (a bare token, an API key). */
export function parseLogin(value: string): ChatGPTLogin | null {
  if (!value.trim().startsWith('{')) return null
  try {
    const j = JSON.parse(value), t = j?.tokens ?? j
    const access = t?.access_token ?? t?.access, refresh = t?.refresh_token ?? t?.refresh
    if (typeof access !== 'string' || typeof refresh !== 'string' || !access || !refresh) return null
    return { access, refresh, accountId: t?.account_id ?? t?.accountId ?? accountOf(access) }
  } catch { return null }
}

/** One renewal. The answer carries a new refresh token: the one used is no good any more. */
export async function renewLogin(l: ChatGPTLogin, fetchImpl: typeof fetch = fetch): Promise<ChatGPTLogin> {
  const r = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: l.refresh, client_id: CLIENT_ID }) })
  const text = await r.text()
  if (!r.ok) throw new Error(`ChatGPT refused the renewal (${r.status}): ${text.slice(0, 200)}`)
  const j = JSON.parse(text)
  if (typeof j?.access_token !== 'string' || typeof j?.refresh_token !== 'string') throw new Error('ChatGPT\'s renewal answer had no tokens')
  return { access: j.access_token, refresh: j.refresh_token, accountId: accountOf(j.access_token) ?? l.accountId }
}
