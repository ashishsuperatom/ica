// The engine's own way into the datasource manager (docs/connectors-plan.md, step 1): its key, given to the engine and
// the manager by their launcher and never to a child. Whatever the engine runs FOR someone reads with a ticket instead
// (access.ts ticketFor).

/** The manager's key. */
export const MANAGER_KEY = process.env.SA_MANAGER_KEY ?? ''

/** A request to the manager, as the engine itself. */
export function asSystem(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string> | undefined ?? {}), 'x-sa-system': MANAGER_KEY } }
}
