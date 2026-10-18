import { createHash } from 'node:crypto'

// Quantize a continuous signal into a named bucket, then hash -- so the
// identity of a situation never depends on the raw magnitude or on which
// literal field produced it, only on the shape it was classified into.
export function bucketSlope(slope: number, threshold: number): 'steep' | 'mild' {
  return slope <= threshold ? 'steep' : 'mild'
}

export function fingerprint(parts: unknown): string {
  const h = createHash('sha1')
  h.update(JSON.stringify(parts))
  return h.digest('hex').slice(0, 16)
}
