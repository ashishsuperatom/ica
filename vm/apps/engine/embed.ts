// The concrete Embedder (@superatom/node-store's interface) — bge-small-en-v1.5 via fastembed. Local ONNX, no
// API, no per-call cost. This is the ONE model-specific/heavy piece; node-store stays dependency-light and the
// model swaps HERE in one place (change the model + dim; a mismatch re-indexes because the id is stamped).
//
// BGE is asymmetric: search queries and indexed passages get different prefixes — queryEmbed vs passageEmbed —
// which is why the Embedder interface carries `asQuery`.
import { FlagEmbedding, EmbeddingModel } from 'fastembed'
import type { Embedder } from '@superatom/node-store'

const ID = 'bge-small-en-v1.5'
const DIM = 384

let init: Promise<InstanceType<typeof FlagEmbedding>> | null = null
const model = () => (init ??= FlagEmbedding.init({
  model: EmbeddingModel.BGESmallENV15,
  // Model files (~130MB) cache here. Point at the volume in prod (persists across restarts) via env.
  cacheDir: process.env.FASTEMBED_CACHE_DIR || '.fastembed',
}))

export const bgeEmbedder: Embedder = {
  id: ID,
  dim: DIM,
  async embed(texts, opts) {
    const m = await model()
    const out: Float32Array[] = []
    if (opts?.asQuery) {
      for (const t of texts) out.push(Float32Array.from(await m.queryEmbed(t)))
    } else {
      for await (const batch of m.passageEmbed(texts)) for (const v of batch) out.push(Float32Array.from(v))
    }
    return out
  },
}
