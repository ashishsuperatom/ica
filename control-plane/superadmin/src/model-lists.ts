// ── WHICH MODELS AN ACCOUNT SERVES, AND A PROFILE CHECKED AGAINST THEM ───────────────────────────────────
// A profile names a harness, an account (provider) and a model for each agent. It is checked here, when it is
// saved, so a profile that cannot run is refused with a sentence instead of reaching an engine as an agent that
// will not start. The model is TRANSLATED to the id the chosen account lists (contract: modelOn), so switching an
// agent to another account never means retyping its model.
//
// The lists: the platform's model list (control-plane/shared/models.json) — nothing is read from a provider online.
import { modelOn, nearModels, harnessCanUse, isDisabled, disabledReason, UPSTREAMS } from '../../../vm/packages/agent-contract/contract.mjs'
import { modelNames } from '../../shared/models.js'

/** Every account's list of models: the platform's. */
export const modelLists = (): Record<string, string[]> => modelNames()

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
