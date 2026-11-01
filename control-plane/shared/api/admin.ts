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
    /** The agents intent nodes are answered by: the project's own, made or removed. */
    sessionAgents: {
      save: (spec: unknown) => call('POST', '/session-agents', spec),
      remove: (name: string) => call('DELETE', `/session-agents/${encodeURIComponent(name)}`),
    },
  }
}
export type ProjectAdminApi = ReturnType<typeof projectAdminApi>

// WHAT ONLY A CURATOR DOES (project.curate; the platform checks it on every call): one person's way of answering an intent
// approved as the project's. Given to a screen only for someone who holds it.
export function projectCuratorApi(http: Http, projectId: string) {
  const call = projectCall(http, projectId)
  return {
    intents: {
      approve: (id: string, owner: string, version: number, why: string) => call('POST', `/intents/${encodeURIComponent(id)}/approve`, { owner, version, why }),
    },
  }
}
export type ProjectCuratorApi = ReturnType<typeof projectCuratorApi>
