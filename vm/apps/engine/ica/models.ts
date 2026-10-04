// ── THE MODEL IN THE ACCOUNT'S OWN SPELLING ──────────────────────────────────────────────────────────────
// An agent's profile names its model once; the account it runs through decides how that name is spelled
// (`claude-haiku-4-5` to the Claude Code subscription, `anthropic/claude-haiku-4.5` to OpenRouter). Profiles are
// translated when they are saved (control plane, model-lists.ts); this does the same at the harness for anything
// that reached the engine another way — its default profile, a setting — so no harness is ever handed a name its
// account does not know.
//
// OpenRouter publishes its list (public, no key); it is read once an hour. Other accounts are taken as given.
import { modelOn, nearModels } from '../../../packages/agent-contract/contract.mjs'

const TTL = 60 * 60 * 1000
let openrouter: { at: number; ids: string[] } | null = null

async function openrouterModels(): Promise<string[]> {
  if (openrouter && Date.now() - openrouter.at < TTL) return openrouter.ids
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(10_000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const ids = ((await r.json() as any)?.data ?? []).map((m: any) => String(m?.id ?? ''))
      .filter((i: string) => i && !i.startsWith('~') && !i.includes(':'))
    if (ids.length) openrouter = { at: Date.now(), ids }
  } catch (e) { console.warn(`[ica:models] could not read OpenRouter's list: ${(e as Error).message}`) }
  return openrouter?.ids ?? []
}

/** `model` as `provider` spells it. Throws, naming the nearest, when the account's list does not have it; passes
 *  the name through unchanged when the list cannot be read (the account then answers for itself). */
export async function modelFor(provider: string | undefined, model: string): Promise<string> {
  if (provider !== 'openrouter') return model
  const list = await openrouterModels()
  if (!list.length) return model
  const same = modelOn(model, list)
  if (same) return same
  const near = nearModels(model, list)
  throw new Error(`openrouter does not serve ${model}${near.length ? ` — did you mean ${near.join(', ')}?` : ''}`)
}
