// THE ENGINE'S SOCKET FOR AN AGENT'S TOOLS: a tool an agent runs during its turn that needs the engine's answer at once
// (find-intent: the candidates for the question as the agent spelled it out) asks here — a Unix socket in the project's
// home, one JSON request per connection, one JSON reply. Only a turn the engine is running can be asked for: each turn
// opens what it may be asked (`on`) and closes it when it ends; anything else is refused.

import { createServer, type Server } from 'node:net'
import { mkdirSync, rmSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Where a project's tool socket is. */
export const toolSocketOf = (projectDir: string) => join(projectDir, 'run', 'tools.sock')

export type ToolHandler = (args: Record<string, unknown>) => Promise<string>
export interface ToolSocket {
  path: string
  /** What a turn may be asked, by tool: open until the returned function is called (the turn's end). */
  on(turn: string, tool: string, handler: ToolHandler): () => void
  close(): void
}

/** The longest a tool waits for its reply. */
const REPLY_MS = 60_000

export function serveTools(path: string, log: (s: string) => void = () => {}): ToolSocket {
  const open = new Map<string, ToolHandler>()
  const key = (turn: string, tool: string) => `${turn}\u0000${tool}`
  mkdirSync(dirname(path), { recursive: true })
  rmSync(path, { force: true })
  const server: Server = createServer((sock) => {
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', async (chunk) => {
      buf += chunk
      const nl = buf.indexOf('\n'); if (nl < 0) return
      const line = buf.slice(0, nl); buf = ''
      const reply = (r: { text?: string; error?: string }) => sock.end(`${JSON.stringify(r)}\n`)
      let req: any
      try { req = JSON.parse(line) } catch { return reply({ error: 'the request could not be read' }) }
      const h = open.get(key(String(req?.turn ?? ''), String(req?.tool ?? '')))
      if (!h) return reply({ error: `${req?.tool ?? 'this tool'} can be run only during your turn` })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const text = await Promise.race([h(req?.args && typeof req.args === 'object' ? req.args : {}), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('no reply in time')), REPLY_MS) })])
        reply({ text })
      } catch (e: any) { log(`[tools] ${req.tool} for ${req.turn} failed: ${e?.message ?? e}`); reply({ error: String(e?.message ?? e) }) }
      finally { clearTimeout(timer) }
    })
    sock.on('error', () => {})
  })
  // Open to the engine's agents (another user in the image): what may be asked is decided here, by the turn — never by the file.
  server.listen(path, () => { try { chmodSync(path, 0o666) } catch { /* best-effort */ } })
  server.on('error', (e) => log(`[tools] the socket ${path} failed: ${e.message}`))
  return {
    path,
    on(turn, tool, handler) { const k = key(turn, tool); open.set(k, handler); return () => { if (open.get(k) === handler) open.delete(k) } },
    close() { server.close(); rmSync(path, { force: true }) },
  }
}

/** A tool's script asking the socket (the source of a small Node program, as an agent's tool is). */
export const askSocket = (socket: string) => `const ask = (tool, args) => new Promise((resolve) => {
  const { readFileSync } = process.getBuiltinModule('node:fs'), { connect } = process.getBuiltinModule('node:net')
  let turn = ''; try { turn = readFileSync('.turn', 'utf8').trim() } catch {}
  const s = connect(${JSON.stringify(socket)}); let got = ''
  s.on('connect', () => s.write(JSON.stringify({ tool, turn, args }) + '\\n'))
  s.on('data', (c) => { got += c })
  s.on('end', () => { try { resolve(JSON.parse(got)) } catch { resolve({ error: 'no reply' }) } })
  s.on('error', (e) => resolve({ error: 'the engine could not be reached: ' + e.message }))
})`
