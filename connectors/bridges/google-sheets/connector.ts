// Google Sheets: a person's own spreadsheets, with their own Google account (OAuth — the platform signs them in and hands
// an access token as the secret accessToken). "spreadsheets" lists them; "<spreadsheet id>" lists its sheets;
// "<spreadsheet id>/<sheet name>" reads a sheet's rows, its first row naming the fields.
import { apiConnector, json, ConnectorError, type ConnectorContext, type ReadRequest } from '../../src/api'

const DRIVE = 'https://www.googleapis.com/drive/v3'
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets'
const ID = /^[A-Za-z0-9_-]{20,}$/
const letters = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : letters(Math.floor(i / 26) - 1) + letters(i % 26))

async function spreadsheets(ctx: ConnectorContext, req: ReadRequest) {
  const rows: Record<string, unknown>[] = []
  const name = String(req.filters?.name ?? '').replace(/['\\]/g, '')
  let token: string | null = req.cursor ?? null
  do {
    const q = new URLSearchParams({ q: `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false${name ? ` and name contains '${name}'` : ''}`, fields: 'nextPageToken,files(id,name,modifiedTime,owners(emailAddress),webViewLink)', orderBy: 'modifiedTime desc', pageSize: String(Math.min(100, req.limit!)), ...(token ? { pageToken: token } : {}) })
    const { data } = await json(ctx, `${DRIVE}/files?${q}`)
    // _open: what a row opens (the connection page follows it; an agent reads it as the next query's entity)
    for (const f of data.files ?? []) rows.push({ name: f.name, modified: f.modifiedTime, owner: f.owners?.[0]?.emailAddress ?? null, id: f.id, url: f.webViewLink, _open: f.id })
    token = data.nextPageToken ?? null
  } while (token && rows.length < req.limit!)
  return { rows: rows.slice(0, req.limit!), next: token }
}

async function sheetsOf(ctx: ConnectorContext, id: string) {
  const { data } = await json(ctx, `${SHEETS}/${id}?fields=properties.title,sheets.properties(title,gridProperties(rowCount,columnCount))`)
  return { title: data.properties?.title as string, sheets: (data.sheets ?? []).map((s: any) => ({ sheet: s.properties?.title, rows: s.properties?.gridProperties?.rowCount ?? null, columns: s.properties?.gridProperties?.columnCount ?? null, _open: `${id}/${s.properties?.title}` })) }
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
  description: "Google Sheets — the reader's own spreadsheets. {\"entity\": \"spreadsheets\"} lists them (filters: name); {\"entity\": \"<spreadsheet id>\"} lists its sheets; {\"entity\": \"<spreadsheet id>/<sheet name>\"} reads a sheet's rows, its first row naming the fields.",
  headers: ({ secrets }) => (secrets.accessToken ? { authorization: `Bearer ${secrets.accessToken}` } : {}),
  requires: ['accessToken'],
  async test(ctx) {
    const { data } = await json(ctx, `${DRIVE}/about?fields=user(emailAddress)`)
    return `signed in as ${data.user?.emailAddress ?? 'someone'}`
  },
  entities: [
    { name: 'spreadsheets', label: 'Spreadsheets', description: "The reader's spreadsheets, newest first.", fields: [{ name: 'id', type: 'string', key: true }, { name: 'name', type: 'string' }, { name: 'modified', type: 'timestamp' }, { name: 'owner', type: 'string' }, { name: 'url', type: 'string' }], filters: ['name'] },
  ],
  read: {
    spreadsheets,
    async '*'(ctx, req) {
      const [id, ...rest] = req.entity.split('/')
      if (!ID.test(id)) throw new ConnectorError(`read "spreadsheets", "<spreadsheet id>" or "<spreadsheet id>/<sheet name>" — "${req.entity}" is none of them`)
      if (!rest.length) return { rows: (await sheetsOf(ctx, id)).sheets, next: null }
      return { rows: await rowsOf(ctx, id, rest.join('/'), req.limit!), next: null }
    },
  },
})

