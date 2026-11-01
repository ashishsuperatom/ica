// A signed-in fetch for the project's HTTP API (api/user.ts, api/admin.ts): each app gives its own, rooted at /api — the
// console's caches reads; the user UI's carries the person's token.

/** A signed-in fetch, rooted at /api. */
export type Http = (path: string, init?: RequestInit) => Promise<Response>

/** A fetch with the person's token (the user UI's): JSON in and out, the session cookie too. */
export const bearerHttp = (token: string | null | undefined): Http => (path, init = {}) => fetch(`/api${path}`, {
  credentials: 'include', ...init,
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...((init.headers as Record<string, string>) ?? {}) },
})

/** One call on a project: the JSON the platform answered — `{ error }` when refused. */
export const projectCall = (http: Http, projectId: string) => async (method: string, path: string, body?: unknown) =>
  (await http(`/projects/${encodeURIComponent(projectId)}${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })).json()
