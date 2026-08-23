// ── Transcription module — shared types ──────────────────────────────────────
// Self-contained: nothing outside src/transcription/ imports from here except the
// single route line in worker.ts.

/** Bindings this module needs. Declared here so the module documents its own config. */
export interface TranscribeEnv {
  /** OpenRouter API key. Set with: wrangler secret put OPENROUTER_API_KEY */
  OPENROUTER_API_KEY?: string
  /** Model override. Defaults to DEFAULT_MODEL below — any audio-capable OpenRouter model. */
  TRANSCRIBE_MODEL?: string
  /** Platform JWT signing secret (already used elsewhere in the worker). */
  JWT_SECRET: string
}

/** Verifies a platform JWT. Injected by the worker so auth logic lives in ONE place. */
export type VerifyToken = (token: string, secret: string) => Promise<{ userId: string } | null>

/** One VAD-segmented piece of a spoken question. */
export interface TranscribeRequest {
  audio: ArrayBuffer
  mimeType: string
  format: 'wav' | 'mp3' | 'ogg' | 'flac' | 'm4a'
  sessionId?: string
  questionId?: string
  chunkIndex: number
  isFinal: boolean
  durationMs?: number
  /** BCP-47 hint, e.g. "en", "hi". Omitted ⇒ the model detects the language itself. */
  language?: string
}

export interface TranscribeResult {
  text: string
  model: string
  chunkIndex: number
  questionId?: string
  isFinal: boolean
  /** Provider round-trip in ms — the number that decides whether this stays fast enough. */
  ms: number
}

/** A speech-to-text backend. Swapping OpenRouter for direct Groq means adding one of these. */
export interface Transcriber {
  readonly name: string
  transcribe(req: TranscribeRequest, env: TranscribeEnv): Promise<TranscribeResult>
}

export class TranscribeError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: string) {
    super(message)
    this.name = 'TranscribeError'
  }
}
