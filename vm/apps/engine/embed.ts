// The concrete Embedder (@superatom/node-store's interface) — bge-small-en-v1.5 via fastembed. Local ONNX, no
// API, no per-call cost. This is the ONE model-specific/heavy piece; node-store stays dependency-light and the
// model swaps HERE in one place (change the model + dim; a mismatch re-indexes because the id is stamped).
//
// BGE is asymmetric: search queries and indexed passages get different prefixes — queryEmbed vs passageEmbed —
// which is why the Embedder interface carries `asQuery`.
import type { Embedder } from '@superatom/node-store'

const ID = 'bge-small-en-v1.5'
const DIM = 384

// fastembed (onnxruntime native + a ~130MB model) is imported LAZILY inside model() — merely importing this
// file can never crash a host that hasn't installed the native dep or downloaded the model yet; the failure
// surfaces on the first embed() call, where callers treat embedding as best-effort (degrade to FTS-only).
let init: Promise<any> | null = null
const model = () => (init ??= (async () => {
  const { FlagEmbedding, EmbeddingModel } = await import('fastembed')
  return FlagEmbedding.init({
    model: EmbeddingModel.BGESmallENV15,
    cacheDir: process.env.FASTEMBED_CACHE_DIR || '.fastembed',   // point at the volume in prod (persists across restarts)
  })
})())

export const bgeEmbedder: Embedder = {
  id: ID,
  dim: DIM,
  async embed(texts, opts) {
    const m = await model()
    const out: Float32Array[] = []
    if (opts?.asQuery) {
      // One call per text, which is what fastembed's queryEmbed does. Batching them into a single embed() with
      // the `query: ` prefix was tried and MEASURED: 24 spans took 1366ms one at a time and 1333ms batched —
      // no difference. The cost is the model inference per text (~55ms on CPU), not per-call overhead, and
      // fastembed does not parallelise across a batch. So the library's own API is used, and the prefix is not
      // duplicated here where it could silently drift out of step with theirs.
      //
      // The lever, if this ever matters, is FEWER TEXTS — a question's 2..4-grams are two dozen spans — or a
      // faster model. Not the loop.
      for (const t of texts) out.push(Float32Array.from(await m.queryEmbed(t)))
    } else {
      for await (const batch of m.passageEmbed(texts)) for (const v of batch) out.push(Float32Array.from(v))
    }
    return out
  },
}
