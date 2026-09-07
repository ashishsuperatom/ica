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
import zlib from 'node:zlib'
// The RULES both proxies obey. Only `decide` — when we may spend a key of ours — is genuinely shared, because
// a security rule with two copies is one that gets fixed in one place. Everything else here is this runtime's
// own plumbing, which is why the two files look nothing alike below this line.
// contract.mjs here is a COPY, placed by deploy.sh from vm/packages/agent-contract — the single source. This
// box gets only agent-proxy/, so the file has to be beside the proxy; making it a build-time copy of one
// original is the difference between a mirror and a second opinion. deploy.sh refuses to deploy without it.
import { UPSTREAMS, PATH_PREFIX, parsePath, bearerOf, decide, usageFromSseTail, usageFrom,
         allHosts, hostMatches } from './contract.mjs'

// ── CONFIGURATION: three variables; everything else is a decision already made ───────────────────────────
//
//   SUPERATOM_PLATFORM   the domain the platform lives on — proxy.<domain> follows from it, so there is one
//                        thing to change when it moves rather than several that can disagree
//   PROXY_PROJECT        who this box is
//   PROXY_PROJECT_KEY    proof of it, checked against ProjectDO
//
// Everything that used to be a knob is now decided. The port is 443, because a network restrictive enough to
// need this proxy will not admit an odd one. The tunnel's destinations are fixed because they are a FACT — the
// ChatGPT backend refuses relayed requests — rather than a preference. Ten minutes of cache keeps ProjectDO,
// single-threaded per project, out of the request path. A setting for each of those is a way to get one wrong
// on one box and spend an afternoon finding out.
const PLATFORM = process.env.SUPERATOM_PLATFORM || 'superatom.site'
const PROJECT = process.env.PROXY_PROJECT || ''
const PROJECT_KEY = process.env.PROXY_PROJECT_KEY || ''

const PORT = 443
const VERIFY_URL = `https://proxy.${PLATFORM}`
const TTL_MS = 10 * 60 * 1000        // both "is this project real" and "which credential is current"

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


// ── PARITY MODE — the same URL contract the Worker serves ────────────────────────────────────────────────
// Enabled by PROXY_VERIFY_URL. This box is the SECONDARY proxy: the Worker is primary, and this exists so
// neither is a single point of failure, and so a provider can be moved here unchanged if a Worker limit ever
// bites. Same paths, same auth rule, same key attaching — only the plumbing differs.
// ── CREDENTIALS COME FROM THE VAULT, NOT FROM THIS BOX ───────────────────────────────────────────────────
// This machine holds no provider keys. It asks the Worker for one, exactly the way an engine does, using the
// project credentials it already needs for verification — so there is ONE place a key lives and one place to
// revoke it. A key in a file here would be a second copy that nobody remembers to rotate.
//
// PROXY_PROJECT / PROXY_PROJECT_KEY identify this box to the vault. There is NO fallback to a key in the
// environment: a fallback that reaches for whatever is named similarly is how an unrelated card-backed key
// gets spent without anyone noticing, which is exactly what happened on the Worker side with a transcription
// key. If the vault cannot be reached, this box serves nothing and says so.
const keyCache = new Map()   // provider → { key, id, at }

async function keyFor(name) {
  const pid = PROJECT, pkey = PROJECT_KEY
  if (!pid || !pkey) { log(`   xx no project identity on this box — cannot fetch a credential for ${name}`); return undefined }

  const hit = keyCache.get(name)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.key

  try {
    const r = await fetch(`${VERIFY_URL}/${PATH_PREFIX}/${encodeURIComponent(pid)}/_key/${encodeURIComponent(name)}`,
      { headers: { authorization: `Bearer ${pkey}` } })
    if (r.ok) {
      const b = await r.json()
      if (b?.key) {
        // The id, not the key: enough to see WHICH credential is in play across the logs of both proxies.
        if (hit?.id !== b.keyId) log(`   ↻ ${name}: using ${b.keyId ?? '<unvaulted>'} from the vault`)
        keyCache.set(name, { key: b.key, id: b.keyId, at: Date.now() })
        return b.key
      }
    }
    log(`   xx vault has no credential for ${name} (${r.status})`)
  } catch (e) {
    log(`   xx vault unreachable for ${name} (${e.message})`)
  }
  return undefined
}

/** Forget a cached credential, so the next call re-asks the vault. Used when a provider rejects the key we
 *  have: the vault may already have moved to another subscription. */
const forgetKey = (name) => keyCache.delete(name)

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

function meter(rec) { log(`[proxy] ${rec.project} ${rec.provider} ${rec.model ?? '?'} in=${rec.in} out=${rec.out} ${rec.ms}ms`) }

// ── REVERSE MODE ─────────────────────────────────────────────────────────────────────────────────────────
// The agent thinks we are the API. We see everything, so this is where credential injection happens.
// The contract path: /p/<projectId>/<provider>/<the client's own path>
async function contractRoute(req, res) {
  const url = new URL(req.url, 'http://x')
  const p = parsePath(url.pathname)
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body, null, 2)) }

  if (p.service === '_health') {
    const have = []
    for (const n of Object.keys(UPSTREAMS)) if (await keyFor(n)) have.push(n)
    return send(200, { ok: true, mode: 'ec2', providers: have, tunnel: true,
                       vault: !!(PROJECT && PROJECT_KEY) })
  }

  const sent = bearerOf((h) => req.headers[h] ?? null)
  const proven = await provenProject(p.projectId, sent)
  if (p.service === '_whoami') return send(proven ? 200 : 401, { project: proven ? p.projectId : null, proven })

  const up = UPSTREAMS[p.provider]
  if (!up) return send(404, { error: `unknown provider /${p.provider}`, providers: Object.keys(UPSTREAMS) })
  if (up.disabled) return send(403, { error: `${p.provider} is disabled: ${up.disabled}`, provider: p.provider })
  if (up.route === 'box') return send(421, { error: `${p.provider} is a box-side credential — fetch it from /_key/${p.provider}`, envVar: up.envVar ?? null })
  if (up.route === 'tunnel' || !up.base) return send(421, { error: `${p.provider} is served by the CONNECT tunnel on this same box`, use: `HTTPS_PROXY=http://<this host>:${PORT}` })

  const verdict = decide({ projectId: p.projectId, sentCredential: sent, proven })
  if (!verdict.ok) return send(verdict.status, { error: verdict.error })

  const target = new URL(up.base + '/' + p.rest + url.search)
  const headers = { ...req.headers }
  delete headers.host; delete headers['content-length']
  if (verdict.attachKey) {
    const key = await keyFor(p.provider)
    if (!key) return send(503, { error: `no key configured for ${p.provider}` })
    delete headers.authorization; delete headers['x-api-key']    // never forward our own project key upstream
    Object.assign(headers, up.header(key))
  }

  const t0 = Date.now()
  const fwd = https.request({ hostname: target.hostname, port: 443, method: req.method, path: target.pathname + target.search, headers },
    (r) => {
      // Metered as it flows: buffering a response to count it would delay first-token latency, the one thing
      // a user actually feels.
      // Decompress before reading usage. A gzipped body read as raw bytes parses as nothing, which is why the
      // first EC2 run metered in=0 out=0 on a response the Worker counted correctly — the Worker's
      // Response.json() decompresses for free and this side has to ask.
      const enc = String(r.headers['content-encoding'] || '').toLowerCase()
      const reader = enc.includes('gzip') ? r.pipe(zlib.createGunzip())
                   : enc.includes('br')   ? r.pipe(zlib.createBrotliDecompress())
                   : enc.includes('deflate') ? r.pipe(zlib.createInflate()) : r
      let tail = ''
      reader.on('data', (c) => { tail = (tail + c.toString()).slice(-8000) })
      reader.on('error', () => { /* a body we cannot read is not a reason to disturb the response */ })
      reader.on('end', () => {
        const u = usageFromSseTail(tail) ?? (() => { try { return usageFrom(JSON.parse(tail)) } catch { return null } })()
        meter({ project: p.projectId, provider: p.provider, model: undefined, in: u?.in ?? 0, out: u?.out ?? 0, ms: Date.now() - t0 })
      })
      // 401/403 means the credential we were handed is no longer good. Drop it so the next request asks the
      // vault again, which may already have rotated to another subscription.
      if (r.statusCode === 401 || r.statusCode === 403) { forgetKey(p.provider); log(`   ↻ ${p.provider} rejected our credential — will re-ask the vault`) }
      res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res)
    })
  fwd.on('error', (e) => { log(`   xx upstream ${e.message}`); if (!res.headersSent) res.writeHead(502); res.end(e.message) })
  req.pipe(fwd)
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

// ── ONE PORT, BOTH MODES ─────────────────────────────────────────────────────────────────────────────────
// A CONNECT means a tunnel; any other request means the contract path. There is no third case: the
// single-upstream reverse handler and the plaintext forward handler both existed to run the experiments that
// established the ChatGPT backend cannot be relayed, and that question is settled.
const server = http.createServer((req, res) => {
  contractRoute(req, res).catch((e) => {
    log(`   xx ${e.message}`)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'proxy error' }))
  })
})

server.on('connect', (req, sock, head) => {
  connect(req, sock, head).catch((e) => { log(`   xx connect: ${e.message}`); sock.destroy() })
})
server.on('clientError', (e, sock) => { log(`   xx client error: ${e.message}`); sock.destroy() })

server.listen(PORT, () => {
  log(`agent-proxy on :${PORT}`)
  log(`  platform → ${PLATFORM}   (verifying against ${VERIFY_URL})`)
  log(`  project  → ${PROJECT || 'NOT SET — this box cannot fetch credentials or authenticate callers'}`)
  log('')
})
