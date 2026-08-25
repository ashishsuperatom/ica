import Foundation
import GRDB

// ── Reads and writes ─────────────────────────────────────────────────────────
// Views never build SQL. They observe one of the value types below, and every
// change — local edit, or something the engine pushed — arrives the same way.

/// Everything the shell needs: who is signed in, which org and project are current,
/// and what is switchable. Derived in ONE observation so a context switch is a single
/// write that re-renders the whole app consistently.
struct HomeState: Equatable, Sendable {
    var account: Account?
    var org: Organization?
    var project: Project?
    var orgs: [Organization] = []
    var projects: [Project] = []
    var sessions: [Session] = []

    static let empty = HomeState()
    var isReady: Bool { account != nil && project != nil }

    /// Projects belonging to one organisation, for the grouped switcher.
    func projects(in org: Organization) -> [Project] {
        projects.filter { $0.orgId == org.id }
    }
}

/// One conversation, fully materialised: its questions in order, the renderable
/// blocks attached to each, and the analyst's beats for anything still running.
struct ConversationState: Equatable, Sendable {
    var session: Session?
    var questions: [Question] = []
    /// The spoken turn in progress: transcribing, or transcribed and awaiting review.
    /// Lives beside the composer, never in the feed.
    var pending: Question?
    var itemsByQuestion: [String: [FeedItem]] = [:]
    var beatsByQuestion: [String: [NarrationBeat]] = [:]
    var looseItems: [FeedItem] = []          // blocks not tied to a question

    static let empty = ConversationState()
    var isEmpty: Bool { questions.isEmpty && looseItems.isEmpty }
}

extension AppDatabase {

    // ── Context ──────────────────────────────────────────────────────────────

    func setting(_ key: AppState.Key, _ db: Database) throws -> String? {
        try String.fetchOne(db, sql: "SELECT value FROM appState WHERE key = ?", arguments: [key.rawValue])
    }

    func setSetting(_ key: AppState.Key, _ value: String) throws {
        try writer.write { db in try AppState(key: key.rawValue, value: value).upsert(db) }
    }

    /// Point the app at a project. Also remembers its org, so reopening lands exactly
    /// where you left off even after switching away and back.
    func switchTo(project: Project) throws {
        try writer.write { db in
            try AppState(key: AppState.Key.currentProjectId.rawValue, value: project.id).upsert(db)
            try AppState(key: AppState.Key.currentOrgId.rawValue, value: project.orgId).upsert(db)
            var p = project
            p.lastOpenedAt = .now
            try p.update(db)
        }
    }

    // ── Observations ─────────────────────────────────────────────────────────

    /// The one place home state is derived. Used BOTH by the observation and by the
    /// synchronous first read at launch, so the first frame and every later frame come
    /// from identical code.
    func fetchHome(_ db: Database) throws -> HomeState {
            guard let accountId = try self.setting(.currentAccountId, db),
                  let account = try Account.fetchOne(db, key: accountId)
            else { return .empty }

            let orgs = try Organization
                .filter(sql: "id IN (SELECT orgId FROM membership WHERE accountId = ?)", arguments: [accountId])
                .order(Column("name"))
                .fetchAll(db)

            let orgId = try self.setting(.currentOrgId, db) ?? orgs.first?.id
            let org = orgs.first { $0.id == orgId }

            // Every project this account can reach, across ALL orgs — the switcher shows
            // the whole hierarchy, not just the org currently selected.
            let projects = try Project
                .filter(sql: "id IN (SELECT projectId FROM projectAccess WHERE accountId = ?)", arguments: [accountId])
                .order(Column("name"))
                .fetchAll(db)

            let projectId = try self.setting(.currentProjectId, db)
            // A remembered project that belongs to another org must not leak across a
            // switch — fall back to the first project of the org actually selected.
            let inOrg = projects.filter { $0.orgId == (org?.id ?? "") }
            let project = projects.first { $0.id == projectId } ?? inOrg.first ?? projects.first

            let sessions = try project.map {
                try Session
                    .filter(Column("projectId") == $0.id)
                    .order(Column("updatedAt").desc)
                    .fetchAll(db)
            } ?? []

            return HomeState(account: account, org: org, project: project,
                             orgs: orgs, projects: projects, sessions: sessions)
    }

    func observeHome() -> ValueObservation<ValueReducers.RemoveDuplicates<ValueReducers.Fetch<HomeState>>> {
        ValueObservation.tracking(self.fetchHome).removeDuplicates()
    }

    func fetchConversation(_ db: Database, sessionId: String) throws -> ConversationState {
            guard let session = try Session.fetchOne(db, key: sessionId) else { return .empty }
            let all = try Question
                .filter(Column("sessionId") == sessionId)
                .order(Column("seq"))
                .fetchAll(db)
            // A spoken turn is not history until it has been sent. While it is being
            // transcribed, and while it waits for review, it belongs beside the composer
            // — NOT in the feed. Keeping it out is what stops it appearing at the top and
            // then jumping to the bottom.
            let questions = all.filter { $0.state != .draft && $0.state != .transcribing }
            let pending = all.last { $0.state == .draft || $0.state == .transcribing }
            let items = try FeedItem
                .filter(Column("sessionId") == sessionId)
                .order(Column("seq"))
                .fetchAll(db)
            let beats = try NarrationBeat
                .filter(sql: "questionId IN (SELECT id FROM question WHERE sessionId = ?)", arguments: [sessionId])
                .order(Column("questionId"), Column("seq"))
                .fetchAll(db)

            var byQuestion: [String: [FeedItem]] = [:]
            var loose: [FeedItem] = []
            for item in items {
                if let qid = item.questionId { byQuestion[qid, default: []].append(item) }
                else { loose.append(item) }
            }
            var beatsBy: [String: [NarrationBeat]] = [:]
            for beat in beats { beatsBy[beat.questionId, default: []].append(beat) }

            return ConversationState(session: session, questions: questions, pending: pending,
                                     itemsByQuestion: byQuestion, beatsByQuestion: beatsBy,
                                     looseItems: loose)
    }

    func observeConversation(sessionId: String)
    -> ValueObservation<ValueReducers.RemoveDuplicates<ValueReducers.Fetch<ConversationState>>> {
        ValueObservation.tracking { try self.fetchConversation($0, sessionId: sessionId) }.removeDuplicates()
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    /// Build a session WITHOUT writing it. A conversation only becomes real when the
    /// first question is asked — otherwise every stray tap on "new" leaves an "New
    /// conversation" row in the list forever. Persisted lazily by `persist(session:)`.
    func draftSession(projectId: String, accountId: String) -> Session {
        Session(projectId: projectId, accountId: accountId)
    }

    /// Insert a drafted session if it isn't already stored. Idempotent.
    func persist(session: Session) throws {
        try writer.write { db in
            if try Session.fetchOne(db, key: session.id) == nil { try session.insert(db) }
        }
    }

    /// Drop conversations that never got a question. Runs at launch: a session the user
    /// abandoned mid-typing is worthless, and left alone these accumulate forever.
    func pruneEmptySessions() throws {
        try writer.write { db in
            // A spoken turn left mid-transcription can never finish: the recorder and its
            // upload died with the previous run. Left alone it wedges the composer on
            // "Transcribing…" forever, with no way to record anything else.
            try db.execute(sql: "DELETE FROM question WHERE state = 'transcribing'")

            // A spoken turn that never produced any text — the recorder was stopped
            // before the detector heard anything, or the transcription never landed.
            // It has no content and can never gain any, so it is not history.
            try db.execute(sql: """
                DELETE FROM question
                WHERE TRIM(text) = ''
                  AND id NOT IN (SELECT questionId FROM feedItem WHERE questionId IS NOT NULL)
                  AND id NOT IN (SELECT questionId FROM audioChunk WHERE state <> 'transcribed')
                """)
            try db.execute(sql: """
                DELETE FROM session
                WHERE id NOT IN (SELECT DISTINCT sessionId FROM question)
                  AND id NOT IN (SELECT DISTINCT sessionId FROM feedItem)
                """)
        }
    }

    func delete(session: Session) throws {
        _ = try writer.write { db in try session.delete(db) }
    }

    func rename(session: Session, to title: String) throws {
        try writer.write { db in
            var s = session
            s.title = title
            s.updatedAt = .now
            try s.update(db)
        }
    }

    /// Append a question to a session. The returned id is the qid used everywhere:
    /// on the wire, in the engine's output file, and as this row's primary key.
    @discardableResult
    func appendQuestion(sessionId: String, text: String, source: Question.Source) throws -> Question {
        try writer.write { db in
            let next = try Int.fetchOne(db, sql: "SELECT COALESCE(MAX(seq), -1) + 1 FROM question WHERE sessionId = ?",
                                        arguments: [sessionId]) ?? 0
            let q = Question(sessionId: sessionId, seq: next, text: text, source: source, state: .draft)
            try q.insert(db)
            try db.execute(sql: "UPDATE session SET updatedAt = ? WHERE id = ?", arguments: [Date.now, sessionId])
            // First question names the conversation until the engine offers something better.
            if next == 0 {
                try db.execute(sql: "UPDATE session SET title = ? WHERE id = ? AND (title IS NULL OR title = '')",
                               arguments: [String(text.prefix(60)), sessionId])
            }
            try self.index(db, body: text, kind: "question", refId: q.id, sessionId: sessionId)
            return q
        }
    }

    @discardableResult
    func appendFeedItem(sessionId: String, questionId: String?, kind: FeedItem.Kind, payload: String) throws -> FeedItem {
        try writer.write { db in
            let next = try Int.fetchOne(db, sql: "SELECT COALESCE(MAX(seq), -1) + 1 FROM feedItem WHERE sessionId = ?",
                                        arguments: [sessionId]) ?? 0
            let item = FeedItem(sessionId: sessionId, questionId: questionId, seq: next, kind: kind, payload: payload)
            try item.insert(db)
            try db.execute(sql: "UPDATE session SET updatedAt = ? WHERE id = ?", arguments: [Date.now, sessionId])
            if kind == .answer, let prose = item.answer?.answer {
                try self.index(db, body: prose, kind: "answer", refId: item.id, sessionId: sessionId)
            }
            return item
        }
    }

    // ── Writes driven by the engine ──────────────────────────────────────────

    func question(id: String) throws -> Question? {
        try writer.read { db in try Question.fetchOne(db, key: id) }
    }

    /// Last resort when an answer arrives with no usable id: the most recent question
    /// still waiting for one.
    func newestUnansweredQuestion() throws -> Question? {
        try writer.read { db in
            try Question.filter(sql: "state IN ('asking','transcribing')")
                .order(Column("createdAt").desc)
                .fetchOne(db)
        }
    }

    func markQuestion(id: String, state: Question.State, askedAt: Date? = nil, answeredAt: Date? = nil) throws {
        try writer.write { db in
            guard var q = try Question.fetchOne(db, key: id) else { return }
            q.state = state
            if let askedAt { q.askedAt = askedAt }
            if let answeredAt { q.answeredAt = answeredAt }
            try q.update(db)
        }
    }

    /// Append one line of the analyst's live commentary. Persisted as it arrives — not
    /// buffered in memory — so killing the app mid-question and reopening restores the
    /// run in progress rather than losing it.
    func appendBeat(questionId: String, text: String) throws {
        try writer.write { db in
            let next = try Int.fetchOne(db, sql: "SELECT COALESCE(MAX(seq), -1) + 1 FROM narrationBeat WHERE questionId = ?",
                                        arguments: [questionId]) ?? 0
            // The engine repeats a status line as it refines it; don't stack duplicates.
            let last = try String.fetchOne(db, sql: "SELECT text FROM narrationBeat WHERE questionId = ? ORDER BY seq DESC LIMIT 1",
                                           arguments: [questionId])
            guard last != text else { return }
            try NarrationBeat(questionId: questionId, seq: next, text: text,
                              atMs: Int64(Date.now.timeIntervalSince1970 * 1000)).insert(db)
        }
    }

    // ── Mirroring the server's view of who you are ───────────────────────────

    /// Replace the local org/project graph with what /api/me/projects returned. Rows the
    /// server no longer lists are removed — losing access to a project should remove it
    /// from the switcher — but conversations are keyed by project id and survive, so
    /// regaining access restores the history rather than starting blank.
    func sync(orgs: [AuthController.OrgProjects], accountId: String) throws {
        guard !accountId.isEmpty else { return }
        try writer.write { db in
            try Account(id: accountId, lastSignedInAt: .now).upsert(db)

            var orgIds: [String] = []
            var projectIds: [String] = []

            for entry in orgs {
                orgIds.append(entry.org.id)
                try Organization(id: entry.org.id, name: entry.org.name).upsert(db)
                try Membership(accountId: accountId, orgId: entry.org.id).upsert(db)
                for project in entry.projects {
                    projectIds.append(project.id)
                    // Keep lastOpenedAt: it is local knowledge the server doesn't have.
                    let existing = try Project.fetchOne(db, key: project.id)
                    try Project(id: project.id, orgId: entry.org.id, name: project.name,
                                subdomain: project.subdomain,
                                createdAt: existing?.createdAt ?? .now,
                                lastOpenedAt: existing?.lastOpenedAt).upsert(db)
                    try ProjectAccess(accountId: accountId, projectId: project.id).upsert(db)
                }
            }

            // Drop access rows the server no longer grants.
            let orgList = orgIds.map { "'\($0)'" }.joined(separator: ",")
            let projList = projectIds.map { "'\($0)'" }.joined(separator: ",")
            try db.execute(sql: "DELETE FROM membership WHERE accountId = ?" +
                                (orgIds.isEmpty ? "" : " AND orgId NOT IN (\(orgList))"),
                           arguments: [accountId])
            try db.execute(sql: "DELETE FROM projectAccess WHERE accountId = ?" +
                                (projectIds.isEmpty ? "" : " AND projectId NOT IN (\(projList))"),
                           arguments: [accountId])

            try AppState(key: AppState.Key.currentAccountId.rawValue, value: accountId).upsert(db)
        }
    }

    /// Update a draft's text after the user edits the transcript.
    func setQuestionText(id: String, text: String) throws {
        try writer.write { db in
            try db.execute(sql: "UPDATE question SET text = ? WHERE id = ?", arguments: [text, id])
        }
    }

    /// Remove error blocks from a question — used when an answer arrives after we had
    /// already reported a failure.
    func clearErrors(questionId: String) throws {
        try writer.write { db in
            try db.execute(sql: "DELETE FROM feedItem WHERE questionId = ? AND kind = 'error'",
                           arguments: [questionId])
        }
    }

    /// Why a spoken turn produced no text, if it was a failure rather than silence.
    /// Distinguishes "the service could not transcribe this" from "nothing was said",
    /// which are different problems and deserve different words.
    func transcriptionFailure(questionId: String) throws -> String? {
        try writer.read { db in
            let states = try String.fetchAll(db, sql: "SELECT state FROM audioChunk WHERE questionId = ?",
                                             arguments: [questionId])
            guard states.contains(where: { $0 != "transcribed" }) else { return nil }
            let error = try String.fetchOne(db, sql: """
                SELECT lastError FROM audioChunk
                 WHERE questionId = ? AND lastError IS NOT NULL
                 ORDER BY updatedAt DESC LIMIT 1
                """, arguments: [questionId])
            return error.map { "Couldn't transcribe that — \($0)" } ?? "Couldn't transcribe that. Try again."
        }
    }

    /// Discard a draft and everything recorded for it — the audio was only ever a means
    /// of writing this question, so cancelling should leave nothing behind.
    func discard(questionId: String) throws {
        try writer.write { db in
            let paths = try String.fetchAll(db, sql: "SELECT path FROM audioChunk WHERE questionId = ? AND path IS NOT NULL",
                                            arguments: [questionId])
            for path in paths { try? FileManager.default.removeItem(atPath: path) }
            try db.execute(sql: "DELETE FROM question WHERE id = ?", arguments: [questionId])
        }
    }

    /// Name the conversation from its first real question. A spoken question has no text
    /// when its row is created, so the title has to be set once the transcript exists —
    /// otherwise the list keeps saying "New conversation" for a chat that clearly isn't.
    func titleSessionIfNeeded(sessionId: String, from text: String) throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        try writer.write { db in
            try db.execute(sql: """
                UPDATE session SET title = ?, updatedAt = ?
                 WHERE id = ? AND (title IS NULL OR title = '')
                """, arguments: [String(trimmed.prefix(60)), Date.now, sessionId])
        }
    }

    // ── Recovery from the hub's answer buffer ────────────────────────────────

    /// Merge a `sync:res` from the ProjectDO: conversations this identity had elsewhere,
    /// and answers that landed while the app was closed or offline.
    ///
    /// De-duplicated by qid throughout — a live delivery and a recovery of the same
    /// answer must never render twice. Returns the qids that were actually stored, which
    /// the caller acks so the hub stops re-pushing them.
    @discardableResult
    func merge(sessions: [(id: String, title: String?, lastAt: Date)],
               answers: [(qid: String, sessionId: String, question: String, answerJSON: String)],
               projectId: String, accountId: String) throws -> [String] {
        guard !projectId.isEmpty, !accountId.isEmpty else { return [] }
        var stored: [String] = []

        try writer.write { db in
            for snapshot in sessions {
                guard try Session.fetchOne(db, key: snapshot.id) == nil else { continue }
                try Session(id: snapshot.id, projectId: projectId, accountId: accountId,
                            title: snapshot.title, createdAt: snapshot.lastAt,
                            updatedAt: snapshot.lastAt).insert(db)
            }

            for item in answers {
                // The session may not exist locally at all — this answer could be from
                // the web app, or another device entirely.
                if try Session.fetchOne(db, key: item.sessionId) == nil {
                    try Session(id: item.sessionId, projectId: projectId, accountId: accountId,
                                title: String(item.question.prefix(60))).insert(db)
                }

                // qid IS the question's primary key, which is what makes this idempotent
                // without any explicit dedup bookkeeping.
                if try Question.fetchOne(db, key: item.qid) == nil {
                    let seq = try Int.fetchOne(db, sql: "SELECT COALESCE(MAX(seq), -1) + 1 FROM question WHERE sessionId = ?",
                                               arguments: [item.sessionId]) ?? 0
                    try Question(id: item.qid, sessionId: item.sessionId, seq: seq,
                                 text: item.question, source: .text, state: .answered,
                                 answeredAt: .now).insert(db)
                }

                let already = try Bool.fetchOne(db, sql: """
                    SELECT EXISTS(SELECT 1 FROM feedItem WHERE questionId = ? AND kind = 'answer')
                    """, arguments: [item.qid]) ?? false
                if !already {
                    let seq = try Int.fetchOne(db, sql: "SELECT COALESCE(MAX(seq), -1) + 1 FROM feedItem WHERE sessionId = ?",
                                               arguments: [item.sessionId]) ?? 0
                    try FeedItem(sessionId: item.sessionId, questionId: item.qid, seq: seq,
                                 kind: .answer, payload: item.answerJSON).insert(db)
                    try db.execute(sql: "UPDATE question SET state = 'answered' WHERE id = ?", arguments: [item.qid])
                }
                stored.append(item.qid)
            }
        }
        return stored
    }

    // ── Search ───────────────────────────────────────────────────────────────

    private func index(_ db: Database, body: String, kind: String, refId: String, sessionId: String) throws {
        try db.execute(sql: "INSERT INTO searchIndex (body, kind, refId, sessionId) VALUES (?, ?, ?, ?)",
                       arguments: [body, kind, refId, sessionId])
    }

    /// Local full-text search across questions and answers.
    func search(_ text: String, limit: Int = 50) throws -> [(kind: String, refId: String, sessionId: String, snippet: String)] {
        let pattern = FTS5Pattern(matchingAllTokensIn: text)
        guard let pattern else { return [] }
        return try writer.read { db in
            try Row.fetchAll(db, sql: """
                SELECT kind, refId, sessionId, snippet(searchIndex, 0, '', '', '…', 12) AS snip
                FROM searchIndex WHERE searchIndex MATCH ? ORDER BY rank LIMIT ?
                """, arguments: [pattern, limit])
                .map { (kind: $0["kind"], refId: $0["refId"], sessionId: $0["sessionId"], snippet: $0["snip"]) }
        }
    }
}
