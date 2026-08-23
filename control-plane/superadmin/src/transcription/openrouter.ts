import type { Transcriber, TranscribeEnv, TranscribeRequest, TranscribeResult } from './types.js'
import { TranscribeError } from './types.js'

// ── OpenRouter speech-to-text ────────────────────────────────────────────────
// OpenRouter has no dedicated /audio/transcriptions endpoint; audio goes through the
// OpenAI-compatible chat-completions API as an `input_audio` content part, which any
// audio-capable model accepts. That is why this reads as a chat call rather than a
// transcription call — the shape is the provider's, not ours.
//
// The model is a config value, never a constant: a Gemini flash for fast multilingual
// work today, a Groq Whisper tomorrow, chosen per deployment via TRANSCRIBE_MODEL.

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

/**
 * Default model. `flash-lite` over `flash` deliberately: measured over repeated runs,
 * plain `flash` returns a null completion for some non-English audio roughly 80% of the
 * time (German: 2/10 succeeded) while `flash-lite` was 5/5 on every sample tested, and
 * is cheaper. `flash` is ~1.5s faster on English and is the better pick for an
 * English-only deployment — it is one env var away (TRANSCRIBE_MODEL).
 */
export const DEFAULT_MODEL = 'google/gemini-2.5-flash-lite'

/**
 * Attempts per chunk when the provider returns a null/empty completion. This is a real,
 * observed failure mode — the API answers 200 with `content: null` and
 * `finish_reason: "stop"` — and it is transient, so an immediate retry usually succeeds.
 * Silent audio never reaches here (see silence.ts), so an empty completion always means
 * the provider failed rather than the audio being blank.
 */
const MAX_ATTEMPTS = 3

/** Anything above this is a bug upstream, not a long question — 25 MB is ~13 min of 16 kHz mono WAV. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024

/// The instruction matters as much as the model. It must transcribe, never answer:
/// a spoken question like "what were sales last month" must come back as those words,
/// not as an attempt at the answer.
const SYSTEM_PROMPT = [
  'You are a speech-to-text engine. Transcribe the audio verbatim.',
  'Return ONLY the transcription text — no preamble, no quotes, no commentary, no translation.',
  'If the audio contains a question, transcribe the question; never answer it.',
  'Preserve the speaker\'s language. If the audio is silent or unintelligible, return an empty string.',
].join(' ')

export const openRouterTranscriber: Transcriber = {
  name: 'openrouter',

  async transcribe(req: TranscribeRequest, env: TranscribeEnv): Promise<TranscribeResult> {
    const key = env.OPENROUTER_API_KEY
    if (!key) throw new TranscribeError('transcription is not configured', 503, 'OPENROUTER_API_KEY is unset')

    const model = env.TRANSCRIBE_MODEL || DEFAULT_MODEL
    const started = Date.now()

    const userParts: unknown[] = [
      { type: 'text', text: req.language ? `Transcribe this audio. Expected language: ${req.language}.` : 'Transcribe this audio.' },
      { type: 'input_audio', input_audio: { data: base64(req.audio), format: req.format } },
    ]

    let lastDetail = ''
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const text = await attemptOnce()
      if (text !== null) {
        return {
          text: text.trim(),
          model,
          chunkIndex: req.chunkIndex,
          questionId: req.questionId,
          isFinal: req.isFinal,
          ms: Date.now() - started,
        }
      }
    }
    throw new TranscribeError('transcription provider returned no text', 502, lastDetail)

    /// One round trip. Returns null when the provider answered but produced no text,
    /// which the loop above retries; throws for anything genuinely terminal.
    async function attemptOnce(): Promise<string | null> {
    let response: Response
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          // OpenRouter attribution headers — identify the calling app in their dashboard.
          'http-referer': 'https://superatom.site',
          'x-title': 'Superatom',
        },
        body: JSON.stringify({
          model,
          temperature: 0,          // transcription is not a creative task
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userParts },
          ],
        }),
      })
    } catch (err) {
      // A network failure is retryable — the caller's outbox will send this chunk again.
      throw new TranscribeError('transcription provider unreachable', 502, String(err))
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500)
      // 4xx from the provider is OUR bad request; 5xx and 429 are worth retrying.
      const status = response.status === 429 || response.status >= 500 ? 502 : 400
      throw new TranscribeError(`transcription failed (${response.status})`, status, detail)
    }

    const body = await response.json().catch(() => null) as any
    const text = extractText(body)
    if (text === null || text.trim() === '') {
      lastDetail = JSON.stringify(body ?? {}).slice(0, 500)
      return null
    }
    return text
    }
  },
}

/// Content can come back as a plain string or as an array of parts depending on the
/// model. Tolerate both rather than assuming one provider's current shape.
function extractText(body: any): string | null {
  const content = body?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const joined = content
      .map((part: any) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('')
    return joined
  }
  return null
}

/// Base64 for the request body. Chunked deliberately: String.fromCharCode(...bytes)
/// on a multi-megabyte buffer blows the argument limit and throws.
function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
