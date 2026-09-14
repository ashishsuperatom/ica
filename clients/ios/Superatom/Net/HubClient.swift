import Foundation
import Observation

// ── The hub WebSocket ────────────────────────────────────────────────────────
// Speaks exactly what clients/protocol.ts defines, the same as the web app:
//
//   1. open   wss://<hub>/_ws/<projectId>?token=<jwt>
//   2. hello  { type: "hello", role: "runtime", token }
//   3. ask    { to: { type: "code-engine" }, payload: { t: "analyse", … } }
//   4. recv   { from, payload } — the answer arrives as payload.t == "analyst:answer"
//
// This class OWNS no view state. Everything it learns is written into SQLite, and the
// UI re-renders because the database changed. That is what makes a relaunch mid-answer
// pick up exactly where it was.

@MainActor
@Observable
final class HubClient {

    enum Status: Equatable {
        case idle, connecting, connected, waking, failed(String)

        /// What a person should be told. `waking` is its own state because a suspended
        /// engine genuinely takes ~60s to come up and silence there reads as breakage.
        var label: String? {
            switch self {
            case .idle, .connected: return nil
            case .connecting:       return "Connecting…"
            case .waking:           return "Starting the engine…"
            case .failed(let why):  return why
            }
        }
    }

    private(set) var status: Status = .idle
    /// Every question waiting on the engine, not just the newest.
    ///
    /// This was a single id, which quietly broke the moment two turns overlapped — asking
    /// again in another conversation orphaned the first, so its beats landed on the wrong
    /// question and its answer could only be placed if the wire happened to carry a qid.
    /// The engine allows one turn per SESSION, not one per app.
    private(set) var inFlight: Set<String> = []
    /// The most recent ask, used only for a message that arrives without a qid of its own.
    private var latestQuestionId: String?

    private let db: AppDatabase
    private let connection: Connection
    private var socket: URLSessionWebSocketTask?
    private var session: URLSession?
    private var pingTimer: Timer?
    private var reconnectAttempt = 0
    private var deliberatelyClosed = false

    /// Set by Services — told when an answer lands, so a question someone asked to be
    /// notified about can say so.
    var onAnswer: ((_ questionId: String, _ question: String, _ summary: String) -> Void)?

    init(db: AppDatabase, connection: Connection) {
        self.db = db
        self.connection = connection
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    func connect() {
        // ONE socket. `start()` and the foreground handler both ask to connect at launch,
        // and each new socket cancelled the previous one — whose failure was read as a drop,
        // which scheduled another reconnect. The loop churned connections, and every churn
        // orphaned the turn in flight: the engine keeps emitting narration to the socket
        // that asked, so a replaced socket goes silent for the rest of the question.
        guard socket == nil else { return }
        guard connection.isReady, let url = connection.webSocketURL else {
            status = .failed("Not configured")
            return
        }
        deliberatelyClosed = false
        status = .connecting

        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        let session = URLSession(configuration: config)
        self.session = session

        let socket = session.webSocketTask(with: url)
        self.socket = socket
        socket.resume()
        NSLog("[hub] connecting to %@", url.absoluteString.replacingOccurrences(of: connection.token, with: "«token»"))

        // The hub authenticates on the FIRST message, not at upgrade time.
        send(raw: ["type": "hello", "role": "runtime", "token": connection.token])
        // Pull anything that landed while we were away. The DO is always on and buffers
        // per user, so this recovers answers WITHOUT waking a suspended engine — and it
        // also brings across conversations had on the web or another device.
        // ONE request, whatever our history looks like.
        //
        // The hub already keeps a delivery ledger: every buffered answer carries an
        // `acked` flag, `sync:req` returns exactly the answers this user has NOT acked,
        // and we ack them once they are safely in the local database. So the server
        // already knows what we are owed — asking it per question would be reimplementing
        // that ledger on the client, and it would scale with history on every reconnect
        // (mobile reconnects constantly). Two messages per connect, regardless of whether
        // you have 3 questions or 3000.
        send(payload: ["t": "sync:req"])
        // The program's own detail — a line per unit, per decision, per query. Only
        // start/end/failed arrive unasked; the rest lives on this channel, and we subscribe
        // ONLY if asked to. Turning it off means the engine never sends them, rather than
        // the app receiving and discarding them.
        // Narration goes to the turn's REPLY socket — which is the socket that asked. If
        // that socket drops mid-question and we reconnect, the engine keeps emitting to the
        // dead one and the run goes silent for the rest of the turn.
        //
        // The engine also publishes narration on a channel, and a subscription belongs to
        // whichever socket is currently attached. So subscribing means a reconnect picks the
        // commentary back up instead of losing it.
        send(payload: ["t": "log:attach", "channel": "narration"])
        if wantsProgramLogs { attachProgramLogs(true) }
        status = .connected
        reconnectAttempt = 0
        receive()
        startPing()
    }

    func disconnect() {
        deliberatelyClosed = true
        stopPing()
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        status = .idle
    }

    /// A quiet socket through a ~30s engine wake looks dead to intermediaries and gets
    /// dropped as a 1006. A periodic ping holds it open across the gap.
    private func startPing() {
        stopPing()
        pingTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.socket?.sendPing { _ in } }
        }
    }

    private func stopPing() {
        pingTimer?.invalidate()
        pingTimer = nil
    }

    private func scheduleReconnect() {
        guard !deliberatelyClosed else { return }
        reconnectAttempt += 1
        // Backoff, capped: a hub that is down should not be hammered, but a brief network
        // blip should recover fast.
        let delay = min(pow(2.0, Double(min(reconnectAttempt, 5))), 30)
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(delay))
            guard !self.deliberatelyClosed else { return }
            self.connect()
        }
    }

    // ── Sending ──────────────────────────────────────────────────────────────

    private func send(raw: [String: Any]) {
        let label = String(describing: raw["type"] ?? (raw["payload"] as? [String: Any])?["t"] ?? "?")
        guard let socket else { NSLog("[hub] OUT dropped, no socket: %@", label); return }
        guard let data = try? JSONSerialization.data(withJSONObject: raw) else {
            NSLog("[hub] OUT dropped, unencodable: %@", label); return
        }
        // Text frames, not binary: the hub accepts both, but text is what every other
        // surface sends and it keeps the wire readable in any proxy or log along the way.
        socket.send(.string(String(data: data, encoding: .utf8) ?? "")) { [weak self] error in
            if let error {
                NSLog("[hub] OUT FAILED %@: %@", label, error.localizedDescription)
                Task { @MainActor in self?.handleDrop() }
            } else {
                NSLog("[hub] OUT %@", label)
            }
        }
    }

    /// Envelope a payload addressed to the code-engine. Clients never set `from` —
    /// the hub stamps the authenticated identity server-side, and the engine trusts it.
    private func send(payload: [String: Any]) {
        send(raw: ["to": ["type": "code-engine"], "payload": payload])
    }

    /// Is any question waiting on the engine right now?
    var hasTurnInFlight: Bool { !inFlight.isEmpty }

    /// Whether to subscribe to the program log channel. Read at connect; changing it
    /// attaches or detaches immediately.
    var wantsProgramLogs = true

    func attachProgramLogs(_ on: Bool) {
        wantsProgramLogs = on
        guard socket != nil else { return }      // applied on the next connect otherwise
        send(payload: ["t": on ? "log:attach" : "log:detach", "channel": "program"])
    }

    /// Ask the engine to abandon the turn in progress.
    ///
    /// Nothing is assumed here: the question stays `asking` until the engine confirms with
    /// `turn:stopped`. Clearing the card on tap would show a stopped turn that is in fact
    /// still running — and the engine often lands its closing answer afterwards anyway.
    func stopTurn(sessionId: String) {
        NSLog("[hub] turn:stop sid=%@", sessionId)
        send(payload: ["t": "turn:stop", "sessionId": sessionId, "reason": "the user stopped it"])
    }

    /// Ask the hub about ONE specific question. Deliberately not used on connect — that
    /// is what sync:req is for. This exists for the user-initiated case: a turn that looks
    /// stuck, where someone wants to check rather than wait.
    func recheck(questionId: String) {
        notice = "Checking…"
        send(payload: ["t": "answer:get", "qid": questionId])
        // Say something whatever happens. Every outcome here was silent before: a reply of
        // `pending`, a reply of `none`, and no reply at all all looked identical to a
        // person tapping the button — which reads as the button being broken.
        noticeTimeout?.cancel()
        noticeTimeout = Task { @MainActor in
            try? await Task.sleep(for: .seconds(6))
            guard !Task.isCancelled, notice == "Checking…" else { return }
            NSLog("[hub] answer:get got no reply")
            showNotice("No reply from the server.")
        }
    }

    /// A short-lived line for the reader, shown above the composer.
    private(set) var notice: String?
    private var noticeTimeout: Task<Void, Never>?

    private func showNotice(_ text: String) {
        noticeTimeout?.cancel()
        notice = text
        noticeTimeout = Task { @MainActor in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled else { return }
            notice = nil
        }
    }

    /// Ask a question. The qid is already the local row's primary key, so the answer
    /// lands back on the right row no matter how long it takes or how often we reconnect.
    func ask(question: Question) {
        NSLog("[hub] ask qid=%@ project=%@ socket=%@", question.id, connection.projectId,
              socket == nil ? "nil" : "open")
        inFlight.insert(question.id)
        latestQuestionId = question.id
        try? db.markQuestion(id: question.id, state: .asking, askedAt: .now)
        send(payload: [
            "t": "analyse",
            "question": question.text,
            "projectId": connection.projectId,
            "sessionId": question.sessionId,
            "questionId": question.id,
            "role": "user",
        ])
    }

    // ── Receiving ────────────────────────────────────────────────────────────

    private func receive() {
        socket?.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .failure(let error):
                    NSLog("[hub] receive failed: %@", error.localizedDescription)
                    self.handleDrop()
                case .success(let message):
                    switch message {
                    case .data(let data):   self.handle(data: data)
                    case .string(let text): self.handle(data: Data(text.utf8))
                    @unknown default:       break
                    }
                    self.receive()      // keep listening
                }
            }
        }
    }

    private func handleDrop() {
        stopPing()
        socket = nil
        // The in-flight question is deliberately LEFT OPEN. There is no timeout on a
        // question anywhere in this client: the analyst can think for as long as it needs,
        // and the hub buffers the answer durably, so reconnecting pulls it. Marking the
        // turn failed here used to throw away work that was still on its way.
        status = .connecting
        scheduleReconnect()
    }

    private func handle(data: Data) {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        // The hub wraps engine→client messages as { from, payload }. Tolerate both shapes.
        let msg = (root["payload"] as? [String: Any]) ?? root
        guard let t = msg["t"] as? String else {
            NSLog("[hub] «no t» keys=%@", root.keys.sorted().joined(separator: ","))
            return
        }
        // Every inbound type, so a message we are silently ignoring shows up in the log
        // instead of looking like the engine never replied.
        if t != "tick" { NSLog("[hub] IN %@ keys=%@", t, msg.keys.sorted().joined(separator: ",")) }


        switch t {
        case "tick":
            return                                       // liveness only, nothing to render

        case "welcome":
            return

        case "sync:res":
            let sessions = (msg["sessions"] as? [[String: Any]] ?? []).compactMap { row -> (id: String, title: String?, lastAt: Date)? in
                guard let id = row["sessionId"] as? String else { return nil }
                let ms = (row["lastAt"] as? Double) ?? 0
                return (id: id, title: row["title"] as? String, lastAt: Date(timeIntervalSince1970: ms / 1000))
            }
            let answers = (msg["answers"] as? [[String: Any]] ?? []).compactMap { row -> (qid: String, sessionId: String, question: String, answerJSON: String)? in
                guard let qid = row["qid"] as? String,
                      let answer = row["answer"] as? [String: Any],
                      let data = try? JSONSerialization.data(withJSONObject: answer),
                      let json = String(data: data, encoding: .utf8) else { return nil }
                return (qid: qid,
                        sessionId: (row["sessionId"] as? String) ?? "",
                        question: (row["question"] as? String) ?? "",
                        answerJSON: json)
            }
            let acked = (try? db.merge(sessions: sessions, answers: answers,
                                       projectId: connection.projectId,
                                       accountId: connection.userId)) ?? []
            // Ack so the hub stops re-pushing what we now hold durably.
            if !acked.isEmpty { send(payload: ["t": "answer:ack", "qids": acked]) }
            return

        case "answer:res":
            let status = (msg["status"] as? String) ?? "none"
            NSLog("[hub] answer:res status=%@", status)
            // The hub answers with one of three states, and the reader deserves to know
            // which — "still working" and "nothing stored" are different situations.
            if status != "ready" {
                showNotice(status == "pending"
                           ? "Still working on that one."
                           : "No answer stored for that question.")
                return
            }
            guard let qid = msg["qid"] as? String,
                  let answer = msg["answer"] as? [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: answer),
                  let json = String(data: data, encoding: .utf8) else { return }
            let existing = try? db.question(id: qid)
            if existing?.state == .failed { try? db.clearErrors(questionId: qid) }
            NSLog("[hub] recovered answer for qid=%@", qid)
            _ = try? db.merge(sessions: [], answers: [(qid: qid, sessionId: existing?.sessionId ?? "",
                                                       question: (msg["question"] as? String) ?? "",
                                                       answerJSON: json)],
                              projectId: connection.projectId, accountId: connection.userId)
            send(payload: ["t": "answer:ack", "qids": [qid]])
            showNotice("Answer recovered.")
            return

        case "machine:waking":
            status = .waking

        case "analyst:status", "analyst:progress":
            status = .connected
            if let text = msg["text"] as? String, let qid = attribute(msg), !text.isEmpty {
                try? db.appendBeat(questionId: qid, text: text)
            }

        case "narration":
            if let text = msg["text"] as? String, let qid = attribute(msg), !text.isEmpty {
                try? db.appendBeat(questionId: qid, text: text)
            }

        case "analyst:answer":
            // Attribute the answer as robustly as possible. Dropping one because the id
            // didn't line up is the worst failure this client has: the work was done, it
            // was paid for, and the person sees nothing.
            let qid = attribute(msg) ?? ((try? db.newestUnansweredQuestion()) ?? nil)?.id
            guard let qid, let question = try? db.question(id: qid) else {
                log("answer with no matching question", msg)
                return
            }

            // The engine sends an object; tolerate a bare string, and never discard the
            // payload just because its shape surprised us.
            var enriched: [String: Any]
            if let object = msg["answer"] as? [String: Any] {
                enriched = object
            } else if let text = msg["answer"] as? String {
                enriched = ["answer": text]
            } else {
                enriched = ["answer": "The engine returned an answer this app could not read."]
            }
            if enriched["category"] == nil, let category = msg["category"] { enriched["category"] = category }
            // The agent's raw terminal must never be stored or shown. It is tens of
            // kilobytes of internal stdout, and rendering it as an answer leaks how the
            // system works to whoever asked a business question.
            enriched.removeValue(forKey: "lastLines")

            let json = (try? JSONSerialization.data(withJSONObject: enriched))
                .flatMap { String(data: $0, encoding: .utf8) }
            NSLog("[hub] ANSWER qid=%@ bytes=%d wasFailed=%@", qid, json?.count ?? 0,
                  question.state == .failed ? "yes" : "no")
            // If we timed this turn out and the answer arrived anyway, the timeout was
            // wrong — clear the apology so the reader isn't left with an error sitting
            // above a perfectly good answer.
            if question.state == .failed { try? db.clearErrors(questionId: qid) }
            try? db.appendFeedItem(sessionId: question.sessionId, questionId: qid, kind: .answer,
                                   payload: json ?? #"{"answer":"Answer could not be stored."}"#)
            try? db.markQuestion(id: qid, state: .answered, answeredAt: .now)
            finish(qid)
            onAnswer?(qid, question.text, EngineAnswer(object: enriched).answer ?? "Your answer is ready.")
            return

        case "followups":
            // Suggested next questions. Stored like any other block so they survive a
            // relaunch and arrive through the same path on reconnect.
            let items = (msg["items"] as? [Any] ?? []).compactMap { $0 as? String }
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            guard !items.isEmpty else { return }
            guard let qid = attribute(msg), let question = try? db.question(id: qid) else { return }
            if let data = try? JSONSerialization.data(withJSONObject: items),
               let json = String(data: data, encoding: .utf8) {
                try? db.appendFeedItem(sessionId: question.sessionId, questionId: qid,
                                       kind: .followups, payload: json)
            }
            return

        case "turn:stopped":
            // `stopped: false` means there was nothing running to stop — leave the turn
            // alone rather than reporting a stop that never happened.
            // A stop names its session; the turn it ended is the one in flight there.
            let sid = msg["sessionId"] as? String
            guard (msg["stopped"] as? Bool) != false,
                  let qid = inFlight.first(where: { (try? db.question(id: $0))?.sessionId == sid })
                            ?? attribute(msg) else { return }
            if let question = try? db.question(id: qid),
               question.state == .asking {
                try? db.appendFeedItem(sessionId: question.sessionId, questionId: qid,
                                       kind: .error, payload: "You stopped this question.")
                try? db.markQuestion(id: qid, state: .failed, answeredAt: .now)
            }
            finish(qid)
            return

        case "analyst:done":
            // The turn ended. Only close it if it has an answer already — `done` after a
            // failure must not relabel a failed turn as answered.
            if let qid = attribute(msg) {
                if (try? db.question(id: qid))?.state == .asking {
                    try? db.markQuestion(id: qid, state: .answered, answeredAt: .now)
                }
                finish(qid)
            }

        case "error":
            let text = (msg["message"] as? String) ?? "Something went wrong."
            if let qid = attribute(msg), let question = try? db.question(id: qid) {
                try? db.appendFeedItem(sessionId: question.sessionId, questionId: qid,
                                       kind: .error, payload: text)
                try? db.markQuestion(id: qid, state: .failed, answeredAt: .now)
                finish(qid)
            }

        default:
            NSLog("[hub] UNHANDLED %@", t)
            return                                       // a surface may ignore anything it doesn't render
        }
    }

    /// Which question a message is about: its own qid, or — for the few that carry none —
    /// the most recent ask.
    private func attribute(_ msg: [String: Any]) -> String? {
        if let qid = msg["qid"] as? String, !qid.isEmpty { return qid }
        return latestQuestionId
    }

    private func finish(_ questionId: String) {
        inFlight.remove(questionId)
        if latestQuestionId == questionId { latestQuestionId = inFlight.first }
    }

    private func log(_ what: String, _ msg: [String: Any]) {
        NSLog("[hub] %@ keys=%@", what, msg.keys.sorted().joined(separator: ","))
    }

}
