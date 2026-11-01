// THE PROJECT'S HTTP API — WHAT ANYONE IN THE PROJECT READS (project.view). What the platform keeps is read over HTTP from
// the project's Durable Object: the engine is never asked, so these screens work while it is down; the WebSocket is only
// for what streams from the engine (asking an agent, its narration, its answer). What only admins change: api/admin.ts.
// The server side: one handler per area in the ProjectDO (intentsApi), one capability line each in permissions.ts.
import { projectCall, type Http } from './http'

export function projectApi(http: Http, projectId: string) {
  const call = projectCall(http, projectId)
  return {
    /** The intent graph (docs/intent-graph.md). */
    intents: {
      graph: () => call('GET', '/intents'),
      node: (id: string) => call('GET', `/intents/${encodeURIComponent(id)}`),
    },
    /** A session's specialised agents, each saying whether the caller may use it. */
    sessionAgents: {
      list: () => call('GET', '/session-agents'),
    },
  }
}
export type ProjectApi = ReturnType<typeof projectApi>
