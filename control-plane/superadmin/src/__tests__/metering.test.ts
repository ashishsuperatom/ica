import { describe, expect, it } from 'vitest'
import { checkPrices, costOf, priceFor, MICRO } from '../metering'

describe('metering', () => {
  const prices = [{ provider: 'opencode-go', model: 'gpt-6-luna', in_per_million: 2, out_per_million: 8 }, { provider: 'opencode-go', model: '*', in_per_million: 1, out_per_million: 1 }]
  it('a price list is checked in sentences', () => {
    expect(checkPrices(prices)).toEqual([])
    expect(checkPrices([{ provider: 'a', model: 'b', in_per_million: -1, out_per_million: 1 }, { provider: 'a', model: 'b', in_per_million: 1, out_per_million: 1 }])).toEqual(['price 1: in_per_million is a number of credits, 0 or more', 'a/b is priced twice'])
  })
  it('a call is priced by its model, else its provider, in integer micro-credits rounded up', () => {
    expect(priceFor(prices, 'opencode-go', 'gpt-6-luna')!.in_per_million).toBe(2)
    expect(priceFor(prices, 'opencode-go', 'other')!.model).toBe('*')
    expect(priceFor(prices, 'anthropic', 'x')).toBeNull()
    // 1M tokens in at 2 credits/M and 0.5M out at 8 credits/M = 2 + 4 = 6 credits
    expect(costOf(priceFor(prices, 'opencode-go', 'gpt-6-luna'), 1_000_000, 500_000)).toBe(6 * MICRO)
    expect(costOf(priceFor(prices, 'opencode-go', 'gpt-6-luna'), 1, 0)).toBe(2)          // 2 micro-credits: tiny, not free
    expect(costOf(null, 1000, 1000)).toBe(0)
  })
})
