#!/usr/bin/env node
// AGENT PROXY — one place the coding agents' API traffic goes through, so credentials live HERE and not in
// each agent on each box. Node built-ins only: no install, no lockfile, runs anywhere node does.
//
// WHY THIS EXISTS. Every agent (claude-code, codex, pi, opencode) authenticates itself, on every machine, and
// those logins expire at their own pace. A token expiring on a remote VM looks like a broken agent, not an
// expired login — which is exactly how it has been read here before. One credential holder, many agents, is
// the shape that fixes it.
//
// ── THE ONE THING TO UNDERSTAND ABOUT PROXY MODES ────────────────────────────────────────────────────────
// An HTTP_PROXY and a BASE_URL are not two spellings of the same idea, and only one of them can see a header:
//
//   FORWARD proxy  (HTTP_PROXY / HTTPS_PROXY)  → for an https:// upstream the client sends CONNECT, then does
//                   its TLS handshake with the REAL server through the tunnel we open. We see the hostname and
//                   the byte count. We CANNOT see or add a header: it is inside TLS that is not ours. Reading
//                   it would mean terminating TLS with our own CA and having every client trust it.
//   REVERSE proxy  (ANTHROPIC_BASE_URL / OPENAI_BASE_URL) → the client speaks plain HTTP(S) TO US as if we
//                   were the API. We see every header, can inject credentials, and forward upstream ourselves.
//
// So: to ATTACH credentials centrally, reverse mode is the mechanism. Forward mode is here anyway because it
// is one accept handler, it answers "does this agent honour proxy env at all", and it is what you want for
// egress control once credentials are solved.
//
// This server does BOTH on ONE port, decided per request — CONNECT or an absolute-form URI is a forward-proxy
// client; an origin-form path is someone treating us as the API.
//
// ── SECRETS ──────────────────────────────────────────────────────────────────────────────────────────────
// Credentials are never logged. A header that carries one is reported as present/absent with a short
// fingerprint (sha256 prefix) and a length, which is enough to tell "the agent sent its own" from "we injected
// ours" and enough to notice a token changing, without putting the token in a log file.

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { URL } from 'node:url'

const PORT = Number(process.env.PROXY_PORT ?? 8080)
// Where reverse-mode traffic goes when the request does not name an upstream itself.
const UPSTREAM = process.env.PROXY_UPSTREAM ?? 'https://api.anthropic.com'
const VERBOSE = process.env.PROXY_VERBOSE === '1'      // log every header name we saw (never a value)
const BODIES = process.env.PROXY_BODIES === '1'        // log a short prefix of request bodies (may contain prompts)

// Headers whose VALUE is a credential. Reported by fingerprint, never printed.
const SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'proxy-authorization', 'cookie', 'set-cookie'])

const fp = (v) => {
  if (v == null) return 'absent'
  const s = Array.isArray(v) ? v.join(',') : String(v)
  // The scheme ("Bearer", "sk-ant-…") is not the secret and is the useful part when reading a log, so keep the
  // shape and fingerprint the rest.
  const scheme = /^(\w+)\s/.exec(s)?.[1] ?? (s.startsWith('sk-') ? s.slice(0, s.indexOf('-', 3) + 1) : '')
  return `${scheme ? scheme + ' ' : ''}<${createHash('sha256').update(s).digest('hex').slice(0, 8)} len=${s.length}>`
}

const ts = () => new Date().toISOString().slice(11, 23)
const log = (...a) => console.log(`${ts()}`, ...a)

// What credentials do WE hold? Injected in reverse mode when the client sent none of its own.
//
// PROXY_ANTHROPIC_AUTH is deliberately raw and whole ("Bearer eyJ…" or an oauth token) rather than assembled
// from parts here: the agents differ in which header they use, and guessing wrongly produces a 401 that reads
// like a bad credential rather than a bad guess.
const HELD = {
  'x-api-key': process.env.PROXY_ANTHROPIC_API_KEY || '',
  authorization: process.env.PROXY_ANTHROPIC_AUTH || '',
}
const heldSummary = () => Object.entries(HELD).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'

// ── REVERSE MODE ─────────────────────────────────────────────────────────────────────────────────────────
// The agent thinks we are the API. We see everything, so this is where credential injection happens.
function reverse(req, res) {
  const up = new URL(UPSTREAM)
  const target = new URL(req.url, UPSTREAM)
  const headers = { ...req.headers }

  // Host must become the upstream's or TLS/SNI and routing disagree with the certificate.
  delete headers.host
  delete headers['content-length']   // recomputed by the upstream request as we stream

  const sentByAgent = Object.keys(headers).filter((h) => SECRET_HEADERS.has(h) && headers[h])
  const injected = []
  for (const [h, v] of Object.entries(HELD)) {
    if (!v) continue
    // The agent's own credential WINS. This proxy is a fallback for an agent that has none, not a way to
    // silently answer as somebody else — an agent that authenticated itself should keep its own identity.
    if (headers[h]) continue
    headers[h] = v
    injected.push(h)
  }
  // Anthropic rejects a request with no version header; an agent that sent none was relying on a client
  // default we are now standing in for.
  if (up.hostname.endsWith('anthropic.com') && !headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01'

  log(`→ ${req.method} ${target.pathname}${target.search}`)
  log(`   agent sent: ${sentByAgent.length ? sentByAgent.map((h) => `${h}=${fp(headers[h])}`).join(' ') : 'NO credential headers'}`)
  log(`   injected  : ${injected.length ? injected.join(', ') : 'nothing (agent had its own, or we hold none)'}`)
  if (VERBOSE) log(`   headers   : ${Object.keys(headers).join(', ')}`)

  const client = up.protocol === 'http:' ? http : https
  const fwd = client.request(
    { protocol: up.protocol, hostname: up.hostname, port: up.port || (up.protocol === 'http:' ? 80 : 443),
      method: req.method, path: target.pathname + target.search, headers },
    (upRes) => {
      log(`← ${upRes.statusCode} ${upRes.statusMessage ?? ''} for ${req.method} ${target.pathname}`)
      // A 401/403 is the whole point of the experiment, so make it loud and keep the body: that body is the
      // upstream telling us exactly which credential shape it wanted.
      if (upRes.statusCode === 401 || upRes.statusCode === 403) {
        let body = ''
        upRes.on('data', (c) => { if (body.length < 2000) body += c })
        upRes.on('end', () => log(`   !! auth rejected: ${body.slice(0, 800)}`))
      }
      res.writeHead(upRes.statusCode ?? 502, upRes.headers)
      upRes.pipe(res)
    })

  fwd.on('error', (e) => {
    log(`   xx upstream error: ${e.message}`)
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { type: 'proxy_error', message: e.message } }))
  })

  if (BODIES) {
    let seen = ''
    req.on('data', (c) => { if (seen.length < 400) seen += c })
    req.on('end', () => { if (seen) log(`   body      : ${seen.slice(0, 400).replace(/\s+/g, ' ')}`) })
  }
  req.pipe(fwd)
}

// ── FORWARD MODE, plain HTTP ─────────────────────────────────────────────────────────────────────────────
// An absolute-form URI ("GET http://host/path") means the client is treating us as a proxy. Plain HTTP is
// readable, so this path CAN see credentials — but agents talk to https:// endpoints, so in practice this
// mostly catches health checks and anything misconfigured to plaintext.
function forwardHttp(req, res) {
  const target = new URL(req.url)
  log(`→ [proxy:http] ${req.method} ${target.href}`)
  const creds = Object.keys(req.headers).filter((h) => SECRET_HEADERS.has(h) && req.headers[h])
  log(`   agent sent: ${creds.length ? creds.map((h) => `${h}=${fp(req.headers[h])}`).join(' ') : 'NO credential headers'}`)

  const headers = { ...req.headers }
  delete headers['proxy-connection']
  const fwd = http.request(
    { hostname: target.hostname, port: target.port || 80, method: req.method, path: target.pathname + target.search, headers },
    (upRes) => { log(`← [proxy:http] ${upRes.statusCode} ${target.href}`); res.writeHead(upRes.statusCode ?? 502, upRes.headers); upRes.pipe(res) })
  fwd.on('error', (e) => { log(`   xx ${e.message}`); res.writeHead(502).end(e.message) })
  req.pipe(fwd)
}

// ── FORWARD MODE, CONNECT ────────────────────────────────────────────────────────────────────────────────
// We open a raw socket to the destination and copy bytes. The TLS session is between the client and the REAL
// server, so what we learn is: this agent honours proxy env, and it is talking to THIS host. Not one header
// crosses our process in the clear. That is not a limitation to work around — it is TLS working.
function connect(req, clientSocket, head) {
  const [host, portStr] = req.url.split(':')
  const port = Number(portStr || 443)
  const t0 = Date.now()
  log(`→ [proxy:CONNECT] ${host}:${port}  (tunnelled — headers are inside TLS, not visible here)`)

  const upstream = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: superatom-agent-proxy\r\n\r\n')
    if (head?.length) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })

  let up = 0, down = 0
  clientSocket.on('data', (c) => { up += c.length })
  upstream.on('data', (c) => { down += c.length })
  const done = (why) => { log(`← [proxy:CONNECT] ${host}:${port} closed after ${Date.now() - t0}ms · ↑${up}B ↓${down}B (${why})`) }

  upstream.on('error', (e) => { log(`   xx tunnel to ${host}:${port}: ${e.message}`); clientSocket.destroy() })
  clientSocket.on('error', () => upstream.destroy())
  upstream.on('close', () => done('upstream'))
  clientSocket.on('close', () => { upstream.destroy() })
}

// ── ONE PORT, BOTH MODES ─────────────────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Our own liveness, answered before anything is forwarded, so "is the proxy up" never depends on upstream
  // credentials being right.
  if (req.url === '/__proxy/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, upstream: UPSTREAM, holds: heldSummary() }))
  }
  if (/^https?:\/\//i.test(req.url)) return forwardHttp(req, res)
  return reverse(req, res)
})

server.on('connect', connect)
server.on('clientError', (e, sock) => { log(`   xx client error: ${e.message}`); sock.destroy() })

server.listen(PORT, () => {
  log(`agent-proxy on :${PORT}`)
  log(`  reverse  → ${UPSTREAM}   (point an agent here with ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT})`)
  log(`  forward  → CONNECT tunnel (point an agent here with HTTPS_PROXY=http://127.0.0.1:${PORT})`)
  log(`  holding  → ${heldSummary()}`)
  log('')
})
