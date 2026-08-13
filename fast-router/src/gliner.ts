// GLiNER2 inference — intent classification + entity/param extraction. Node/ONNX, CPU-only (no CUDA,
// Linux-portable). ONE model instance behind a SERIAL queue: no matter how many suggests arrive, we
// only ever run one inference at a time (queue now; grow to a pool of workers later if needed).

import { GLiNER2ONNXRuntime } from '@lmoe/gliner-onnx'
import { INTENT_LABELS, type Intent, type IntentGuess } from './protocol.js'

const MODEL = process.env.GLINER_MODEL || 'lmo3/gliner2-multi-v1-onnx'

let _model: Promise<GLiNER2ONNXRuntime> | null = null
function getModel(): Promise<GLiNER2ONNXRuntime> {
  if (!_model) _model = GLiNER2ONNXRuntime.fromPretrained(MODEL)
  return _model
}

// Serial queue — one inference at a time (the single "inference endpoint" discipline).
let chain: Promise<unknown> = Promise.resolve()
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn) as Promise<T>
  chain = next.catch(() => {})
  return next
}

export interface Entity { text: string; label: string; score: number }

// Intent: multi-label read (all class scores) → argmax. Generic labels, no per-dataset phrases.
export async function classifyIntent(text: string): Promise<{ guess: IntentGuess; scores: Record<string, number> }> {
  if (!text.trim()) return { guess: { intent: 'unknown', confidence: 0 }, scores: {} }
  return queued(async () => {
    const model = await getModel()
    const raw = await model.classify(text, INTENT_LABELS as unknown as string[], { multiLabel: true, threshold: 0 }) as Record<string, number>
    const scores: Record<string, number> = {}
    for (const l of INTENT_LABELS) scores[l] = raw[l] ?? 0
    let best: Intent = 'unknown', bestScore = 0
    for (const l of INTENT_LABELS) if (scores[l] > bestScore) { best = l; bestScore = scores[l] }
    return { guess: { intent: bestScore > 0 ? best : 'unknown', confidence: bestScore }, scores }
  })
}

// Generic zero-shot classification over an ARBITRARY label set (the machine-to-machine `classify` task).
// Same warm model + serial queue as everything else — the model is loaded ONCE, tasks queue onto it.
export async function classify(
  text: string,
  labels: string[],
  opts: { multiLabel?: boolean; threshold?: number } = {},
): Promise<{ top: { label: string; score: number }; scores: Record<string, number> }> {
  if (!text.trim() || !labels.length) return { top: { label: '', score: 0 }, scores: {} }
  return queued(async () => {
    const model = await getModel()
    const raw = await model.classify(text, labels, { multiLabel: opts.multiLabel ?? false, threshold: opts.threshold ?? 0 }) as Record<string, number>
    let top = { label: '', score: 0 }
    for (const [l, s] of Object.entries(raw)) if (s > top.score) top = { label: l, score: s }
    return { top, scores: raw }
  })
}

// Entities/params — labels are PER-PROJECT (not hardcoded in the engine); caller passes them.
export async function extractEntities(text: string, labels: string[]): Promise<Entity[]> {
  if (!text.trim() || !labels.length) return []
  return queued(async () => {
    const model = await getModel()
    const ents = await model.extractEntities(text, labels)
    return ents.map((e: any) => ({ text: e.text, label: e.label, score: e.score }))
  })
}

export async function warmGliner(): Promise<void> { await classifyIntent('warmup') }
