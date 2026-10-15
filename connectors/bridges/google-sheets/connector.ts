// Google Sheets: a person's own spreadsheets, with their own Google account (OAuth — the platform signs them in and hands
// an access token as the secret accessToken). A tree of two levels: a spreadsheet holds sheets; a sheet holds rows, its
// first row naming the fields.
import { apiConnector, json, ConnectorError, type ConnectorContext, type TreeNode } from '../../src/api'

const DRIVE = 'https://www.googleapis.com/drive/v3'
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets'
const ID = /^[A-Za-z0-9_-]{20,}$/
const letters = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : letters(Math.floor(i / 26) - 1) + letters(i % 26))

async function spreadsheets(ctx: ConnectorContext, search: string | undefined, cursor: string | null, limit: number) {
  const nodes: TreeNode[] = []
  const name = String(search ?? '').replace(/['\\]/g, '')
  let token: string | null = cursor
  do {
    const q = new URLSearchParams({ q: `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false${name ? ` and name contains '${name}'` : ''}`, fields: 'nextPageToken,files(id,name,modifiedTime,owners(emailAddress))', orderBy: 'modifiedTime desc', pageSize: String(Math.min(100, limit)), ...(token ? { pageToken: token } : {}) })
    const { data } = await json(ctx, `${DRIVE}/files?${q}`)
    for (const f of data.files ?? []) nodes.push({ id: f.id, label: f.name, table: false, detail: { modified: f.modifiedTime ?? null, owner: f.owners?.[0]?.emailAddress ?? null } })
    token = data.nextPageToken ?? null
  } while (token && nodes.length < limit)
  return { nodes: nodes.slice(0, limit), next: token }
}

async function sheetsOf(ctx: ConnectorContext, id: string, search: string | undefined): Promise<TreeNode[]> {
  if (!ID.test(id)) throw new ConnectorError(`"${id}" is not a spreadsheet's id`)
  const { data } = await json(ctx, `${SHEETS}/${id}?fields=sheets.properties(title,gridProperties(rowCount,columnCount))`)
  const term = String(search ?? '').toLowerCase()
  return (data.sheets ?? []).map((s: any) => ({ id: s.properties?.title, label: s.properties?.title, table: true, detail: { rows: s.properties?.gridProperties?.rowCount ?? null, columns: s.properties?.gridProperties?.columnCount ?? null } }))
    .filter((n: TreeNode) => n.id && (!term || n.label.toLowerCase().includes(term)))
}

async function rowsOf(ctx: ConnectorContext, id: string, sheet: string, limit: number) {
  // the first row names the fields (an empty or repeated name: the column's letter)
  const range = `'${sheet.replace(/'/g, "''")}'!1:${limit + 1}`
  const { data } = await json(ctx, `${SHEETS}/${id}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`)
  const [head = [], ...body] = (data.values ?? []) as unknown[][]
  const seen = new Set<string>()
  const names = Array.from({ length: Math.max(head.length, ...body.map((r) => r.length)) }, (_, i) => {
    const n = String(head[i] ?? '').trim()
    const name = n && !seen.has(n) ? n : letters(i)
    seen.add(name); return name
  })
  return body.filter((r) => r.some((v) => v !== '' && v !== null && v !== undefined)).slice(0, limit).map((r) => Object.fromEntries(names.map((n, i) => [n, r[i] === '' ? null : r[i] ?? null])))
}

export const createBridge = apiConnector('google-sheets', {
  description: "Google Sheets — the reader's own spreadsheets.",
  headers: ({ secrets }) => (secrets.accessToken ? { authorization: `Bearer ${secrets.accessToken}` } : {}),
  requires: ['accessToken'],
  async test(ctx) {
    const { data } = await json(ctx, `${DRIVE}/about?fields=user(emailAddress)`)
    return `signed in as ${data.user?.emailAddress ?? 'someone'}`
  },
  tree: {
    levels: [{ name: 'Spreadsheet' }, { name: 'Sheet' }],
    async children(ctx, { path, search, cursor, limit }) {
      if (!path.length) return spreadsheets(ctx, search, cursor ?? null, limit)
      return { nodes: (await sheetsOf(ctx, path[0], search)).slice(0, limit), next: null }
    },
    async read(ctx, { path, limit }) {
      if (!ID.test(path[0])) throw new ConnectorError(`"${path[0]}" is not a spreadsheet's id`)
      return { rows: await rowsOf(ctx, path[0], path[1], limit!), next: null }
    },
  },
})
