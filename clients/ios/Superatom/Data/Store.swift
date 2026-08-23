import Foundation
import Observation

// ── Observable wrappers around the database ──────────────────────────────────
// Views hold one of these and read plain properties. Nothing here fetches on demand:
// values arrive because the database changed, whoever changed it — a local edit now,
// the engine's WebSocket in step 2, the transcription outbox in step 3.

@MainActor
@Observable
final class AppStore {
    private(set) var home: HomeState

    let db: AppDatabase
    private var task: Task<Void, Never>?

    init(db: AppDatabase) {
        self.db = db
        // Read synchronously so the FIRST frame already has the last conversation on it.
        // This is the whole "never shows a connecting screen" promise, and it is just
        // a local SQLite read — sub-millisecond, and correct offline.
        self.home = (try? db.writer.read { try db.fetchHome($0) }) ?? .empty
        task = Task { [weak self, db] in
            do {
                for try await value in db.observeHome().values(in: db.writer) {
                    guard let self else { return }
                    self.home = value
                }
            } catch { }
        }
    }

    // ── Actions ──────────────────────────────────────────────────────────────

    func switchTo(project: Project) {
        try? db.switchTo(project: project)
        onProjectChange?(project)
    }

    /// Set by the app root: a project switch must re-open the socket, since the hub URL
    /// carries the project id.
    var onProjectChange: ((Project) -> Void)?

    /// Switching org clears the remembered project so the observation selects one that
    /// actually belongs to the org you moved to.
    func switchTo(org: Organization) {
        try? db.setSetting(.currentOrgId, org.id)
        try? db.setSetting(.currentProjectId, "")
    }

    /// A conversation that does not exist yet — it is written only when a question is
    /// actually asked (see ConversationStore.ask).
    func newSession() -> Session? {
        guard let project = home.project, let account = home.account else { return nil }
        return db.draftSession(projectId: project.id, accountId: account.id)
    }

    func delete(_ session: Session) { try? db.delete(session: session) }
}

@MainActor
@Observable
final class ConversationStore {
    private(set) var state: ConversationState

    let db: AppDatabase
    let session: Session
    var sessionId: String { session.id }
    private let services: Services
    private var task: Task<Void, Never>?
    /// The question currently being spoken, if any.
    private var voiceQuestionId: String?
    /// In-flight transcription work, so it can actually be stopped rather than merely
    /// forgotten about.
    private var voiceTasks: [Task<Void, Never>] = []
    /// Something went wrong with the last spoken turn — shown above the composer.
    private(set) var voiceError: String?

    init(db: AppDatabase, session: Session, services: Services) {
        self.db = db
        self.session = session
        self.services = services
        let sessionId = session.id
        self.state = (try? db.writer.read { try db.fetchConversation($0, sessionId: sessionId) }) ?? .empty
        task = Task { [weak self, db] in
            do {
                for try await value in db.observeConversation(sessionId: sessionId).values(in: db.writer) {
                    guard let self else { return }
                    self.state = value
                }
            } catch { }
        }
    }

    // ── Typed ────────────────────────────────────────────────────────────────

    func ask(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        try? db.persist(session: session)          // the conversation becomes real here, not before
        guard let question = try? db.appendQuestion(sessionId: sessionId, text: trimmed, source: .text)
        else { return }
        try? db.titleSessionIfNeeded(sessionId: sessionId, from: trimmed)
        services.hub.ask(question: question)
    }

    // ── Reviewing a spoken question ──────────────────────────────────────────
    // Transcription is not reliable enough to send blind: a misheard word changes the
    // question, and the engine will answer the wrong one perfectly. So a spoken turn
    // lands as a DRAFT to be read, edited, sent or thrown away.

    func editPending(_ text: String) {
        guard let pending = state.pending else { return }
        try? db.setQuestionText(id: pending.id, text: text)
    }

    func submitPending() {
        guard let pending = state.pending else { return }
        let text = pending.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        try? db.setQuestionText(id: pending.id, text: text)
        try? db.titleSessionIfNeeded(sessionId: sessionId, from: text)
        try? db.markQuestion(id: pending.id, state: .asking, askedAt: .now)
        if var question = try? db.question(id: pending.id) {
            question.text = text
            services.hub.ask(question: question)
        }
    }

    /// Abandon the spoken turn. This has to work MID-transcription — that is exactly when
    /// you would want out — so it stops the upload, stops the recorder if it is still
    /// running, and removes the question with its audio. Any result that arrives after
    /// this lands on a question that no longer exists and is discarded.
    func cancelPending() {
        guard let pending = state.pending else { return }
        voiceTasks.forEach { $0.cancel() }
        voiceTasks = []
        voiceQuestionId = nil
        services.recorder.onChunk = nil
        if services.recorder.state.isRecording { services.recorder.stop() }
        try? db.discard(questionId: pending.id)
        voiceError = nil
    }

    func clearVoiceError() { voiceError = nil }

    /// Re-run a question. Staged as a draft rather than sent straight off: "ask again"
    /// usually means "nearly the same question", and the edit step costs one tap while
    /// saving a wasted run.
    func askAgain(_ text: String) {
        proposeFollowUp(text)
    }

    /// A suggested question, staged for review rather than asked outright — the same
    /// consent step a spoken question goes through.
    func proposeFollowUp(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, state.pending == nil else { return }
        try? db.persist(session: session)
        guard let question = try? db.appendQuestion(sessionId: sessionId, text: trimmed, source: .text)
        else { return }
        try? db.markQuestion(id: question.id, state: .draft)
    }

    // ── Spoken ───────────────────────────────────────────────────────────────
    // The question row is created BEFORE any audio exists, so every chunk has something
    // durable to attach to and a crash mid-sentence still leaves a recoverable question.

    func startVoice() {
        // NOTHING is written here. The conversation and the question come into existence
        // only when the voice-activity detector actually delivers speech — so tapping the
        // mic, hearing nothing, and stopping leaves no trace. The VAD is the gate.
        voiceQuestionId = nil
        let outbox = services.outbox
        voiceTasks = []
        voiceError = nil
        services.recorder.onChunk = { [weak self] wav, ms, index, isFinal in
            guard let self else { return }
            guard let qid = self.beginVoiceQuestionIfNeeded() else { return }
            let task = Task {
                await outbox.submit(wav: wav, questionId: qid, chunkIndex: index,
                                    sessionId: self.sessionId, durationMs: ms, isFinal: isFinal)
                guard !Task.isCancelled else { return }
                if isFinal { await self.finishVoice(questionId: qid) }
            }
            self.voiceTasks.append(task)
        }
        services.recorder.start()
    }

    /// Called from the FIRST chunk of a spoken turn — i.e. once the VAD has confirmed
    /// there is speech. Idempotent for the chunks that follow.
    private func beginVoiceQuestionIfNeeded() -> String? {
        if let existing = voiceQuestionId { return existing }
        try? db.persist(session: session)
        guard let question = try? db.appendQuestion(sessionId: sessionId, text: "", source: .voice)
        else { return nil }
        try? db.markQuestion(id: question.id, state: .transcribing)
        voiceQuestionId = question.id
        return question.id
    }

    func stopVoice() {
        services.recorder.stop()
    }

    /// All chunks are in and assembled. The question is now a DRAFT for review — it is
    /// NOT sent. If nothing was heard there is nothing to review, so the draft is simply
    /// removed rather than left as an empty row.
    private func finishVoice(questionId: String) async {
        voiceQuestionId = nil
        services.recorder.onChunk = nil
        voiceTasks = []
        // Cancelled while this was in flight: the row is already gone, and re-creating it
        // would resurrect a question the user threw away.
        guard let question = try? db.question(id: questionId) else { return }

        let text = question.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty {
            try? db.markQuestion(id: questionId, state: .draft)
            return
        }

        // No text. Say WHY rather than quietly dropping something the user just spoke —
        // a failed transcription and an unheard one need different responses from them.
        let failure = (try? db.transcriptionFailure(questionId: questionId)) ?? nil
        voiceError = failure ?? "Didn't catch that — try again."
        try? db.discard(questionId: questionId)
    }
}
