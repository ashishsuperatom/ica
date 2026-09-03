// ── Audio transcription — the module's ONLY entry point ──────────────────────
// worker.ts imports exactly one symbol from here (handleTranscribe) and wires it to
// one route. Everything else about speech-to-text lives inside this folder.

import { openRouterTranscriber, MAX_AUDIO_BYTES } from './openrouter.js'
import { isSilentWav } from './silence.js'
import { TranscribeError } from './types.js'
import type { TranscribeEnv, TranscribeRequest, Transcriber, VerifyToken } from './types.js'

export type { TranscribeEnv, TranscribeResult, Transcriber } from './types.js'

/** The active backend. Swapping providers is a one-line change here. */
const transcriber: Transcriber = openRouterTranscriber

const FORMATS: Record<string, TranscribeRequest['format']> = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/ogg': 'ogg', 'audio/flac': 'flac',
  'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a',
}

/**
 * POST /api/transcribe — one VAD-segmented audio chunk in, its text out.
 *
 * Audio takes this HTTP path rather than the hub WebSocket on purpose: it is bulk
 * binary, it is per-chunk independent, and a failed chunk must be retryable on its
 * own without disturbing a live socket. Everything else a client says still goes
 * over the WebSocket.
 *
 * multipart/form-data:
 *   audio        (required) the chunk — wav/mp3/ogg/flac/m4a
 *   chunkIndex   (required) 0-based; the CLIENT reassembles in this order, never arrival order
 *   questionId   (optional) the qid this chunk belongs to
 *   sessionId    (optional) conversation the question belongs to
 *   isFinal      (optional) "true" when this is the last chunk of the question
 *   durationMs   (optional) speech duration, for telemetry
 *   language     (optional) BCP-47 hint; omitted ⇒ the model detects it
 *
 * → 200 { text, model, chunkIndex, questionId, isFinal, ms }
 *
 * Callers must treat 502/503 as RETRYABLE and 400/401 as terminal.
 */
export async function handleTranscribe(
  request: Request,
  env: TranscribeEnv,
  verifyToken: VerifyToken,
): Promise<Response> {
  try {
    // Same platform JWT as every other authenticated surface. The verifier is injected
    // by the worker so this module never carries a second copy of the auth rules.
    const bearer = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)
    if (!bearer) return problem('missing bearer token', 401)
    const claims = await verifyToken(bearer[1], env.JWT_SECRET)
    if (!claims) return problem('invalid or expired token', 401)

    const contentType = request.headers.get('content-type') || ''
    if (!contentType.includes('multipart/form-data')) {
      return problem('expected multipart/form-data', 415)
    }

    const form = await request.formData()
    const file = form.get('audio')
    if (!(file instanceof File)) return problem('missing "audio" file part', 400)
    if (file.size === 0) return problem('audio is empty', 400)
    if (file.size > MAX_AUDIO_BYTES) {
      return problem(`audio exceeds ${Math.floor(MAX_AUDIO_BYTES / 1024 / 1024)}MB`, 413)
    }

    const declared = (file.type || '').toLowerCase()
    // Fall back to wav: the recorder emits 16 kHz mono WAV, and some multipart encoders
    // drop the part's content-type entirely.
    const format = FORMATS[declared] ?? 'wav'

    const chunkIndexRaw = str(form.get('chunkIndex'))
    const chunkIndex = chunkIndexRaw === undefined ? 0 : Number(chunkIndexRaw)
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      return problem('chunkIndex must be a non-negative integer', 400)
    }

    const audio = await file.arrayBuffer()

    // A silent chunk never reaches the model: speech models hallucinate words on quiet
    // audio, and a phantom word inside a QUESTION changes what gets asked. Also saves
    // a provider call and ~2s on every dead chunk the VAD flushes. See silence.ts.
    if (format === 'wav' && isSilentWav(audio)) {
      return Response.json({
        text: '', model: 'silence-detector', chunkIndex,
        questionId: str(form.get('questionId')),
        isFinal: str(form.get('isFinal')) === 'true', ms: 0,
      })
    }

    const result = await transcriber.transcribe({
      audio,
      mimeType: declared || 'audio/wav',
      format,
      chunkIndex,
      isFinal: str(form.get('isFinal')) === 'true',
      questionId: str(form.get('questionId')),
      sessionId: str(form.get('sessionId')),
      durationMs: numberOrUndefined(str(form.get('durationMs'))),
      language: str(form.get('language')),
    }, env)

    return Response.json(result)
  } catch (err) {
    if (err instanceof TranscribeError) {
      console.log('[transcribe] error', err.status, err.message, err.detail ?? '')
      return problem(err.message, err.status, err.detail)
    }
    console.log('[transcribe] unexpected', String(err))
    return problem('transcription failed', 500)
  }
}

function str(value: File | string | null): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/// Errors carry `retryable` so a client's outbox knows whether to try this chunk
/// again or give up — the difference between a lost question and a slow one.
function problem(message: string, status: number, detail?: string): Response {
  return Response.json(
    { error: message, detail, retryable: status === 429 || status === 502 || status === 503 },
    { status },
  )
}
