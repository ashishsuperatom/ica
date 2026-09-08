// ── THE AGENT ROUTING CONTRACT — one table, three consumers, no second opinions ───────────────────────────
//
// Three separate programs need to agree about how an agent reaches its model:
//
//   the engine        (vm/apps/engine)              — points its clients at a proxy, or deliberately does not
//   the Worker proxy  (control-plane/superadmin)    — relays a request and attaches a key from the vault
//   the tunnel proxy  (agent-proxy, on EC2)         — opens a CONNECT socket and copies bytes
//
// They used to agree by each stating the same fact in its own words. "openai-codex is tunnelled, not
// relayed" appeared in FOUR places — a `tunnelOnly` flag here, a `TUNNELLED` set in pi.ts, a `HOSTS` array in
// proxy-dispatcher.ts, and a `TUNNEL_ALLOW` list in proxy.mjs. Nothing kept them honest with each other, and
// the failure from changing three of the four is a 421 that reads like a broken model rather than a missing
// edit. That is not a hypothetical: it happened, the composer produced nothing and escalated, and the cause
// took a while to find precisely because each file looked right on its own.
//
// So the ROUTE is declared once, here, and everything else is DERIVED. To move a provider between routes you
// edit one line and every consumer follows. There is no second place to remember.
//
// WHY THIS LIVES IN vm/packages. The engine's Docker image copies `vm/` and nothing else, so anything the
// engine must import has to be inside it — an earlier version of this file lived in agent-proxy/ and the
// engine could not reach it, which is exactly why the duplication started. The other two consumers have no
// such boundary: the Worker bundles from source across the repo, and the EC2 proxy is given a copy of this
// file at deploy time. The most constrained consumer decides where the shared thing lives.
//
// Pure functions, no imports, no runtime assumptions: the Worker bundles it, Node imports it directly.
//
// THE URL SHAPE, identical on both proxies, so moving a provider between them is one environment variable:
//
//   https://<proxy-host>/p/<projectId>/<provider>/<the client's own path>
//
// The project id is in the PATH because that is the only channel we control — agents build their own requests
// from a base URL and an API-key variable, and cannot be asked to send a header. It is an identifier, never a
// secret: paths reach access logs, so nothing that grants anything may live there.

export const PATH_PREFIX = 'p'
export const PROJECT_HEADER = 'x-superatom-project-id'   // for our own tooling, which can set headers

// ── THE ONE TABLE ────────────────────────────────────────────────────────────────────────────────────────
//
// `route` is the whole design, and there are exactly three:
//
//   'relay'   The Worker forwards the request and attaches a key from the vault. Our money, so the caller
//             must prove the project first. We see headers, so we can count tokens.
//
//   'tunnel'  A CONNECT socket; the TLS session is between the client and the real server, and we see only a
//             hostname and a byte count. Not a fallback for when relaying is inconvenient — the ChatGPT
//             backend REFUSES anything relayed (403 through a Worker, 302 through a Node reverse proxy, while
//             the same request direct succeeds), so for that provider this is the only route that exists.
//
//   'box'     Never proxied at all: the credential is handed to the machine and the client uses it directly.
//             claude-code refuses to make any request without a local login — with a clean HOME it prints
//             "Not logged in" and not one byte leaves — so there is nothing in flight to intercept. It still
//             belongs here, because a box fetching its own credential at boot is the thing that replaced
//             pasting one into every machine by hand.
//
// `hosts` is what the provider actually talks to. The tunnel's destination allowlist is the union of these:
// an open CONNECT proxy is a resource anyone on the internet can use once they find it, so the destination is
// checked as well as the caller, and a stolen credential then buys access to our model providers and nothing
// else.
export const PROVIDERS = {
  openrouter: {
    route: 'relay',
    // DISABLED, deliberately. Not "unused" — turned off, and the proxy refuses to relay it at all. It was
    // reached once by a forwarding path that fell back to an env var and spent a key kept for something else
    // entirely, which is the exact failure a disabled flag prevents: a stray config cannot quietly start
    // costing money on a provider nobody chose. Declared here so the refusal, the admin screen and the box
    // diagnostic all read the same decision instead of three guesses at it.
    disabled: 'not in use — every model is routed to a subscription instead',
    hosts: ['openrouter.ai'],
    base: 'https://openrouter.ai/api/v1',
    header: (key) => ({ authorization: `Bearer ${key}` }),
    envKey: 'OPENROUTER_API_KEY',
  },
  'opencode-go': {
    route: 'relay',
    hosts: ['opencode.ai'],
    base: 'https://opencode.ai/zen/go/v1',
    header: (key) => ({ authorization: `Bearer ${key}` }),
    envKey: 'OPENCODE_API_KEY',
  },
  anthropic: {
    route: 'relay',
    hosts: ['api.anthropic.com'],
    base: 'https://api.anthropic.com',
    header: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    envKey: 'ANTHROPIC_API_KEY',
  },
  'openai-codex': {
    route: 'tunnel',
    // chatgpt.com is the backend; auth.openai.com is where its token is refreshed — a tunnel that carries the
    // first but not the second fails at renewal, hours later, looking like an expiry.
    hosts: ['chatgpt.com', 'auth.openai.com', 'api.openai.com'],
  },
  'claude-code': {
    route: 'box',
    hosts: ['api.anthropic.com'],
    envVar: 'CLAUDE_CODE_OAUTH_TOKEN',
  },
}

// ── WHICH ACCOUNTS EACH HARNESS CAN REACH ────────────────────────────────────────────────────────────────
//
// A harness is HOW we drive a model; a provider is WHOSE ACCOUNT PAYS. They are independent axes but not a
// free grid: claude-code-pty drives a CLI that authenticates with its own subscription and can reach nothing
// else, and codex is the same story against ChatGPT. Only pi can be pointed at several accounts, because only
// pi takes a base URL and a key per model.
//
// Declared HERE with the routing it belongs to, so the superadmin editor can narrow its dropdowns and the
// engine can refuse an impossible pair, from one table rather than two opinions. Without it the editor
// cheerfully offered `claude-code-pty · opencode-go` — a combination that cannot exist, presented as a choice.
export const HARNESSES = {
  'claude-code-pty': { providers: ['claude-code'] },
  codex:             { providers: ['openai-codex'] },
  opencode:          { providers: ['opencode-go'] },
  pi:                { providers: ['opencode-go', 'openai-codex', 'anthropic', 'openrouter'] },
  mock:              { providers: [] },
}

/** Accounts this harness can be pointed at. Unknown harness ⇒ nothing, so a typo narrows rather than widens. */
export const providersForHarness = (harness) => HARNESSES[harness]?.providers ?? []

/** Can this harness use this account at all? The pair check both the editor and the engine apply. */
export const harnessCanUse = (harness, provider) => providersForHarness(harness).includes(provider)

/** Back-compat name for the relay table. The Worker reads `.base`/`.header` off these. */
export const UPSTREAMS = PROVIDERS

// ── DERIVED: nobody restates any of this ─────────────────────────────────────────────────────────────────

/** Turned off on purpose. A disabled provider is refused by both proxies rather than merely unrouted: an
 *  unrouted provider still relays if something asks for it, which is how a key gets spent by accident. */
export const isDisabled = (name) => !!PROVIDERS[name]?.disabled
export const disabledReason = (name) => PROVIDERS[name]?.disabled ?? null

/** Provider names on a given route. `providersOn('tunnel')` is what pi must NOT rewrite the URL for. */
export const providersOn = (route) =>
  Object.keys(PROVIDERS).filter((n) => PROVIDERS[n].route === route)

/** Hostnames reached by providers on a given route. The engine's dispatcher tunnels exactly these. */
export const hostsOn = (route) =>
  [...new Set(providersOn(route).flatMap((n) => PROVIDERS[n].hosts ?? []))]

/** Every host any known provider talks to — the CONNECT destination allowlist. */
export const allHosts = () =>
  [...new Set(Object.values(PROVIDERS).flatMap((p) => p.hosts ?? []))]

/** Providers whose credential must sit ON the machine, with the variable each client reads. */
export const boxSide = () =>
  providersOn('box').map((provider) => ({ provider, envVar: PROVIDERS[provider].envVar }))

/** Host matching, including subdomains. Written three separate times before this — identically, which is
 *  luck rather than design, since a mismatch here is either a hole in an allowlist or a route that silently
 *  stops applying. */
export const hostMatches = (host, list) => {
  const h = String(host || '').toLowerCase()
  return list.some((d) => h === d || h.endsWith('.' + d))
}

/** Split `/p/<projectId>/<provider>/<rest…>` into its parts. `service` is set for our own routes (_health,
 *  _whoami, _key, _diag), which are addressed the same way but handled before any forwarding. */
export function parsePath(pathname) {
  let seg = String(pathname).replace(/^\/+/, '').split('/')
  let projectId = null
  if (seg[0] === PATH_PREFIX && seg.length > 1) { projectId = seg[1]; seg = seg.slice(2) }
  const head = seg[0] ?? ''
  return {
    projectId,
    service: head.startsWith('_') ? head : null,
    provider: head.startsWith('_') ? null : head,
    rest: seg.slice(1).join('/'),
    arg: seg[1] ?? null,        // e.g. the provider named on /_key/<provider>
  }
}

/** The credential the caller sent, whichever header it chose. Agents can only populate their provider's own
 *  key variable, so this is where a project key arrives from pi or opencode. */
export const bearerOf = (get) => {
  const a = get('authorization')
  return (a ? a.replace(/^Bearer\s+/i, '') : get('x-api-key')) || null
}

export const isProjectKey = (v) => !!v && /^sk-proj-/.test(v)

/** WHO IS CALLING, AND HOW WELL DO WE KNOW — the one rule both proxies must apply identically.
 *
 *   authenticated  the caller sent the project's own API key, verified against ProjectDO. Required before we
 *                  spend a key of OURS, because from that point it is our money.
 *   identified     the path names a project and nothing proves it. All claude-code can offer, since its
 *                  Authorization already carries its own subscription token. Acceptable only because such a
 *                  call is GIVEN nothing: it brings its own credential, so a forged id misattributes a meter
 *                  reading rather than obtaining a key.
 *
 * Returns what to do, so neither implementation re-derives it. */
export function decide({ projectId, sentCredential, proven }) {
  const ours = isProjectKey(sentCredential)
  if (ours && !proven) return { ok: false, status: 401, error: 'project API key not valid for this project' }
  // A caller holding its OWN provider credential keeps it — replacing claude-code's subscription token would
  // bill the wrong account and answer as the wrong identity.
  if (sentCredential && !ours) return { ok: true, attachKey: false, project: projectId }
  if (!proven) return { ok: false, status: 401, error: 'send the project API key to use a provider key held here' }
  return { ok: true, attachKey: true, project: projectId }
}

/** Token counts, wherever a provider chose to put them. Shapes differ (OpenAI's `usage`, Anthropic's
 *  input/output names), so this reads the ones we know and reports nothing rather than a wrong number. */
export function usageFrom(obj) {
  const u = obj?.usage
  if (!u) return null
  const i = u.prompt_tokens ?? u.input_tokens
  const o = u.completion_tokens ?? u.output_tokens
  return (typeof i === 'number' || typeof o === 'number') ? { in: i ?? 0, out: o ?? 0 } : null
}

/** Usage from the tail of an SSE stream — the final frame carries it. Given a bounded tail, not the whole
 *  body, because buffering a response to count it would delay first-token latency, the one thing a user feels. */
export function usageFromSseTail(tail) {
  let found = null
  for (const line of String(tail).split('\n')) {
    const d = line.startsWith('data:') ? line.slice(5).trim() : ''
    if (!d || d === '[DONE]') continue
    try { const u = usageFrom(JSON.parse(d)); if (u) found = u } catch { /* a partial frame in the window */ }
  }
  return found
}
