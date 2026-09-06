// ── proxy.superatom.site — the module's ONLY entry point ─────────────────────────────────────────────────
// worker.ts imports exactly one symbol from here (handleProxyHost) and wires it to one host check. Everything
// about proxying model traffic lives inside this folder and nothing leaks back out.
//
// WHY THIS EXISTS, in the order the reasons actually matter:
//
//  1. ONE DOMAIN TO WHITELIST. Engines run in places where the network allows an explicit list of hosts and
//     nothing else. Every model provider we use is a different domain, and that list grows each time we adopt
//     one. Behind this, an engine talks to `proxy.superatom.site` and to nothing else, forever.
//  2. NO PROVIDER KEY ON ANY BOX. A machine spawned for a week holds a token scoped to its own project. The
//     real provider keys live here, in Worker secrets, and rotate in one place. A leaked box token is revoked
//     alone; it is not a provider key.
//  3. METERING WE CAN TRUST. An engine reporting its own usage is only as honest as the engine is healthy — a
//     runaway loop, a crashed process, a box someone forgot: all invisible. Measured at the choke point, all
//     visible. Where both numbers exist, this one wins.
//
// WHAT THIS CANNOT DO, stated plainly so nobody rediscovers it: a CONNECT tunnel cannot be terminated in a
// Worker, and codex in ChatGPT-subscription mode ignores a base URL. So codex traffic cannot come through
// here — it needs the forward-proxy path on a VM, which satisfies the whitelist but sees only bytes. Codex
// usage has to be self-reported by the engine.

/** The subdomain this module answers on. Exported so worker.ts routes to it and reserves it from the same
 *  constant — two copies of a name is how a service and a customer end up claiming the same address. */
export const PROXY_SUBDOMAIN = 'proxy'

// THE RULES ARE SHARED. There are two proxies — this Worker (primary) and the Node server on EC2 (secondary,
// and the only one that can carry a CONNECT tunnel) — because neither may be a single point of failure for
// every agent on every project. Two copies of a rule is how one gets fixed and the other does not, so the URL
// shape, the upstream table, the auth decision and the usage parsing live in ONE file that both import.
// esbuild follows the relative path when the Worker is bundled.
import { UPSTREAMS as CONTRACT, PATH_PREFIX as SHARED_PREFIX, PROJECT_HEADER as SHARED_HEADER,
         parsePath, bearerOf as sharedBearer, decide, usageFrom as sharedUsage, usageFromSseTail } from '../../../../agent-proxy/contract.mjs'

import type { KV } from './pool.js'
import { readVault, writeVault, candidates, groupOf, markSpent, tidy, expiring, type Vault } from './vault.js'
import { refreshIfStale } from './usage.js'

export interface ProxyEnv {
  // Credential POLICY and STATE — which key serves which group, and which are spent. Never the values.
  CREDENTIALS?: KV
  // The one key that must NOT be in KV: it is what makes everything in KV unreadable on its own.
  CREDENTIALS_MASTER_KEY?: string
  // Verifying a project's API key is ProjectDO's job — it is the source of truth and can revoke. We never
  // keep a second copy of a key here to compare against.
  PROJECT?: { get(id: DurableObjectId): { fetch(req: Request): Promise<Response> }; idFromName(name: string): DurableObjectId }
  // Provider keys — Worker secrets, never sent to a box.
  OPENROUTER_API_KEY?: string
  OPENCODE_API_KEY?: string
  ANTHROPIC_API_KEY?: string
}

// ── HOW A BOX IDENTIFIES ITSELF ──────────────────────────────────────────────────────────────────────────
// THE AGENTS BUILD THEIR OWN REQUESTS. We do not. pi, opencode and claude-code each take a base URL and an
// API-key env var and construct everything else themselves, so the only two things we can influence are those
// two values. A custom header is unreachable — there is no way to ask any of them to send one.
//
// So the PROJECT ID rides in the base URL path, which every client appends its own path to:
//
//   https://proxy.superatom.site/p/<projectId>/<provider>
//
// claude-code then requests /p/<id>/anthropic/v1/messages, pi requests
// /p/<id>/openrouter/chat/completions, and neither had to be taught anything.
//
// WHAT IS IN THE PATH IS NOT A SECRET, and that is the point. A project id names WHICH project; the project's
// API key, in a header, PROVES it. Paths reach access logs, shell history and `ps` output, so nothing that
// grants anything is allowed to live there. The id is needed even for an authenticated call, because it says
// which project's key to check against — one addresses, the other proves.
//
// claude-code is the case that cannot prove anything: its Authorization already carries its own subscription
// token, which we forward untouched. So it is identified and not authenticated — acceptable only because such
// a call is given nothing. It brings its own credential, so a forged id misattributes a meter reading.
const PROJECT_HEADER = SHARED_HEADER
const PATH_PREFIX = SHARED_PREFIX

// The upstream table comes from the contract; here we only add how THIS runtime reads a key from its env.
// A credential by NAME. KV first — that is where the pool's values live and there is no limit on how many —
// then the Worker-secret binding, so a provider configured before any pool existed keeps working untouched.
// One read, one decrypt, and every question about credentials is answerable from memory for this request.
const vaultOf = async (env: ProxyEnv): Promise<Vault> =>
  env.CREDENTIALS ? readVault(env.CREDENTIALS, env.CREDENTIALS_MASTER_KEY) : { entries: [], groups: {} }

// The single fallback credential for a provider nobody has pooled yet.
const keyOf = async (name: string, env: ProxyEnv): Promise<string | undefined> => {
  const u = CONTRACT[name]
  return u?.envKey ? (env as any)[u.envKey] : undefined
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json' } })

/** PROOF that the caller really is this project — its own API key, checked against ProjectDO, which is the
 *  source of truth and the thing that can revoke it.
 *
 *  Required for anything that HANDS OUT a credential. An identifier in a URL path is not proof of anything:
 *  paths reach access logs, shell history and `ps` output, and a credential that unlocks other credentials
 *  must not be something that leaks by being written down. So `_key` takes the project's API key in a HEADER,
 *  and the path alone will never be enough to get one.
 *
 *  We reuse the key the engine already holds to reach the hub rather than minting a second project
 *  credential: one secret per project, provisioned once, revoked in one place. */
async function provenProject(env: ProxyEnv, projectId: string, apiKey: string | null): Promise<boolean> {
  if (!projectId || !apiKey || !env.PROJECT) return false
  try {
    const stub = env.PROJECT.get(env.PROJECT.idFromName(`proj:${projectId}`))
    // /verify-conn is the SAME check the hub makes when the engine connects, so a key that works there works
    // here and there is only one notion of "is this really that project".
    const res = await stub.fetch(new Request('http://do/verify-conn', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: apiKey }),
    }))
    return res.ok
  } catch { return false }
}

/** The bearer credential the caller sent, whatever header it chose. Agents can only set their provider's own
 *  key variable, so this is where a project API key arrives from pi or opencode. */
const bearerOf = (h: Headers): string | null =>
  (h.get('authorization')?.replace(/^Bearer\s+/i, '') ?? h.get('x-api-key') ?? null) || null

/** Token counts, wherever this provider chose to put them. Shapes differ (OpenAI's `usage`, Anthropic's
 *  `message_start`/`message_delta`), so this reads the ones we know and reports nothing rather than a wrong
 *  number for the ones we don't. */
function usageFrom(obj: any): { in: number; out: number } | null {
  const u = obj?.usage
  if (!u) return null
  const i = u.prompt_tokens ?? u.input_tokens
  const o = u.completion_tokens ?? u.output_tokens
  return (typeof i === 'number' || typeof o === 'number') ? { in: i ?? 0, out: o ?? 0 } : null
}

/** Record what a call cost. Deliberately fire-and-forget through ctx.waitUntil: metering must never be able to
 *  slow down or fail a model request — a proxy that breaks inference to write a counter is worse than no
 *  counter. Storage is the next decision (D1 / ProjectDO); the call site is already correct. */
function meter(ctx: ExecutionContext, rec: { project: string; provider: string; model?: string; in: number; out: number; ms: number }) {
  console.log(`[proxy] ${rec.project} ${rec.provider} ${rec.model ?? '?'} in=${rec.in} out=${rec.out} ${rec.ms}ms`)
}

/** Pass the body through untouched while watching it go by, so usage can be read from a STREAM without
 *  buffering it. Buffering would hold the whole response in memory and, worse, delay first-token latency —
 *  the one thing a user actually feels. */
function teeForUsage(body: ReadableStream, onDone: (u: { in: number; out: number } | null) => void): ReadableStream {
  let tail = ''
  let found: { in: number; out: number } | null = null
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      // Only the last part of the stream can hold the final usage block, so keep a bounded window rather than
      // the whole response.
      tail = (tail + new TextDecoder().decode(chunk, { stream: true })).slice(-8000)
    },
    flush() {
      for (const line of tail.split('\n')) {
        const d = line.startsWith('data:') ? line.slice(5).trim() : ''
        if (!d || d === '[DONE]') continue
        try { const u = usageFrom(JSON.parse(d)); if (u) found = u } catch { /* a partial frame in the window */ }
      }
      onDone(found)
    },
  }))
}

/**
 * Everything on proxy.superatom.site.
 *
 *   GET  /_health                  is it up, and what does it hold
 *   GET  /_whoami                  which project this token is, so a box can prove its wiring in one call
 *   GET  /_key/:provider           hand a real key to a box that CANNOT be proxied (codex). Rare by design:
 *                                  every key handed out is a key we no longer control.
 *   ANY  /:provider/*              forward to that provider, attaching the key if the caller had none
 */
export async function handleProxyHost(request: Request, env: ProxyEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  const parsed = parsePath(url.pathname)
  let seg = (parsed.provider ? [parsed.provider, ...(parsed.rest ? parsed.rest.split('/') : [])]
                             : [parsed.service ?? '', ...(parsed.arg ? [parsed.arg] : [])]).filter(Boolean)

  const pathProjectId = parsed.projectId
  const head = seg[0] ?? ''          // a service route (_health/_whoami/_key) or the provider the engine chose

  if (head === '_health') {
    // What the VAULT looks like from in here. A binding that is present but reads nothing, or a document that
    // will not decrypt, are the two failures worth naming rather than inferring from an empty candidate list.
    let vault: any = { bound: !!env.CREDENTIALS, masterKey: !!env.CREDENTIALS_MASTER_KEY }
    if (env.CREDENTIALS) {
      try {
        const raw = await env.CREDENTIALS.get('agent-credentials', 'text')
        vault.documentBytes = raw ? String(raw).length : 0
        const v = await vaultOf(env)
        vault.entries = v.entries.length
        vault.providers = [...new Set(v.entries.map((e: any) => e.provider))]
        // Named on the health check so it is visible to anything that polls, rather than only to someone who
        // thinks to look. An expired credential fails at the agent as something unrelated.
        const soon = expiring(v, 3)
        if (soon.length) vault.expiring = soon.map((e) => `${e.id} in ${e.inDays}d`)
      } catch (e: any) { vault.error = String(e?.message ?? e).slice(0, 120) }
    }
    return json({ ok: true, vault,
                  providers: (await Promise.all(Object.keys(CONTRACT).map(async p => (await keyOf(p, env)) ? p : null))).filter(Boolean),
                  tunnelOnly: Object.keys(CONTRACT).filter(p => CONTRACT[p].tunnelOnly) })
  }

  // Claimed, not yet proven. Whether that is enough depends entirely on what is being asked for.
  const project = pathProjectId ?? request.headers.get(PROJECT_HEADER)

  // The EC2 proxy has no Durable Object access, so it asks US whether a project key is genuine. One source of
  // truth (ProjectDO) for both implementations, rather than a second copy of the check on a second machine.
  if (head === '_verify') {
    const ok = await provenProject(env, project ?? '', sharedBearer((h) => request.headers.get(h)))
    return json({ ok, project: ok ? project : null }, ok ? 200 : 401)
  }

  if (head === '_whoami') {
    return project ? json({ project }) : json({ error: 'unknown or missing project token' }, 401)
  }

  // A key handed to a box is a key that has left our control, so it is refused unless that provider genuinely
  // cannot be proxied, and it is logged loudly enough to notice if it starts happening often.
  if (head === '_key') {
    // NOT the path token. Handing out a credential requires the project to PROVE it is that project, with the
    // API key it already holds, in a header — see provenProject. Without this, anyone who ever saw a URL in a
    // log could collect our provider keys.
    const projectId = project ?? ''
    if (!(await provenProject(env, projectId, bearerOf(request.headers)))) {
      console.log(`[proxy] KEY REFUSED for ${projectId || '(no project)'} — bad or missing project API key`)
      return json({ error: 'send the project API key as `Authorization: Bearer sk-proj-…`' }, 401)
    }
    const name = seg[1] ?? ''
    if (!CONTRACT[name]) return json({ error: `no provider named ${name}` }, 404)

    // THE VAULT FIRST. A box asking for a credential should get one that suits ITS project — its group's
    // subscription, and one that has not run out — rather than a single global key everyone shares. This is
    // the only rotation ChatGPT can ever have: the tunnel carries bytes it cannot read, so it can never
    // substitute a credential mid-flight the way the reverse path does. Choosing well here IS the mechanism.
    const vault = await vaultOf(env)
    const group = groupOf(vault, project!)
    const usable = candidates(vault, name, project!)
    if (usable.length) {
      const c = usable[0]
      const days = c.expiresAt ? Math.floor((c.expiresAt - Date.now()) / 86_400_000) : null
      console.log(`[proxy] KEY ISSUED ${name}/${c.id} → project ${project} (group ${group}${days !== null ? `, expires in ${days}d` : ''})`)
      // Ask the provider how much is left, off the response path and only when what we have has gone stale.
      // A figure nobody is looking at yet must never delay an agent's turn.
      if (env.CREDENTIALS) ctx.waitUntil(refreshIfStale(env.CREDENTIALS, c.id, c.provider, c.value))
      // The box is told when its credential dies, so it can re-ask before rather than after.
      return json({ provider: name, keyId: c.id, key: c.value, expiresAt: c.expiresAt ?? null })
    }

    // Nothing in the vault: fall back to the single configured key, so a provider works before anyone has
    // filled it in. Said out loud, because silently serving the shared key would hide that this project's
    // group has no capacity of its own.
    const key = await keyOf(name, env)
    if (!key) return json({ error: `no credential available for ${name}`, group, tried: vault.entries.filter(e => e.provider === name).length }, 503)
    console.log(`[proxy] KEY ISSUED ${name}/<unvaulted> → project ${project} (group ${group}; nothing in the vault matched)`)
    return json({ provider: name, keyId: null, key })
  }

  // The provider is NAMED by the caller: the engine already chose it. We look up its key and forward.
  const name = head
  const up = CONTRACT[name]
  if (!up) return json({ error: `unknown provider /${name}`, providers: Object.keys(CONTRACT) }, 404)
  // A provider the tunnel serves must not be relayed: the ChatGPT backend refuses anything relayed (403 from
  // a Worker, 302 from a Node reverse proxy, while the same request direct succeeds), so a call arriving here
  // is misrouted and is told where to go rather than left to fail as an upstream error.
  if (up.tunnelOnly || !up.base) {
    return json({ error: `${name} is served by the CONNECT tunnel, not by this proxy`, use: 'HTTPS_PROXY=<tunnel host>' }, 421)
  }

  // ── WHO IS CALLING, AND HOW WELL DO WE KNOW ─────────────────────────────────────────────────────────────
  // Two answers, and the stronger one is used whenever it is available.
  //
  //   AUTHENTICATED — the caller sent the project's own API key. pi and opencode set a provider key from the
  //   environment, so we simply put `sk-proj-…` in that variable and it arrives here as an ordinary bearer.
  //   Verified against ProjectDO, this is proof, and it is required because these calls spend OUR key.
  //
  //   IDENTIFIED ONLY — the path says which project, and nothing proves it. That is all claude-code can offer:
  //   its Authorization already carries its own subscription token, which we must forward untouched. Weaker,
  //   and acceptable here for one reason only — such a call is GIVEN nothing. It brings its own credential, so
  //   a forged path misattributes a meter reading rather than obtaining a key.
  //
  // The rule that falls out: WE ONLY SPEND OUR OWN KEY FOR AN AUTHENTICATED CALLER.
  const sent = sharedBearer((h) => request.headers.get(h))
  const proven = !!sent && /^sk-proj-/.test(sent) && await provenProject(env, project ?? '', sent)
  const verdict = decide({ projectId: project, sentCredential: sent, proven })
  if (!verdict.ok) return json({ error: verdict.error }, verdict.status)

  // The model is read only to LABEL the meter, never to route. Clone: a body can be read once.
  let model: string | undefined
  if (request.body) {
    try { model = (await request.clone().json() as any)?.model } catch { /* not JSON, or empty */ }
  }

  // ── WEBSOCKET: RELAY, DO NOT INTERPRET ──────────────────────────────────────────────────────────────────
  // pi's codex transport is "auto", which means WebSocket first and an HTTP POST only as a fallback. So the
  // normal, working path for that provider is a wss:// stream — and a proxy that speaks only HTTP forces the
  // fallback, which is the path that fails.
  //
  // Workers relay an upgrade natively: hand the request to fetch and return what comes back, upgrade and all.
  // We deliberately do NOT look inside. Nothing here parses frames, so a transport change upstream cannot
  // break us — which is the whole reason to relay rather than to stand in.
  //
  // The cost is metering: token counts live in the message stream, and we are not reading it. Byte-level
  // accounting is what this provider gets, which is the accepted trade for a path that keeps working.
  if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    const wsTarget = up.base + '/' + seg.slice(1).join('/') + url.search
    console.log(`[proxy] ${project} ${name} websocket → ${wsTarget}`)
    return fetch(wsTarget, request as any)
  }

  const headers = new Headers(request.headers)
  headers.delete(PROJECT_HEADER)     // our concern, not the provider's
  headers.delete('host')

  // THE CALLER'S OWN CREDENTIAL WINS. claude-code arrives holding its subscription token, and replacing it
  // would bill the wrong account and answer as the wrong identity. We supply a key only to a caller that has
  // none — which is the whole point for a box that holds no keys at all.
  // A caller holding its OWN provider credential keeps it: replacing claude-code's subscription token would
  // bill the wrong account and answer as the wrong identity. A caller holding OUR project key is asking us to
  // supply one — and only a PROVEN one gets that, because from here on it spends our money.
  if (verdict.attachKey) {
    const key = await keyOf(name, env)
    if (!key) return json({ error: `no key configured for ${name}` }, 503)
    headers.delete('authorization'); headers.delete('x-api-key')   // never forward our own project key upstream
    for (const [h, v] of Object.entries(up.header!(key))) if (!headers.has(h)) headers.set(h, v)
  }

  // The client's own path is forwarded as-is: it built a request for a real API and we are standing in
  // for that API, so rewriting its path would change the call it meant to make.
  const target = up.base + '/' + seg.slice(1).join('/') + url.search
  const t0 = Date.now()
  const res = await fetch(target, { method: request.method, headers, body: request.body, redirect: 'manual' })

  const rec = { project: project ?? 'unknown', provider: name, model, ms: 0, in: 0, out: 0 }
  if (!res.body) return res

  // A stream is metered as it flows; a plain JSON response is metered after the fact from a clone, so neither
  // path waits on the meter.
  const streaming = (res.headers.get('content-type') || '').includes('event-stream')
  if (streaming) {
    return new Response(teeForUsage(res.body, (u) => {
      meter(ctx, { ...rec, ms: Date.now() - t0, in: u?.in ?? 0, out: u?.out ?? 0 })
    }), { status: res.status, headers: res.headers })
  }

  const [a, b] = res.body.tee()
  ctx.waitUntil((async () => {
    try {
      const u = usageFrom(await new Response(b).json())
      meter(ctx, { ...rec, ms: Date.now() - t0, in: u?.in ?? 0, out: u?.out ?? 0 })
    } catch { /* a body we cannot read is not a reason to disturb the response */ }
  })())
  return new Response(a, { status: res.status, headers: res.headers })
}
