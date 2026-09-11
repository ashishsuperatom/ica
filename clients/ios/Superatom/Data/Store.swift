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
        let t0 = CFAbsoluteTimeGetCurrent()
        self.home = (try? db.writer.read { try db.fetchHome($0) }) ?? .empty
        NSLog("[home] first read: %d sessions, project=%@, account=%@, %.1fms",
              home.sessions.count, home.project?.id ?? "nil", home.account?.id ?? "nil",
              (CFAbsoluteTimeGetCurrent() - t0) * 1000)
        task = Task { [weak self, db] in
            do {
                for try await value in db.observeHome().values(in: db.writer) {
                    guard let self else { return }
                    if value.sessions.count != self.home.sessions.count {
                        NSLog("[home] update: %d sessions (was %d)", value.sessions.count, self.home.sessions.count)
                    }
                    self.home = value
                }
            } catch { }
        }
    }

    // ── Actions ──────────────────────────────────────────────────────────────

    func switchTo(project: Project) {
        // Only the org and lastOpenedAt are written here; the project id itself is set via
        // Connection, which owns it — see Connection.projectId for why there is one writer.
        try? db.switchTo(project: project)
        onProjectChange?(project)
    }

    /// Set by the app root: a project switch must re-open the socket, since the hub URL
    /// carries the project id.
    var onProjectChange: ((Project) -> Void)?

    /// Moving to another organisation means moving to one of its projects — the org is
    /// not a place you can be on its own.
    func switchTo(org: Organization) {
        guard let first = home.projects(in: org).first else { return }
        switchTo(project: first)
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
    /// Which transcriber this turn is using — fixed when recording starts.
    private var usingOnDevice = true
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
        // This turn is no longer a voice draft — drop the handle so any transcription
        // still in flight cannot find it and reopen it.
        voiceQuestionId = nil
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
        services.recorder.speech.cancel()
        voiceTasks.forEach { $0.cancel() }
        voiceTasks = []
        voiceQuestionId = nil
        services.recorder.onChunk = nil
        if services.recorder.state.isRecording { services.recorder.stop() }
        try? db.discard(questionId: pending.id)
        voiceError = nil
    }

    func clearVoiceError() { voiceError = nil }

    /// Is a question in flight, and therefore stoppable?
    var isRunning: Bool {
        state.questions.contains { $0.state == .asking }
    }

    func stopTurn() {
        services.hub.stopTurn(sessionId: sessionId)
    }

    /// Ask the question again, as a question.
    ///
    /// This is the LLM path: the words are classified and may build or adapt a program, so
    /// the answer can legitimately differ from last time. Staged as a draft rather than
    /// sent outright, because "ask again" usually means "nearly the same question" — the
    /// edit step costs one tap and saves a wasted run.
    func askAgain(_ text: String) {
        proposeFollowUp(text)
    }

    /// Run the saved program behind an answer again.
    ///
    /// DETERMINISTIC, and a different operation entirely: `run:` is a verb the engine
    /// parses itself, so no model is involved, nothing is re-classified, and no program is
    /// written. Same computation, current data.
    ///
    /// Sent immediately, with no review step — there is nothing to edit. The subject is an
    /// id, not a sentence.
    /// Open one thing by its canonical lens.
    ///
    /// `view:` is a verb the engine parses itself — no model, no classification. The table
    /// already knows what a cell names and its id, so the whole instruction is those two
    /// words. Sent directly, like `run:`: there is nothing to edit in an id.
    func openEntity(_ entity: String, id: String) {
        try? db.persist(session: session)
        guard let question = try? db.appendQuestion(sessionId: sessionId,
                                                    text: "view: \(entity) \(id)", source: .text)
        else { return }
        services.hub.ask(question: question)
    }

    func runAgain(questionId: String) {
        try? db.persist(session: session)
        guard let question = try? db.appendQuestion(sessionId: sessionId,
                                                    text: "run: \(questionId)", source: .text)
        else { return }
        services.hub.ask(question: question)
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
        // ONE transcriber per turn, chosen up front. On-device unless the reader asked for
        // hosted, or unless this device has no on-device model at all — in which case
        // hosted is not a preference, it is the only option.
        let onDevice = services.preferences.transcribeOnDevice && services.recorder.speech.available
        usingOnDevice = onDevice
        voiceQuestionId = nil
        voiceTasks = []
        voiceError = nil

        if onDevice {
            // No uploads: the text comes from the device when recording stops.
            services.recorder.onChunk = nil
        } else {
            let outbox = services.outbox
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
        }
        services.recorder.start(onDevice: onDevice)
    }

    /// Called from the FIRST chunk of a spoken turn — i.e. once the VAD has confirmed
    /// there is speech. Idempotent for the chunks that follow. Hosted path only.
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
        guard usingOnDevice else { return }
        // On-device: the text is ready as soon as recording ends. The question is created
        // HERE, once, from a single source — so there is no second transcript arriving
        // later to argue with it.
        Task { [weak self] in
            guard let self else { return }
            let text = await self.services.recorder.speech.finish()
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else {
                self.voiceError = "Didn't catch that — try again."
                return
            }
            try? self.db.persist(session: self.session)
            guard let question = try? self.db.appendQuestion(sessionId: self.sessionId,
                                                             text: text, source: .voice) else { return }
            try? self.db.markQuestion(id: question.id, state: .draft)
        }
    }

    /// Live on-device text, for display while speaking.
    var liveTranscript: String { services.recorder.speech.text }

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

        // ONLY a turn still being transcribed may be touched here.
        //
        // The server transcript can land AFTER the reader has already pressed Send — the
        // on-device text was there first, so the question is by then `asking` and on its
        // way to the engine. Moving it back to `draft` resurrected it in the composer,
        // removed it from the feed (drafts are not history), and left the screen blank —
        // so it got sent a second time and the engine reported it was already answering.
        guard question.state == .transcribing else { return }

        let text = question.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty {
            try? db.markQuestion(id: questionId, state: .draft)
            return
        }

        // No text at all. Say WHY rather than quietly dropping something just spoken — a
        // failed transcription and an unheard one deserve different responses.
        let failure = (try? db.transcriptionFailure(questionId: questionId)) ?? nil
        voiceError = failure ?? "Didn't catch that — try again."
        try? db.discard(questionId: questionId)
    }
}
