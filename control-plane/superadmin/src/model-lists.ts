// ── WHICH MODELS AN ACCOUNT SERVES, AND A PROFILE CHECKED AGAINST THEM ───────────────────────────────────
// A profile names a harness, an account (provider) and a model for each agent. It is checked here, when it is
// saved, so a profile that cannot run is refused with a sentence instead of reaching an engine as an agent that
// will not start. The model is TRANSLATED to the id the chosen account lists (contract: modelOn), so switching an
// agent to another account never means retyping its model.
//
// The lists: OpenRouter publishes its own (public, no key), read live and kept for an hour; every other account's
// is the platform catalogue.
import { modelOn, nearModels, harnessCanUse, isDisabled, disabledReason, UPSTREAMS } from '../../../vm/packages/agent-contract/contract.mjs'

const LIVE_TTL = 60 * 60 * 1000
let openrouter: { at: number; ids: string[] } | null = null

/** OpenRouter's model ids, plain ones only (no `~alias`, no `:variant`). Kept for an hour; an old list is used
 *  if a refresh fails, and an empty one only when none was ever read. */
export async function openrouterModels(): Promise<string[]> {
  if (openrouter && Date.now() - openrouter.at < LIVE_TTL) return openrouter.ids
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const ids = ((await r.json() as any)?.data ?? []).map((m: any) => String(m?.id ?? ''))
      .filter((i: string) => i && !i.startsWith('~') && !i.includes(':'))
    if (ids.length) openrouter = { at: Date.now(), ids }
  } catch (e) { console.warn(`[models] could not read OpenRouter's list: ${(e as Error).message}`) }
  return openrouter?.ids ?? []
}

/** Every account's list: the catalogue, with OpenRouter's own list in place of its entry. */
export async function modelLists(catalogue: Record<string, string[]>): Promise<Record<string, string[]>> {
  const live = await openrouterModels()
  return { ...catalogue, ...(live.length ? { openrouter: live } : {}) }
}

/** The profile with every agent's model in its account's own spelling, or the reasons it cannot run. Agents left
 *  incomplete keep the engine default and are not checked. */
export function checkProfile(profile: any, lists: Record<string, string[]>): { profile: any; problems: string[] } {
  const problems: string[] = []
  const agents: Record<string, any> = {}
  for (const [name, a] of Object.entries((profile?.agents ?? {}) as Record<string, any>)) {
    if (!a?.harness || !a?.provider || !a?.model) { agents[name] = a; continue }
    if (!(a.provider in UPSTREAMS)) { problems.push(`${name}: there is no account named ${a.provider}`); continue }
    if (isDisabled(a.provider)) { problems.push(`${name}: ${a.provider} is turned off (${disabledReason(a.provider)})`); continue }
    if (!harnessCanUse(a.harness, a.provider)) { problems.push(`${name}: ${a.harness} cannot use ${a.provider}`); continue }
    const list = lists[a.provider] ?? []
    const model = modelOn(a.model, list)
    if (!model) {
      const near = nearModels(a.model, list)
      problems.push(`${name}: ${a.provider} does not serve ${a.model}${near.length ? ` — did you mean ${near.join(', ')}?` : list.length ? '' : ' (its model list is empty)'}`)
      continue
    }
    agents[name] = { ...a, model }
  }
  return { profile: { ...profile, agents }, problems }
}
