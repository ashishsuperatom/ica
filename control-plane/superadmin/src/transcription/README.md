# Transcription module — speech to text

Self-contained speech-to-text for voice clients. **The worker touches this module in
exactly two lines**: one import and one route (`POST /api/transcribe`). Everything
else about transcription lives in this folder.

## Why audio is HTTP and not the WebSocket

Every other client↔engine message goes over the hub WebSocket. Audio does not:

- it is bulk binary, and base64 on a socket that also carries live analyst narration
  makes both worse;
- each chunk is independent, so a failed one must be retryable **on its own** without
  disturbing a live connection;
- the result is just text, which is then asked as an ordinary `analyse` question over
  the socket — so nothing downstream ever knows the question was spoken.

## Shape

```
POST /api/transcribe
Authorization: Bearer <platform JWT>          same token as every other surface
Content-Type: multipart/form-data

  audio       required   one VAD-segmented chunk (wav | mp3 | ogg | flac | m4a, ≤25 MB)
  chunkIndex  required   0-based
  questionId  optional   the qid this chunk belongs to
  sessionId   optional   the conversation
  isFinal     optional   "true" on the last chunk of a question
  durationMs  optional   speech duration, telemetry only
  language    optional   BCP-47 hint; omit to let the model detect it

→ 200 { text, model, chunkIndex, questionId, isFinal, ms }
→ 4xx/5xx { error, detail?, retryable }
```

**`retryable` is the field clients act on.** 502/503 means send this chunk again;
400/401 means stop. A client outbox that retries a 400 forever is the failure mode
this flag exists to prevent.

**Chunks are reassembled by `chunkIndex`, never by arrival order.** Chunks upload in
parallel, so a short later chunk routinely overtakes a long earlier one. Ordering by
arrival silently swaps clauses in the question.

## Provider

OpenRouter, via the OpenAI-compatible chat-completions API with an `input_audio`
content part — OpenRouter has no dedicated transcription endpoint, so an audio-capable
*chat* model does the work. The system prompt forces verbatim transcription: a spoken
question must come back as its own words, never as an attempt to answer it.

The model is configuration, not a constant:

| Binding | Required | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | yes | secret — `wrangler secret put OPENROUTER_API_KEY` |
| `TRANSCRIBE_MODEL` | no | defaults to `google/gemini-2.5-flash` (fast, multilingual) |
| `JWT_SECRET` | yes | already used elsewhere in the worker |

Adding a different backend (direct Groq Whisper, say) means writing one more
`Transcriber` in this folder and changing the single assignment in `index.ts`. The
worker does not change.

## Files

```
index.ts        the only export the worker uses: handleTranscribe()
openrouter.ts   the OpenRouter backend + model default + size cap
types.ts        Transcriber contract, request/result shapes, config bindings
```

Auth is **injected**, not reimplemented: the worker passes its own `verifyJwt` in, so
there is exactly one copy of the token rules in the codebase.
