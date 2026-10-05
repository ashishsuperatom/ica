// GitHub: the repositories the token reaches, their issues and pull requests; opening an issue.
import { defineConnector, json, pages, nextLink, type ConnectorContext } from '../../src/sdk'

const API = 'https://api.github.com'
const H = { 'x-github-api-version': '2022-11-28' }
const repoRow = (r: any) => ({ full_name: r.full_name, name: r.name, owner: r.owner?.login, private: r.private, description: r.description, language: r.language, stars: r.stargazers_count, open_issues: r.open_issues_count, updated_at: r.updated_at, url: r.html_url })
const issueRow = (i: any) => ({ number: i.number, title: i.title, state: i.state, author: i.user?.login, assignees: (i.assignees ?? []).map((a: any) => a.login).join(', '), labels: (i.labels ?? []).map((l: any) => l.name).join(', '), comments: i.comments, created_at: i.created_at, updated_at: i.updated_at, closed_at: i.closed_at, url: i.html_url })
const repoOf = (req: { filters?: Record<string, unknown> }) => { const r = String(req.filters?.repo ?? ''); if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error('name the repository as owner/name (filter: repo)'); return r }
const perPage = (limit: number) => Math.min(100, Math.max(1, limit))
const get = (ctx: ConnectorContext, url: string) => json(ctx, url, { headers: H })

export default defineConnector({
  async test(ctx) {
    const { data } = await get(ctx, `${API}/user`)
    return { ok: true, message: `connected as ${data.login}` }
  },
  entities: [
    { name: 'repositories', label: 'Repositories', description: 'The repositories the token reaches (or the owner\'s).', fields: [{ name: 'full_name', type: 'string', key: true }, { name: 'name', type: 'string' }, { name: 'owner', type: 'string' }, { name: 'private', type: 'boolean' }, { name: 'description', type: 'string' }, { name: 'language', type: 'string' }, { name: 'stars', type: 'integer' }, { name: 'open_issues', type: 'integer' }, { name: 'updated_at', type: 'timestamp' }, { name: 'url', type: 'string' }], filters: ['owner'] },
    { name: 'issues', label: 'Issues', description: 'A repository\'s issues (not pull requests).', fields: [{ name: 'number', type: 'integer', key: true }, { name: 'title', type: 'string' }, { name: 'state', type: 'string' }, { name: 'author', type: 'string' }, { name: 'assignees', type: 'string' }, { name: 'labels', type: 'string' }, { name: 'comments', type: 'integer' }, { name: 'created_at', type: 'timestamp' }, { name: 'updated_at', type: 'timestamp' }, { name: 'closed_at', type: 'timestamp' }, { name: 'url', type: 'string' }], filters: ['repo', 'state', 'labels'], cursorField: 'updated_at' },
    { name: 'pull_requests', label: 'Pull requests', description: 'A repository\'s pull requests.', fields: [{ name: 'number', type: 'integer', key: true }, { name: 'title', type: 'string' }, { name: 'state', type: 'string' }, { name: 'author', type: 'string' }, { name: 'draft', type: 'boolean' }, { name: 'created_at', type: 'timestamp' }, { name: 'updated_at', type: 'timestamp' }, { name: 'merged_at', type: 'timestamp' }, { name: 'url', type: 'string' }], filters: ['repo', 'state'] },
  ],
  actions: [
    { name: 'open_issue', label: 'Open an issue', description: 'Open an issue in a repository.', effect: 'write', confirm: true,
      input: [{ name: 'repo', type: 'string', required: true, description: 'owner/name' }, { name: 'title', type: 'string', required: true }, { name: 'body', type: 'string' }] },
  ],
  read: {
    async repositories(ctx, req) {
      const owner = String(req.filters?.owner ?? ctx.settings.owner ?? '')
      const first = owner ? `${API}/users/${encodeURIComponent(owner)}/repos?per_page=${perPage(req.limit!)}&sort=updated` : `${API}/user/repos?per_page=${perPage(req.limit!)}&sort=updated`
      return pages(ctx, req.cursor ?? first, req.limit!, (data, headers) => ({ rows: (data ?? []).map(repoRow), next: nextLink(headers) }))
    },
    async issues(ctx, req) {
      const q = new URLSearchParams({ per_page: String(perPage(req.limit!)), state: String(req.filters?.state ?? 'open'), sort: 'updated', direction: 'desc', ...(req.filters?.labels ? { labels: String(req.filters.labels) } : {}), ...(req.since ? { since: req.since } : {}) })
      return pages(ctx, req.cursor ?? `${API}/repos/${repoOf(req)}/issues?${q}`, req.limit!, (data, headers) => ({ rows: (data ?? []).filter((i: any) => !i.pull_request).map(issueRow), next: nextLink(headers) }))
    },
    async pull_requests(ctx, req) {
      const q = new URLSearchParams({ per_page: String(perPage(req.limit!)), state: String(req.filters?.state ?? 'open'), sort: 'updated', direction: 'desc' })
      return pages(ctx, req.cursor ?? `${API}/repos/${repoOf(req)}/pulls?${q}`, req.limit!, (data, headers) => ({ rows: (data ?? []).map((p: any) => ({ number: p.number, title: p.title, state: p.state, author: p.user?.login, draft: p.draft, created_at: p.created_at, updated_at: p.updated_at, merged_at: p.merged_at, url: p.html_url })), next: nextLink(headers) }))
    },
  },
  act: {
    async open_issue(ctx, input) {
      const repo = repoOf({ filters: { repo: input.repo as string } })
      const { data } = await json(ctx, `${API}/repos/${repo}/issues`, { method: 'POST', headers: H, body: { title: input.title, ...(input.body ? { body: input.body } : {}) } })
      return { ok: true, result: { number: data.number, url: data.html_url }, message: `opened #${data.number}` }
    },
  },
})
