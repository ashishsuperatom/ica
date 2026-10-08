// The platform's model list (models.json, changed with `pnpm models add|remove`): the only models agents run, each account's.
// A model pi runs carries pi's full description (its API, endpoint, context, costs); one its own CLI runs (claude-code) only its
// name. A profile is checked against it when it is saved (model-lists.ts). Engines get it from their project:
// their hello names the hash they hold, and the welcome carries the list when it differs. Nothing is fetched online.

import MODELS from './models.json'

export interface ModelList { hash: string; providers: Record<string, { id: string; name?: string; api: string; [k: string]: unknown }[]> }
export const PLATFORM_MODELS = MODELS as unknown as ModelList

/** Every provider's model names, as a profile is checked against them and a screen offers them. */
export const modelNames = (): Record<string, string[]> => Object.fromEntries(Object.entries(PLATFORM_MODELS.providers).map(([p, ms]) => [p, ms.map((m) => m.id)]))
