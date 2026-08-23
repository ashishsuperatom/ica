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
    /// qid currently in flight, if any — drives the live progress block in the feed.
    private(set) var activeQuestionId: String?

    private let db: AppDatabase
    private let connection: Connection
    private var socket: URLSessionWebSocketTask?
    private var session: URLSession?
    private var pingTimer: Timer?
    private var reconnectAttempt = 0
    private var deliberatelyClosed = false
    /// Fires when a turn goes quiet for too long. The busy state is driven by the
    /// heartbeat, never by a flag we must remember to clear — so a stale "answering"
    /// left over from a reconnect times out by itself instead of spinning forever.
    private var watchdog: Task<Void, Never>?

    init(db: AppDatabase, connection: Connection) {
        self.db = db
        self.connection = connection
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    func connect() {
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
        send(payload: ["t": "sync:req"])
        status = .connected
        reconnectAttempt = 0
        receive()
        startPing()
    }

    func disconnect() {
        deliberatelyClosed = true
        stopPing()
        watchdog?.cancel()
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

    /// Ask a question. The qid is already the local row's primary key, so the answer
    /// lands back on the right row no matter how long it takes or how often we reconnect.
    func ask(question: Question) {
        NSLog("[hub] ask qid=%@ project=%@ socket=%@", question.id, connection.projectId,
              socket == nil ? "nil" : "open")
        activeQuestionId = question.id
        try? db.markQuestion(id: question.id, state: .asking, askedAt: .now)
        send(payload: [
            "t": "analyse",
            "question": question.text,
            "projectId": connection.projectId,
            "sessionId": question.sessionId,
            "questionId": question.id,
            "role": "user",
        ])
        armWatchdog()
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
        // An in-flight turn cannot survive a dropped socket — end it rather than leaving
        // a spinner that never resolves.
        if let qid = activeQuestionId {
            try? db.markQuestion(id: qid, state: .failed, answeredAt: .now)
            activeQuestionId = nil
        }
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

        if activeQuestionId != nil { armWatchdog() }   // any traffic = the engine is alive

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
            guard let qid = msg["qid"] as? String, (msg["status"] as? String) == "ready",
                  let answer = msg["answer"] as? [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: answer),
                  let json = String(data: data, encoding: .utf8) else { return }
            let sid = (try? db.question(id: qid))?.sessionId ?? ""
            _ = try? db.merge(sessions: [], answers: [(qid: qid, sessionId: sid,
                                                       question: (msg["question"] as? String) ?? "",
                                                       answerJSON: json)],
                              projectId: connection.projectId, accountId: connection.userId)
            send(payload: ["t": "answer:ack", "qids": [qid]])
            return

        case "machine:waking":
            status = .waking
            // Waking a suspended machine takes ~60s; a normal watchdog would false-fire.
            armWatchdog(seconds: 150)

        case "analyst:status", "analyst:progress":
            status = .connected
            if let text = msg["text"] as? String, let qid = activeQuestionId, !text.isEmpty {
                try? db.appendBeat(questionId: qid, text: text)
            }

        case "narration":
            if let text = msg["text"] as? String, let qid = activeQuestionId, !text.isEmpty {
                try? db.appendBeat(questionId: qid, text: text)
            }

        case "analyst:answer":
            // Attribute the answer as robustly as possible. Dropping one because the id
            // didn't line up is the worst failure this client has: the work was done, it
            // was paid for, and the person sees nothing.
            let qid = (msg["qid"] as? String)
                ?? activeQuestionId
                ?? ((try? db.newestUnansweredQuestion()) ?? nil)?.id
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

            let json = (try? JSONSerialization.data(withJSONObject: enriched))
                .flatMap { String(data: $0, encoding: .utf8) }
            NSLog("[hub] ANSWER stored qid=%@ bytes=%d", qid, json?.count ?? 0)
            try? db.appendFeedItem(sessionId: question.sessionId, questionId: qid, kind: .answer,
                                   payload: json ?? #"{"answer":"Answer could not be stored."}"#)
            try? db.markQuestion(id: qid, state: .answered, answeredAt: .now)
            if qid == activeQuestionId { activeQuestionId = nil }
            watchdog?.cancel()
            return

        case "followups":
            // Suggested next questions. Stored like any other block so they survive a
            // relaunch and arrive through the same path on reconnect.
            let items = (msg["items"] as? [Any] ?? []).compactMap { $0 as? String }
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            guard !items.isEmpty else { return }
            let qid = (msg["qid"] as? String) ?? activeQuestionId
            guard let qid, let question = try? db.question(id: qid) else { return }
            if let data = try? JSONSerialization.data(withJSONObject: items),
               let json = String(data: data, encoding: .utf8) {
                try? db.appendFeedItem(sessionId: question.sessionId, questionId: qid,
                                       kind: .followups, payload: json)
            }
            return

        case "analyst:done":
            if let qid = activeQuestionId {
                try? db.markQuestion(id: qid, state: .answered, answeredAt: .now)
                activeQuestionId = nil
            }
            watchdog?.cancel()

        case "error":
            let text = (msg["message"] as? String) ?? "Something went wrong."
            if let qid = activeQuestionId, let question = try? db.question(id: qid) {
                try? db.appendFeedItem(sessionId: question.sessionId, questionId: qid,
                                       kind: .error, payload: text)
                try? db.markQuestion(id: qid, state: .failed, answeredAt: .now)
            }
            activeQuestionId = nil
            watchdog?.cancel()

        default:
            NSLog("[hub] UNHANDLED %@", t)
            return                                       // a surface may ignore anything it doesn't render
        }
    }

    private func log(_ what: String, _ msg: [String: Any]) {
        NSLog("[hub] %@ keys=%@", what, msg.keys.sorted().joined(separator: ","))
    }

    private func armWatchdog(seconds: Double = 90) {
        watchdog?.cancel()
        watchdog = Task { @MainActor in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled, let qid = self.activeQuestionId else { return }
            try? self.db.appendFeedItem(sessionId: (try? self.db.question(id: qid))?.sessionId ?? "",
                                        questionId: qid, kind: .error,
                                        payload: "The engine went quiet. Please try again.")
            try? self.db.markQuestion(id: qid, state: .failed, answeredAt: .now)
            self.activeQuestionId = nil
        }
    }
}
