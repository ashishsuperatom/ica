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

export type ProviderId = 'openai-codex-responses' | 'opencode-go' | 'anthropic' | 'openrouter'

// The chains, most specific first. A model that matches nothing falls through to OpenRouter, which is the
// correct answer for a model we have not thought about: it is the account that carries almost everything.
const ROUTES: { name: string; match: RegExp; chain: ProviderId[] }[] = [
  // Luna is carried by BOTH the ChatGPT subscription and opencode-go, so it is the one model where the second
  // choice is another subscription rather than metered usage.
  { name: 'luna', match: /luna/i, chain: ['openai-codex-responses', 'opencode-go', 'openrouter'] },
  // DeepSeek is not on the ChatGPT subscription at all, so codex is not in this chain — asking it would be a
  // guaranteed miss, and a miss costs a round trip and an error before the fallback is tried.
  { name: 'deepseek', match: /deepseek/i, chain: ['opencode-go', 'openrouter'] },
  // Anthropic models go to Anthropic. NOTE this is the Anthropic API (an API key), NOT the Claude
  // subscription — that one belongs to the claude-code harness, which authenticates itself and never comes
  // through here.
  { name: 'anthropic', match: /^(anthropic\/)?claude[-.]/i, chain: ['anthropic', 'openrouter'] },
  // Everything else from OpenAI rides the ChatGPT subscription.
  { name: 'openai', match: /^(openai\/)?(gpt-|o\d|chatgpt)/i, chain: ['openai-codex-responses', 'openrouter'] },
]

const FALLBACK: ProviderId[] = ['openrouter']

/** The accounts that could serve this model, best first. Never empty. */
export function providersFor(model: string): ProviderId[] {
  return ROUTES.find(r => r.match.test(model))?.chain ?? FALLBACK
}

/** Is this account usable RIGHT NOW — do we hold a credential for it? Checked at selection time and never
 *  cached, because the codex credential is a file another process refreshes, and a value read at boot is how
 *  a long-running engine ends up choosing an account whose token died hours ago. */
export function available(p: ProviderId): boolean {
  switch (p) {
    case 'openai-codex-responses': return !!codexCredential()
    case 'opencode-go':            return !!process.env.OPENCODE_API_KEY
    case 'anthropic':              return !!process.env.ANTHROPIC_API_KEY
    case 'openrouter':             return !!process.env.OPENROUTER_API_KEY
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
  const why = r.skipped.length ? ` (no credential for ${r.skipped.join(', ')})` : ''
  return r.provider
    ? `${model} → ${r.provider}${why}`
    : `${model} → NOTHING AVAILABLE: tried ${r.chain.join(' → ')}, no credential for any`
}
