// THE PROJECT'S HTTP API — WHAT ONLY WHO RUNS THE PROJECT CHANGES (project.manage; the platform checks it on every call).
// Given to a screen only for someone who holds it. What anyone reads: api/user.ts.
import { projectCall, type Http } from './http'

export function projectAdminApi(http: Http, projectId: string) {
  const call = projectCall(http, projectId)
  return {
    /** An intent node changed by a person: a new version. */
    intents: {
      write: (id: string, body: unknown, why: string) => call('PUT', `/intents/${encodeURIComponent(id)}`, { body, why }),
    },
    /** The project's own specialised agents, made or removed. */
    sessionAgents: {
      save: (spec: unknown) => call('POST', '/session-agents', spec),
      remove: (name: string) => call('DELETE', `/session-agents/${encodeURIComponent(name)}`),
    },
  }
}
export type ProjectAdminApi = ReturnType<typeof projectAdminApi>
