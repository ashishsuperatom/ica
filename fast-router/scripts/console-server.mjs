// Tiny local server for the fast-router test console. Serves index.html and a /config endpoint that
// hands the browser the hub URL + fast-router project id + shared key (from fast-router.local.json)
// so the page can connect to the DO as a 'runtime'. LOCAL DEV ONLY (the key reaches the browser).
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const cfg = JSON.parse(readFileSync(join(HERE, '..', 'fast-router.local.json'), 'utf8'))
const PORT = Number(process.env.CONSOLE_PORT || 7900)

createServer((req, res) => {
  if (req.url && req.url.startsWith('/config')) {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ hubHost: cfg.hubHost, id: cfg.id, key: cfg.key }))
  }
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(readFileSync(join(HERE, 'console', 'index.html')))   // read per-request so edits are live
}).listen(PORT, '127.0.0.1', () => console.log(`fast-router console → http://127.0.0.1:${PORT}`))
