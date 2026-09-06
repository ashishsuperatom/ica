// THE PROXY CONTRACT — the rules, in one file, imported by both implementations.
//
// There are two proxies on purpose: a Cloudflare Worker (primary — global, no ops) and this Node server on
// EC2 (secondary, and the only one that can carry a CONNECT tunnel). Neither may become a single point of
// failure for every agent on every project, so both exist. But two copies of a rule is how one gets fixed and
// the other does not, so the RULES live here and each side only supplies its runtime's plumbing.
//
// Pure functions, no imports, no runtime assumptions: the Worker bundles it with esbuild, Node imports it
// directly.
//
// THE URL SHAPE, identical on both, so moving a provider between them is one environment variable:
//
//   https://<proxy-host>/p/<projectId>/<provider>/<the client's own path>
//
// The project id is in the PATH because that is the only channel we control — agents build their own requests
// from a base URL and an API-key variable, and cannot be asked to send a header. It is an identifier, never a
// secret: paths reach access logs, so nothing that grants anything may live there.

export const PATH_PREFIX = 'p'
export const PROJECT_HEADER = 'x-superatom-project-id'   // for our own tooling, which can set headers

/** Where each provider really lives, and how it wants its key. Providers disagree about the header, and
 *  guessing wrongly yields a 401 that reads like a bad key rather than a bad guess. */
export const UPSTREAMS = {
  openrouter: {
    base: 'https://openrouter.ai/api/v1',
    header: (key) => ({ authorization: `Bearer ${key}` }),
    envKey: 'OPENROUTER_API_KEY',
  },
  'opencode-go': {
    base: 'https://opencode.ai/zen/go/v1',
    header: (key) => ({ authorization: `Bearer ${key}` }),
    envKey: 'OPENCODE_API_KEY',
  },
  anthropic: {
    base: 'https://api.anthropic.com',
    header: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    envKey: 'ANTHROPIC_API_KEY',
  },
  // The ChatGPT backend. Present so the ROUTE is understood and reported honestly, with no key of ours: the
  // backend refuses a request relayed by anything — a Worker got 403 and a Node reverse proxy got 302 where
  // the same request direct got through — so this provider is served by the CONNECT tunnel, not by relaying.
  // Keeping it here means a misrouted call says "use the tunnel" instead of "unknown provider".
  'openai-codex': { base: null, tunnelOnly: true },
}

/** Split `/p/<projectId>/<provider>/<rest…>` into its parts. `service` is set for our own routes (_health,
 *  _whoami, _key), which are addressed the same way but handled before any forwarding. */
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

/** WHO IS CALLING, AND HOW WELL DO WE KNOW — the one rule both sides must apply identically.
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
