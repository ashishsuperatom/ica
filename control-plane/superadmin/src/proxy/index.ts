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

export interface ProxyEnv {
  // Verifying a project's API key is ProjectDO's job — it is the source of truth and can revoke. We never
  // keep a second copy of a key here to compare against.
  PROJECT?: { get(id: DurableObjectId): { fetch(req: Request): Promise<Response> }; idFromName(name: string): DurableObjectId }
  // Provider keys — Worker secrets, never sent to a box.
  OPENROUTER_API_KEY?: string
  OPENCODE_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  // Which project each box token belongs to: {"<token>":"<projectId>"}. A secret for now, deliberately: it
  // makes the whole path testable before choosing where tokens should really live, and moving to D1 or
  // ProjectDO later changes only `projectOf` below.
  PROXY_TOKENS?: string
}

// ── HOW A BOX IDENTIFIES ITSELF ──────────────────────────────────────────────────────────────────────────
// THE AGENTS BUILD THEIR OWN REQUESTS. We do not. pi, opencode and claude-code each take a base URL and an
// API-key env var and construct everything else themselves, so the only two things we can influence are those
// two values. A custom header is unreachable — there is no way to ask any of them to send one.
//
// So the project token rides in the BASE URL PATH, which every client appends its own path to:
//
//   https://proxy.superatom.site/p/<project-token>/<provider>
//
// claude-code then requests /p/<tok>/anthropic/v1/messages, pi requests
// /p/<tok>/openrouter/chat/completions, and neither had to be taught anything.
//
// This matters most for the client we CANNOT re-credential: claude-code arrives holding its own subscription
// token in Authorization, which we must forward untouched. Identity in the path means we still know which
// project is calling without touching that header.
//
// A token in a URL is a secret in a path, so it is project-scoped, revocable on its own, and worth keeping out
// of access logs. The header form is kept as a convenience for our own tooling, which can set headers.
const PROJECT_HEADER = 'x-superatom-project-token'
const PATH_PREFIX = 'p'

interface Upstream {
  base: string
  /** Put the provider key on a request that arrived without one. Providers disagree about the header, and
   *  guessing wrongly yields a 401 that reads like a bad key rather than a bad guess. */
  auth: (h: Headers, key: string) => void
  keyOf: (env: ProxyEnv) => string | undefined
}

// THE PROXY IS DELIBERATELY DUMB. It knows keys and it counts tokens. It does NOT decide which account should
// serve a model — the ENGINE decides that (ica/providers.ts) and names the provider in the URL it calls.
//
// That split is on purpose. The engine knows what it is trying to do, which credentials the box actually
// holds, and what to fall back to when one fails; reproducing any of that here would be a second, divergent
// copy of a decision already made, in a place with less information. A proxy that routes is a proxy you have
// to debug when the answer is wrong.
const UPSTREAMS: Record<string, Upstream> = {
  openrouter: {
    base: 'https://openrouter.ai/api/v1',
    auth: (h, k) => h.set('authorization', `Bearer ${k}`),
    keyOf: (e) => e.OPENROUTER_API_KEY,
  },
  'opencode-go': {
    base: 'https://opencode.ai/zen/go/v1',
    auth: (h, k) => h.set('authorization', `Bearer ${k}`),
    keyOf: (e) => e.OPENCODE_API_KEY,
  },
  anthropic: {
    base: 'https://api.anthropic.com',
    auth: (h, k) => { h.set('x-api-key', k); if (!h.has('anthropic-version')) h.set('anthropic-version', '2023-06-01') },
    keyOf: (e) => e.ANTHROPIC_API_KEY,
  },
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json' } })

/** Which project is calling? The seam that will become a real lookup — everything else is written not to care. */
function projectOf(env: ProxyEnv, token: string | null): string | null {
  if (!token) return null
  try {
    const map = JSON.parse(env.PROXY_TOKENS || '{}') as Record<string, string>
    return map[token] ?? null
  } catch { return null }
}

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
    const res = await stub.fetch(new Request('http://do/auth', {
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
  let seg = url.pathname.replace(/^\/+/, '').split('/')

  // /p/<token>/... — pull the project token out of the path and carry on as if the rest were the whole URL, so
  // every route below is written once and does not care how the caller identified itself.
  let pathToken: string | null = null
  if (seg[0] === PATH_PREFIX && seg.length > 1) { pathToken = seg[1]; seg = seg.slice(2) }
  const head = seg[0] ?? ''          // a service route (_health/_whoami/_key) or the provider the engine chose

  if (head === '_health') {
    return json({ ok: true, providers: Object.keys(UPSTREAMS).filter(p => UPSTREAMS[p].keyOf(env)) })
  }

  const token = pathToken ?? request.headers.get(PROJECT_HEADER)
  const project = projectOf(env, token)

  if (head === '_whoami') {
    return project ? json({ project }) : json({ error: 'unknown or missing project token' }, 401)
  }

  // A key handed to a box is a key that has left our control, so it is refused unless that provider genuinely
  // cannot be proxied, and it is logged loudly enough to notice if it starts happening often.
  if (head === '_key') {
    // NOT the path token. Handing out a credential requires the project to PROVE it is that project, with the
    // API key it already holds, in a header — see provenProject. Without this, anyone who ever saw a URL in a
    // log could collect our provider keys.
    const projectId = pathToken ?? ''
    if (!(await provenProject(env, projectId, bearerOf(request.headers)))) {
      console.log(`[proxy] KEY REFUSED for ${projectId || '(no project)'} — bad or missing project API key`)
      return json({ error: 'send the project API key as `Authorization: Bearer sk-proj-…`' }, 401)
    }
    const project = projectId
    const name = seg[1] ?? ''
    const up = UPSTREAMS[name]
    if (!up) return json({ error: `no provider named ${name}` }, 404)
    const key = up.keyOf(env)
    if (!key) return json({ error: `no key configured for ${name}` }, 503)
    console.log(`[proxy] KEY ISSUED ${name} → project ${project}`)
    return json({ provider: name, key })
  }

  // The provider is NAMED by the caller: the engine already chose it. We look up its key and forward.
  const name = head
  const up = UPSTREAMS[name]
  if (!up) return json({ error: `unknown provider /${name}`, providers: Object.keys(UPSTREAMS) }, 404)
  if (!project) return json({ error: `no project token — call /${PATH_PREFIX}/<token>/${name}/…` }, 401)

  // The model is read only to LABEL the meter, never to route. Clone: a body can be read once.
  let model: string | undefined
  if (request.body) {
    try { model = (await request.clone().json() as any)?.model } catch { /* not JSON, or empty */ }
  }

  const headers = new Headers(request.headers)
  headers.delete(PROJECT_HEADER)     // our concern, not the provider's
  headers.delete('host')

  // THE CALLER'S OWN CREDENTIAL WINS. claude-code arrives holding its subscription token, and replacing it
  // would bill the wrong account and answer as the wrong identity. We supply a key only to a caller that has
  // none — which is the whole point for a box that holds no keys at all.
  const hasOwn = headers.has('authorization') || headers.has('x-api-key')
  if (!hasOwn) {
    const key = up.keyOf(env)
    if (!key) return json({ error: `no key configured for ${head}` }, 503)
    up.auth(headers, key)
  }

  // The client's own path is forwarded as-is: it built a request for a real API and we are standing in
  // for that API, so rewriting its path would change the call it meant to make.
  const target = up.base + '/' + seg.slice(1).join('/') + url.search
  const t0 = Date.now()
  const res = await fetch(target, { method: request.method, headers, body: request.body, redirect: 'manual' })

  const rec = { project, provider: name, model, ms: 0, in: 0, out: 0 }
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
