// ── WHICH ACCOUNT PAYS FOR THIS MODEL ────────────────────────────────────────────────────────────────────
// A model is not tied to one supplier. The same model is often reachable through several accounts we hold,
// and which one we should use is a question about BILLING and AVAILABILITY, not about capability.
//
// So routing is MODEL-FIRST: name the model, get an ordered list of the accounts that can serve it, and take
// the first one whose credential is actually present. Pinning a provider globally (ICA_PI_PROVIDER=…) is the
// wrong shape — it forces every model onto one account, including models that account does not carry, and it
// silently ties an agent to whichever credential happens to expire first.
//
// THE ORDER IS A BILLING PREFERENCE, not a quality one. Subscriptions we already pay for come first;
// OpenRouter is metered per token, so it is where everything ends up when nothing cheaper is available. That
// is why it terminates every chain rather than appearing in the middle of any of them.

import { codexCredential } from './pi.js'

export type ProviderId = 'openai-codex' | 'opencode-go' | 'anthropic' | 'openrouter'

// THE CHAINS. Subscriptions we already pay for, and nothing else.
//
// OpenRouter is deliberately absent. It was the universal fallback and it is not wanted: metered usage that
// nobody chose is exactly the surprise this whole system exists to prevent. A model with no account behind it
// FAILS, and says which accounts it tried — which is information, where a silent fallback is a bill.
//
// Claude models are not here either, and that is not an omission. `claude-sonnet-5` is served by the
// CLAUDE-CODE harness, which authenticates with its own subscription token on the box; it never comes through
// this table, which only decides which account PI should use.
const ROUTES: { name: string; match: RegExp; chain: ProviderId[] }[] = [
  // Luna is carried by BOTH subscriptions, so it is the one model with a real second choice.
  { name: 'luna', match: /luna/i, chain: ['openai-codex', 'opencode-go'] },
  // DeepSeek is not on the ChatGPT subscription at all, so codex is not in this chain — asking would be a
  // guaranteed miss, and a miss costs a round trip and an error before anything else is tried.
  { name: 'deepseek', match: /deepseek/i, chain: ['opencode-go'] },
  // Everything else from OpenAI rides the ChatGPT subscription.
  { name: 'openai', match: /^(openai\/)?(gpt-|o\d|chatgpt)/i, chain: ['openai-codex'] },
]

// No universal fallback. A model nobody has routed is a decision to make, not one to make silently — and
// OpenRouter, which used to sit here, is metered usage nobody chose.
const FALLBACK: ProviderId[] = []

/** The accounts that could serve this model, best first. EMPTY when nothing is routed for it. */
export function providersFor(model: string): ProviderId[] {
  return ROUTES.find(r => r.match.test(model))?.chain ?? FALLBACK
}

/** Is this account REACHABLE right now?
 *
 *  Not "does this box hold the key" — it deliberately does not, and asking that was a real bug: once
 *  credentials moved into the vault, every box answered "no" to everything and routing fell through to a
 *  provider nobody wanted. Reachable means the proxy can supply it, and if the vault has nothing the proxy
 *  says so plainly with a 503 naming the provider.
 *
 *  The exception is a credential the box must hold ITSELF: codex authenticates from ~/.codex/auth.json,
 *  because the ChatGPT backend refuses relayed requests. That one is still a local question, and it is asked
 *  every time rather than cached — the file is refreshed by another process, and a value read at boot is how
 *  a long-running engine ends up choosing an account whose token died hours ago. */
export function available(p: ProviderId): boolean {
  const proxied = !!process.env.SUPERATOM_PLATFORM
  switch (p) {
    case 'openai-codex': return !!codexCredential()
    case 'opencode-go':  return proxied || !!process.env.OPENCODE_API_KEY
    case 'anthropic':    return proxied || !!process.env.ANTHROPIC_API_KEY
    case 'openrouter':   return proxied || !!process.env.OPENROUTER_API_KEY
  }
}

export interface Resolution {
  provider: ProviderId | null   // null = we hold no credential for anything that carries this model
  chain: ProviderId[]           // what was considered, in order
  skipped: ProviderId[]         // considered and passed over for want of a credential — the useful half of a log line
}

/** Pick the account to use for a model. Reports what it skipped as well as what it chose: "pi is on OpenRouter"
 *  is not actionable, but "pi is on OpenRouter because the codex credential is missing" is. */
export function resolveProvider(model: string): Resolution {
  const chain = providersFor(model)
  const skipped: ProviderId[] = []
  for (const p of chain) {
    if (available(p)) return { provider: p, chain, skipped }
    skipped.push(p)
  }
  return { provider: null, chain, skipped }
}

/** One line for the log, said the same way every time so it can be grepped and diffed across boxes. */
export function describeResolution(model: string, r: Resolution): string {
  if (r.provider) {
    const why = r.skipped.length ? ` (no credential for ${r.skipped.join(', ')})` : ''
    return `${model} → ${r.provider}${why}`
  }
  // An empty chain and an exhausted one are different problems and need different sentences: one is "nobody
  // routed this model", the other is "every account that could serve it is unavailable".
  if (!r.chain.length) {
    const claude = /^(anthropic\/)?claude[-.]/i.test(model)
    return claude
      ? `${model} → NOT A PI MODEL: Claude models are served by the claude-code harness, which uses its own subscription token`
      : `${model} → NO ROUTE: no account is configured to serve it (add one in ROUTES, or use a model that is)`
  }
  return `${model} → NOTHING AVAILABLE: tried ${r.chain.join(' → ')}, no credential for any`
}
