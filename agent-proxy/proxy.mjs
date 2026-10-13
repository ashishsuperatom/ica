#!/usr/bin/env node
// THE TUNNEL (tunnel.superatom.site) — a CONNECT pass-through for the hosts the contract names, and nothing else.
// Node built-ins only: no install, no lockfile.
//
// WHY IT EXISTS. ChatGPT refuses relayed requests, so an engine signs its own (with the ChatGPT login the platform's
// vault hands it) and sends them itself. Where a network blocks chatgpt.com, those requests travel through here — our
// domain — as encrypted bytes we only copy: we see the host and the byte count, never a header. Every other provider
// is relayed by the platform's proxy (proxy.superatom.site), which adds the key; this box holds no key of any kind.
//
// A caller proves its project with its engine key (HTTPS_PROXY=http://<project>:<key>@tunnel…), checked by the
// platform; the destination must be one the contract names.

import http from 'node:http'
import net from 'node:net'
// contract.mjs here is a COPY, placed by deploy.sh from vm/packages/agent-contract — the single source.
import { PATH_PREFIX, allHosts, hostMatches } from './contract.mjs'

// ── CONFIGURATION ─────────────────────────────────────────────────────────────────────────────────────────
//   SUPERATOM_PLATFORM   the platform's domain: callers are checked at proxy.<domain>
// The port is 443: a network restrictive enough to need this will not admit an odd one.
const PLATFORM = process.env.SUPERATOM_PLATFORM || 'superatom.site'

const PORT = 443
const VERIFY_URL = `https://proxy.${PLATFORM}`
const TTL_MS = 10 * 60 * 1000        // how long "is this project real" is remembered

const ts = () => new Date().toISOString().slice(11, 23)
const log = (...a) => console.log(`${ts()}`, ...a)


// Is this really that project? Asked of the Worker, which owns ProjectDO. We deliberately do NOT keep a second
// copy of the key here: one source of truth, and revoking a project cuts off both proxies at once.
//
// CACHED, AND THE REASON IS CONTENTION, NOT SPEED. A Durable Object is single-threaded and there is exactly
// one per project — every user of that project, and every engine box working for it, funnels through the same
// object. It answers quickly, but asking it on every new connection would put all of that traffic in one queue
// behind whatever else the project is doing. Ten minutes keeps it to a handful of calls an hour per project.
//
// The cost is revocation lag: a key stays usable for up to the TTL after it is revoked. Acceptable here
// because this credential gates EGRESS to an allowlist of model providers, not access to data — and because
// we own this box, so shortening it is a restart, not a release.
const verifyCache = new Map()   // projectId+key → { ok, at }
async function provenProject(projectId, key) {
  if (!projectId || !key || !VERIFY_URL) return false
  const ck = projectId + '\u0000' + key
  const hit = verifyCache.get(ck)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ok
  try {
    const r = await fetch(`${VERIFY_URL}/${PATH_PREFIX}/${encodeURIComponent(projectId)}/_verify`,
      { headers: { authorization: `Bearer ${key}` } })
    const ok = r.status === 200
    // Only SUCCESS is cached for the full term. A refusal is cached briefly — long enough to blunt a guessing
    // loop, short enough that a box whose key was just fixed is not locked out for ten minutes.
    verifyCache.set(ck, { ok, at: ok ? Date.now() : Date.now() - TTL_MS + 30_000 })
    return ok
  } catch (e) { log(`   xx verify failed (${e.message}) — refusing rather than guessing`); return false }
}

// ── FORWARD MODE, CONNECT ────────────────────────────────────────────────────────────────────────────────
// We open a raw socket to the destination and copy bytes. The TLS session is between the client and the REAL
// server, so what we learn is: this agent honours proxy env, and it is talking to THIS host. Not one header
// crosses our process in the clear. That is not a limitation to work around — it is TLS working.
// Which hosts the tunnel will open a socket to. An open CONNECT proxy is a resource anyone on the internet
// can use once they find it, so the destination is checked as well as the caller — a stolen credential then
// buys access to our model providers and nothing else.
// Every host any provider in the contract talks to — derived, so adding a provider opens its host here and
// nowhere else, and removing one closes it. This was a hand-maintained literal in parallel with three others.
const TUNNEL_ALLOW = allHosts()
const allowed = (host) => hostMatches(host, TUNNEL_ALLOW)

// ── FORWARD MODE, CONNECT ────────────────────────────────────────────────────────────────────────────────
// We open a raw socket to the destination and copy bytes. The TLS session is between the client and the REAL
// server, so what we learn is: this agent is talking to THIS host, and this many bytes moved. Not one header
// crosses our process in the clear.
//
// That is not a limitation to work around — it is the whole reason this path exists. The ChatGPT backend
// refuses anything relayed (403 through a Worker, 302 through a Node reverse proxy, while the same request
// sent directly succeeds), so the only way to carry it is to not be in the conversation at all. It also means
// a change to their protocol cannot break us, because we never parsed it.
//
// AUTHENTICATION is the caller's project id and API key, sent as ordinary proxy credentials
// (HTTPS_PROXY=http://<projectId>:<key>@host). Every client we use sends them on CONNECT without being taught
// anything, and the check is the same ProjectDO the reverse path uses — one notion of "is this really that
// project" for both.
async function connect(req, clientSocket, head) {
  const [host, portStr] = req.url.split(':')
  const port = Number(portStr || 443)
  const t0 = Date.now()

  const deny = (code, why) => {
    log(`   ✗ CONNECT ${host}:${port} refused — ${why}`)
    clientSocket.write(`HTTP/1.1 ${code}\r\n` + (code.startsWith('407') ? 'Proxy-Authenticate: Basic realm="superatom"\r\n' : '') + '\r\n')
    clientSocket.destroy()
  }

  // Credentials first: an unauthenticated caller should learn nothing about what we would have allowed.
  let project = null
  if (VERIFY_URL) {
    const raw = req.headers['proxy-authorization'] || ''
    const b64 = /^Basic\s+(.+)$/i.exec(raw)?.[1]
    if (!b64) return deny('407 Proxy Authentication Required', 'no proxy credentials')
    const [pid, key] = Buffer.from(b64, 'base64').toString().split(':')
    if (!(await provenProject(pid, key))) return deny('407 Proxy Authentication Required', `bad credentials for ${pid || '(none)'}`)
    project = pid
  }
  if (!allowed(host)) return deny('403 Forbidden', `${host} is not an allowed destination`)

  log(`→ [proxy:CONNECT] ${host}:${port} for ${project ?? 'anonymous'}  (tunnelled — headers are inside TLS)`)

  const upstream = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: superatom-agent-proxy\r\n\r\n')
    if (head?.length) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })

  let up = 0, down = 0
  clientSocket.on('data', (c) => { up += c.length })
  upstream.on('data', (c) => { down += c.length })

  upstream.on('error', (e) => { log(`   xx tunnel to ${host}:${port}: ${e.message}`); clientSocket.destroy() })
  clientSocket.on('error', () => upstream.destroy())
  // Bytes, not tokens: the counts are inside TLS we deliberately cannot read. The engine reports tokens for
  // this provider; this is the independent check that something ran at all, and how much moved.
  upstream.on('close', () => log(`← [proxy:CONNECT] ${host}:${port} ${project ?? ''} closed after ${Date.now() - t0}ms · ↑${up}B ↓${down}B`))
  clientSocket.on('close', () => upstream.destroy())
}

// ── ONE PORT, ONE MODE ────────────────────────────────────────────────────────────────────────────────────
// A CONNECT is a tunnel. Anything else is answered plainly: /_health for whoever watches the box, and otherwise that
// relaying is the platform's proxy (the relay this box once had duplicated it and was removed, 2026-10-14).
const server = http.createServer((req, res) => {
  const body = req.url === '/_health' ? { ok: true, tunnel: true, hosts: TUNNEL_ALLOW } : { error: `this box only tunnels (CONNECT); relayed requests go to ${VERIFY_URL}` }
  res.writeHead(req.url === '/_health' ? 200 : 404, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
})

server.on('connect', (req, sock, head) => {
  connect(req, sock, head).catch((e) => { log(`   xx connect: ${e.message}`); sock.destroy() })
})
server.on('clientError', (e, sock) => { log(`   xx client error: ${e.message}`); sock.destroy() })

server.listen(PORT, () => {
  log(`tunnel on :${PORT} — CONNECT to ${TUNNEL_ALLOW.join(', ')}`)
  log(`  platform → ${PLATFORM}   (verifying against ${VERIFY_URL})`)
  log('')
})
