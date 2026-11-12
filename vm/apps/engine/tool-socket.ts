// THE ENGINE'S TOOL SERVER: what an agent's tools ask the engine — HTTP on a Unix socket in the project's home (a file,
// not a port: several engines on one machine never meet, and Docker and native are the same). The engine's own state —
// its databases, its knowledge — is never opened by an agent: a tool asks here, and the engine answers from it. Two
// kinds of tool, by how the engine knows whose question it is:
//   ticketed  the turn's data ticket (x-sa-ticket), signed by the engine and checked here as the datasource manager
//             checks it: whose it is and what they may read (find-schema, get-schema, find-concept)
//   turn      a turn the engine is running now (x-sa-turn), open only while it runs (find-intent)
//   POST /tools/<name>   { args } → 200 { text } · 4xx/5xx { error }

import { createServer, type Server } from 'node:http'
import { mkdirSync, rmSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

/** Windows has no socket files: a named pipe, one per project home, carries the same HTTP. */
const WINDOWS = process.platform === 'win32'
/** Where a project's tool socket is: a file in its home (Linux, macOS), a named pipe on Windows. */
export const toolSocketOf = (projectDir: string) => (WINDOWS
  ? '\\\\.\\pipe\\superatom-tools-' + createHash('sha256').update(projectDir).digest('hex').slice(0, 16)
  : join(projectDir, 'run', 'tools.sock'))
const isPipe = (path: string) => path.startsWith('\\\\.\\pipe\\')

export type TurnHandler = (args: Record<string, unknown>) => Promise<string>
export type TicketHandler<T> = (args: any, ticket: T) => Promise<string>
export interface ToolSocket {
  path: string
  /** A tool any turn may ask, answered for whoever its ticket is. */
  serve<T>(tool: string, handler: TicketHandler<T>): void
  /** What a turn may ask, by tool: open until the returned function is called (the turn's end). */
  on(turn: string, tool: string, handler: TurnHandler): () => void
  close(): void
}

/** The longest a tool waits for its reply. */
const REPLY_MS = 60_000
/** The most a request may carry. */
const MAX_BODY = 64 * 1024

export function serveTools<T>(path: string, o: { verify: (ticket: string) => T; log?: (s: string) => void }): ToolSocket {
  const log = o.log ?? (() => {})
  const ticketed = new Map<string, TicketHandler<any>>()
  const turns = new Map<string, TurnHandler>()
  const key = (turn: string, tool: string) => `${turn}\u0000${tool}`
  // A socket file left by an engine that stopped is cleared; a named pipe goes with the process that made it.
  if (!isPipe(path)) { mkdirSync(dirname(path), { recursive: true }); rmSync(path, { force: true }) }
  const server: Server = createServer((req, res) => {
    const reply = (code: number, body: { text?: string; error?: string }) => { if (res.writableEnded) return; res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    const m = /^\/tools\/([a-z][a-z0-9-]{0,40})$/.exec(req.url ?? '')
    if (req.method !== 'POST' || !m) return reply(404, { error: 'there is no such tool' })
    const tool = m[1]
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c) => { raw += c; if (raw.length > MAX_BODY) { reply(413, { error: 'what was sent is too long' }); req.destroy() } })
    req.on('end', async () => {
      if (res.writableEnded) return
      let args: any = {}
      try { args = raw ? JSON.parse(raw)?.args ?? {} : {} } catch { return reply(400, { error: 'what was sent could not be read' }) }
      let work: () => Promise<string>
      const turn = String(req.headers['x-sa-turn'] ?? '')
      const own = turn ? turns.get(key(turn, tool)) : undefined
      if (own) work = () => own(args && typeof args === 'object' ? args : {})
      else if (ticketed.has(tool)) {
        let t: T
        try { t = o.verify(String(req.headers['x-sa-ticket'] ?? '')) } catch (e: any) { return reply(403, { error: e?.message ?? 'your access could not be checked' }) }
        work = () => ticketed.get(tool)!(args, t)
      } else return reply(403, { error: `${tool} can be run only during your turn` })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const text = await Promise.race([work(), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('no reply in time')), REPLY_MS) })])
        reply(200, { text })
      } catch (e: any) { log(`[tools] ${tool} failed: ${e?.message ?? e}`); reply(500, { error: String(e?.message ?? e) }) }
      finally { clearTimeout(timer) }
    })
  })
  // Open to the engine's agents (another user in the image): who may be answered is decided here — by the ticket the
  // engine signed, or the turn it is running — never by the file.
  server.listen(path, () => { if (!isPipe(path)) try { chmodSync(path, 0o666) } catch { /* best-effort */ } })
  server.on('error', (e) => log(`[tools] the socket ${path} failed: ${e.message}`))
  return {
    path,
    serve(tool, handler) { ticketed.set(tool, handler) },
    on(turn, tool, handler) { const k = key(turn, tool); turns.set(k, handler); return () => { if (turns.get(k) === handler) turns.delete(k) } },

    close() { server.close(); if (!isPipe(path)) rmSync(path, { force: true }) },
  }
}

/** A tool's script asking the engine (the source of a small Node program, as an agent's tool is): `ask(tool, args)`
 *  sends the turn (its folder's .turn) and the data ticket (SA_TICKET, else its folder's .ticket); resolves to
 *  { text } or { error }. */
export const askSocket = (socket: string, folder: string) => `const ask = (tool, args) => new Promise((resolve) => {
  const { readFileSync } = process.getBuiltinModule('node:fs'), { request } = process.getBuiltinModule('node:http')
  const read = (f) => { try { return readFileSync(f, 'utf8').trim() } catch { return '' } }
  const headers = { 'content-type': 'application/json', 'x-sa-turn': read(${JSON.stringify(join(folder, '.turn'))}), 'x-sa-ticket': process.env.SA_TICKET || read(${JSON.stringify(join(folder, '.ticket'))}) }
  const req = request({ socketPath: ${JSON.stringify(socket)}, path: '/tools/' + tool, method: 'POST', headers }, (res) => {
    let got = ''; res.setEncoding('utf8'); res.on('data', (c) => { got += c })
    res.on('end', () => { try { resolve(JSON.parse(got)) } catch { resolve({ error: 'the engine gave no reply' }) } })
  })
  req.on('error', (e) => resolve({ error: 'the engine could not be reached: ' + e.message }))
  req.end(JSON.stringify({ args }))
})`
