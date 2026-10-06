// A Chrome to drive: launched with its own profile (signed in once, by a person, with `ui-review login`) and the
// DevTools protocol, spoken directly — no browser-automation dependency.

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Start Chrome; `headless` false for a person to sign in. Returns a client for its first page, and a stop. */
export async function launch({ profile, headless = true, port = 9339, url = 'about:blank' }) {
  mkdirSync(profile, { recursive: true })
  const args = [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check', '--disable-features=Translate', url]
  if (headless) args.unshift('--headless=new', '--hide-scrollbars')
  const proc = spawn(CHROME, args, { stdio: 'ignore' })
  let list = null
  for (let i = 0; i < 100 && !list; i++) { await sleep(150); list = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => null) }
  if (!list) { proc.kill(); throw new Error('Chrome did not start (is another one using the profile?)') }
  const page = list.find((p) => p.type === 'page')
  const client = await connect(page.webSocketDebuggerUrl)
  return { client, proc, stop: async () => { try { await client.send('Browser.close') } catch { /* gone */ } ; setTimeout(() => proc.kill(), 1500) } }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const waiting = new Map(), listeners = new Set()
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data))
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result) }
    else if (m.method) for (const fn of listeners) fn(m)
  }
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; waiting.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })) }),
    on: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    /** Evaluate an expression in the page and return its value. */
    eval: async function (expression) {
      const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      return r.result.value
    },
    close: () => ws.close(),
  }
}
