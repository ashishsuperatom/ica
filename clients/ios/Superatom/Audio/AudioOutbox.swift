import Foundation
import GRDB

// ── The audio outbox ─────────────────────────────────────────────────────────
// Every recorded chunk becomes a durable row and a WAV on disk, and is uploaded for
// transcription. Upload and persistence race deliberately — speed matters more than
// ordering, and both paths UPSERT on (questionId, chunkIndex), so they converge no
// matter which lands first.
//
// Two rules that are easy to get wrong and expensive to get wrong:
//
//   • Chunks are reassembled by chunkIndex, NEVER by arrival order. Uploads run in
//     parallel, so a short later chunk routinely overtakes a long earlier one; ordering
//     by arrival silently swaps clauses in the user's question.
//   • A failed chunk stays on disk with its row. Nothing is discarded until it has been
//     transcribed, so a dropped network or a 502 costs a retry, never a lost question.

actor AudioOutbox {
    private let db: AppDatabase
    private let client: TranscriptionClient

    /// Keep the most recent chunks recoverable; prune only what has succeeded.
    private let keepTranscribed = 20

    /// Whose recordings these are — audio is stored beside that account's database.
    private let accountId: String

    init(db: AppDatabase, client: TranscriptionClient, accountId: String) {
        self.db = db
        self.client = client
        self.accountId = accountId
    }

    /// Persist and upload one chunk. Returns once this chunk has a transcript or has
    /// exhausted its retries — the caller assembles, it does not wait on ordering.
    func submit(wav: Data, questionId: String, chunkIndex: Int, sessionId: String,
                durationMs: Int, isFinal: Bool) async {
        // Write to disk + row FIRST but do NOT await the upload behind it — both start
        // together. If the app dies here, the audio is already recoverable.
        let path = persist(wav: wav, questionId: questionId, chunkIndex: chunkIndex)
        upsert(questionId: questionId, chunkIndex: chunkIndex, path: path,
               durationMs: durationMs, isFinal: isFinal, state: .pending)

        guard !wav.isEmpty else {
            // The end-marker chunk carries no audio; nothing to transcribe.
            upsert(questionId: questionId, chunkIndex: chunkIndex, path: nil,
                   durationMs: 0, isFinal: true, state: .transcribed, transcript: "")
            return
        }

        await attempt(questionId: questionId, chunkIndex: chunkIndex, wav: wav,
                      sessionId: sessionId, durationMs: durationMs, isFinal: isFinal)
    }

    private func attempt(questionId: String, chunkIndex: Int, wav: Data,
                         sessionId: String, durationMs: Int, isFinal: Bool) async {
        // Cancelled before we even started — don't spend a transcription call on a
        // question that no longer exists.
        guard !Task.isCancelled else { return }
        setState(questionId: questionId, chunkIndex: chunkIndex, state: .uploading)
        do {
            let result = try await client.transcribe(wav: wav, chunkIndex: chunkIndex,
                                                     questionId: questionId, sessionId: sessionId,
                                                     durationMs: durationMs, isFinal: isFinal)
            // Cancelled while the request was in flight: the answer arrived for a
            // question the user has already abandoned.
            guard !Task.isCancelled else { return }
            upsert(questionId: questionId, chunkIndex: chunkIndex, path: nil,
                   durationMs: durationMs, isFinal: isFinal,
                   state: .transcribed, transcript: result.text)
            rebuildQuestionText(questionId: questionId)
            prune()
        } catch let failure as TranscriptionClient.Failure {
            setState(questionId: questionId, chunkIndex: chunkIndex,
                     state: failure.retryable ? .pending : .failed, error: failure.message)
        } catch {
            setState(questionId: questionId, chunkIndex: chunkIndex, state: .pending,
                     error: error.localizedDescription)
        }
    }

    /// Re-send everything still owed. Called at launch and when connectivity returns —
    /// this is what turns "the API was down" into a delay rather than a lost question.
    func drain() async {
        let pending: [AudioChunk] = (try? await db.writer.read { db in
            try AudioChunk.filter(sql: "state IN ('pending','uploading')")
                .order(Column("createdAt"))
                .fetchAll(db)
        }) ?? []

        for chunk in pending {
            guard let path = chunk.path,
                  let wav = try? Data(contentsOf: URL(fileURLWithPath: path)),
                  let question = try? db.question(id: chunk.questionId)
            else { continue }
            await attempt(questionId: chunk.questionId, chunkIndex: chunk.chunkIndex, wav: wav,
                          sessionId: question.sessionId, durationMs: chunk.durationMs,
                          isFinal: chunk.isFinal)
        }
    }

    // ── Storage ──────────────────────────────────────────────────────────────

    private func persist(wav: Data, questionId: String, chunkIndex: Int) -> String? {
        guard !wav.isEmpty else { return nil }
        let url = AppDatabase.audioDirectory(for: accountId)
            .appendingPathComponent("\(questionId)-\(chunkIndex).wav")
        do {
            try wav.write(to: url, options: .atomic)
            return url.path
        } catch {
            return nil                       // upload can still succeed; only retry is lost
        }
    }

    private func upsert(questionId: String, chunkIndex: Int, path: String?, durationMs: Int,
                        isFinal: Bool, state: AudioChunk.State, transcript: String? = nil) {
        try? db.writer.write { db in
            // Keyed on (questionId, chunkIndex) so the insert and the result can land in
            // either order and converge on one row.
            try db.execute(sql: """
                INSERT INTO audioChunk (id, questionId, chunkIndex, path, durationMs, isFinal,
                                        state, attempts, transcript, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
                ON CONFLICT(questionId, chunkIndex) DO UPDATE SET
                    path       = COALESCE(excluded.path, audioChunk.path),
                    durationMs = MAX(excluded.durationMs, audioChunk.durationMs),
                    isFinal    = excluded.isFinal OR audioChunk.isFinal,
                    state      = excluded.state,
                    transcript = COALESCE(excluded.transcript, audioChunk.transcript),
                    updatedAt  = excluded.updatedAt
                """, arguments: [UUID().uuidString, questionId, chunkIndex, path, durationMs,
                                 isFinal, state.rawValue, transcript, Date.now, Date.now])
        }
    }

    private func setState(questionId: String, chunkIndex: Int, state: AudioChunk.State, error: String? = nil) {
        try? db.writer.write { db in
            try db.execute(sql: """
                UPDATE audioChunk
                   SET state = ?, lastError = ?, attempts = attempts + 1, updatedAt = ?
                 WHERE questionId = ? AND chunkIndex = ?
                """, arguments: [state.rawValue, error, Date.now, questionId, chunkIndex])
        }
    }

    /// Assemble the question from its chunks IN INDEX ORDER.
    private func rebuildQuestionText(questionId: String) {
        try? db.writer.write { db in
            let parts = try String.fetchAll(db, sql: """
                SELECT transcript FROM audioChunk
                 WHERE questionId = ? AND transcript IS NOT NULL AND transcript <> ''
                 ORDER BY chunkIndex
                """, arguments: [questionId])
            let text = parts.joined(separator: " ")
                .replacingOccurrences(of: "  ", with: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return }
            try db.execute(sql: "UPDATE question SET text = ? WHERE id = ?", arguments: [text, questionId])
        }
    }

    /// Delete only transcribed audio, oldest first. Anything pending or failed is kept
    /// however old it is — that is the whole point of the outbox.
    private func prune() {
        try? db.writer.write { db in
            let stale = try AudioChunk
                .filter(sql: "state = 'transcribed' AND path IS NOT NULL")
                .order(Column("createdAt").desc)
                .fetchAll(db)
                .dropFirst(keepTranscribed)
            for chunk in stale {
                if let path = chunk.path { try? FileManager.default.removeItem(atPath: path) }
                try db.execute(sql: "UPDATE audioChunk SET path = NULL WHERE id = ?", arguments: [chunk.id])
            }
        }
    }
}
