// ── Metering and credits — what usage costs ─────────────────────────────────────────────────────────────────────────
//
// Usage is recorded where it happens (the model proxy sees every call's tokens) into the project's DO, append-only, and
// priced at that moment from the platform's price list — data a superadmin edits, never a constant in code. Costs are
// integer MICRO-credits (1 credit = 1,000,000), so sums never drift. An organisation that has been given credits is
// debited by its projects' usage; one that never has been is not on a credit plan and is not limited.

export const MICRO = 1_000_000

/** Credits per million tokens, for one provider and model ("*" for every model of the provider not named). */
export interface Price { provider: string; model: string; in_per_million: number; out_per_million: number }

export function checkPrices(v: unknown): string[] {
  if (!Array.isArray(v)) return ['a price list is a list of { provider, model, in_per_million, out_per_million }']
  const out: string[] = []
  const seen = new Set<string>()
  v.forEach((p: any, i) => {
    if (!p || typeof p.provider !== 'string' || !p.provider) out.push(`price ${i + 1} names its provider`)
    if (!p || typeof p.model !== 'string' || !p.model) out.push(`price ${i + 1} names its model (or "*")`)
    for (const k of ['in_per_million', 'out_per_million']) if (!(typeof p?.[k] === 'number' && p[k] >= 0 && Number.isFinite(p[k]))) out.push(`price ${i + 1}: ${k} is a number of credits, 0 or more`)
    const key = `${p?.provider}/${p?.model}`
    if (seen.has(key)) out.push(`${key} is priced twice`)
    seen.add(key)
  })
  return out
}

/** The price for a call: its model's, else its provider's "*", else none (and the call is recorded at no cost, said so). */
export function priceFor(prices: Price[], provider: string, model: string | undefined): Price | null {
  return prices.find((p) => p.provider === provider && p.model === model) ?? prices.find((p) => p.provider === provider && p.model === '*') ?? null
}

/** What a call costs, in micro-credits (rounded up: a call is never free because it was small). */
export function costOf(price: Price | null, tokensIn: number, tokensOut: number): number {
  if (!price) return 0
  return Math.ceil((tokensIn * price.in_per_million + tokensOut * price.out_per_million))   // per million tokens × MICRO / million = ×1
}
