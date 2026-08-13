// Sentence embeddings for semantic match — all-MiniLM-L6-v2 (384-dim) via transformers.js, CPU/ONNX.
// Node-only, no Python, no CUDA. One shared model instance; calls are serialized through a tiny queue
// so we never run two inferences at once (same discipline we'll apply to GLiNER).

import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'

export const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const EMBED_DIM = 384

let _pipe: Promise<FeatureExtractionPipeline> | null = null
function getPipe(): Promise<FeatureExtractionPipeline> {
  if (!_pipe) _pipe = pipeline('feature-extraction', EMBED_MODEL) as Promise<FeatureExtractionPipeline>
  return _pipe
}

// Serial queue — one embedding at a time.
let chain: Promise<unknown> = Promise.resolve()
export function embed(text: string): Promise<number[]> {
  const run = async () => {
    const pipe = await getPipe()
    const out = await pipe(text, { pooling: 'mean', normalize: true })
    return Array.from(out.data as Float32Array)
  }
  const next = chain.then(run, run)
  chain = next.catch(() => {})
  return next
}

// Warm the model (downloads on first use) so the first real query isn't slow.
export async function warmEmbed(): Promise<void> { await embed('warmup') }
