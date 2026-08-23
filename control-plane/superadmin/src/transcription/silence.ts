// ── Silence detection ────────────────────────────────────────────────────────
// Speech models hallucinate on silence: a chunk of digital quiet reliably comes back
// as "Oh", "Thank you", "you", or a stray subtitle credit. That is not a cosmetic
// problem here — a phantom word lands inside the user's QUESTION and changes what the
// engine is asked.
//
// The prompt cannot be trusted to prevent it, so we never ask. A chunk whose PCM is
// below the noise floor short-circuits to empty text: deterministic, free, and it also
// saves a provider call and ~2s of latency on every dead chunk the VAD flushes.

/** RMS below this is the noise floor, not speech (≈ -50 dBFS). */
const SILENCE_RMS = 0.003
/** A real utterance always has some peak above this, even whispered (≈ -40 dBFS). */
const SILENCE_PEAK = 0.01

/**
 * True when 16-bit PCM WAV audio carries no speech. Returns FALSE for anything it
 * cannot parse — an unreadable header must fall through to the model, never be
 * silently discarded as "silent".
 */
export function isSilentWav(buffer: ArrayBuffer): boolean {
  const pcm = readWavPcm16(buffer)
  if (!pcm || pcm.length === 0) return false

  let sumSquares = 0
  let peak = 0
  for (let i = 0; i < pcm.length; i++) {
    const sample = pcm[i] / 32768
    sumSquares += sample * sample
    const magnitude = sample < 0 ? -sample : sample
    if (magnitude > peak) peak = magnitude
  }
  const rms = Math.sqrt(sumSquares / pcm.length)
  return rms < SILENCE_RMS && peak < SILENCE_PEAK
}

/** Locate the `data` chunk of a RIFF/WAVE file and read it as Int16. */
function readWavPcm16(buffer: ArrayBuffer): Int16Array | null {
  if (buffer.byteLength < 44) return null
  const view = new DataView(buffer)
  const tag = (offset: number) =>
    String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1),
                        view.getUint8(offset + 2), view.getUint8(offset + 3))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null

  let bitsPerSample = 16
  // Walk the chunk list — `data` is not always at a fixed offset (LIST/fact chunks
  // appear ahead of it in files from some encoders).
  let offset = 12
  while (offset + 8 <= buffer.byteLength) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= buffer.byteLength) {
      bitsPerSample = view.getUint16(body + 14, true)
    }
    if (id === 'data') {
      if (bitsPerSample !== 16) return null          // only 16-bit PCM is analysed
      const available = Math.min(size, buffer.byteLength - body)
      const sampleCount = Math.floor(available / 2)
      if (sampleCount <= 0) return null
      const out = new Int16Array(sampleCount)
      for (let i = 0; i < sampleCount; i++) out[i] = view.getInt16(body + i * 2, true)
      return out
    }
    offset = body + size + (size % 2)                // chunks are word-aligned
  }
  return null
}
