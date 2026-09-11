import Foundation
import UIKit
import Observation

// Everything long-lived, owned at app root. The recorder in particular MUST outlive any
// view: SwiftUI rebuilds a view freely, and tearing down a live microphone because a
// parent re-rendered loses the question someone is in the middle of asking.

@MainActor
@Observable
final class Services {
    let db: AppDatabase
    let connection: Connection
    let auth: AuthController
    let hub: HubClient
    let recorder = VoiceRecorder()
    let preferences = Preferences()
    let notifier = Notifier()
    let navigation = Navigation()
    let outbox: AudioOutbox

    /// Turns left running by a previous launch, to be chased by qid once connected.
    var interrupted: [Question] = []

    init(db: AppDatabase, accountId: String) {
        self.db = db
        let connection = Connection(db: db, accountId: accountId)
        self.connection = connection
        self.auth = AuthController(connection: connection, db: db)
        self.hub = HubClient(db: db, connection: connection)
        self.outbox = AudioOutbox(db: db, client: TranscriptionClient(connection: connection),
                                  accountId: accountId)
        connectSignals()
    }

    /// Wire the pieces that need to know about each other, once.
    private func connectSignals() {
        hub.wantsProgramLogs = preferences.showProgramLogs
        preferences.onProgramLogsChanged = { [weak self] on in
            self?.hub.attachProgramLogs(on)
        }
        // A tapped notification names a question; turn that into "open this conversation
        // there". The lookup lives here because Notifier has no business knowing the schema.
        notifier.onOpen = { [weak self] questionId in
            guard let self, let question = try? self.db.question(id: questionId) else { return }
            self.navigation.open(sessionId: question.sessionId, questionId: questionId)
        }
        hub.onAnswer = { [weak self] questionId, question, summary in
            self?.notifier.deliver(questionId: questionId, question: question,
                                   body: String(summary.prefix(180)))
        }
    }

    /// Called once at launch. A stored credential means we can connect immediately —
    /// the project list refreshes in the background rather than gating the first screen.
    func start() {
        guard connection.isSignedIn else { return }
        if connection.isReady { hub.connect() }
        // Turns interrupted by a previous launch. The live commentary was addressed to a
        // socket that no longer exists, but the ANSWER is not — the hub stores it against
        // the qid, so ask for it by id. If it is there, it heals the turn and the failure
        // notice disappears.
        for question in interrupted { hub.recheck(questionId: question.id) }
        Task {
            await auth.loadProjects()
            if connection.isReady { hub.connect() }   // no-op if already connected
            await outbox.drain()
        }
    }

    /// The app came back to the foreground.
    ///
    /// iOS suspends the process in the background, which kills the WebSocket AND freezes
    /// any reconnect we had scheduled — so without this the app would sit disconnected
    /// until it was force-quit and relaunched, silently missing every answer that landed
    /// meanwhile. Reconnecting here also re-runs sync, which pulls exactly those answers.
    func onForeground() {
        endBackgroundGrace()
        // Something may have finished while you were away. Say so rather than leaving it to
        // be discovered — the whole point of asking was to get an answer back.
        if let since = leftAt {
            answeredWhileAway = (try? db.answered(since: since))?.first
            leftAt = nil
        }
        guard connection.isReady else { return }
        hub.connect()          // no-op when a socket already exists
        Task { await outbox.drain() }          // and re-send any audio stranded by the suspend
    }

    /// Going to the background.
    ///
    /// iOS suspends the process, which kills the socket — so an answer that lands while the
    /// app is away simply is not received, and nothing can be notified about it. That is a
    /// platform rule, not something to code around: there is no background mode for "keep a
    /// WebSocket open", and the ones that look like they would (`voip`) are gated to real
    /// VoIP with PushKit.
    ///
    /// What IS available: `beginBackgroundTask` buys roughly 30 seconds of execution after
    /// backgrounding. So if a question is in flight we hold the socket open for that window
    /// instead of closing it, which catches an answer that lands just after you switch away
    /// — the common case when you background the app because it is taking a while.
    ///
    /// Beyond that window the answer waits, and is collected on the next foreground.
    /// Notifying reliably needs a push from the server; see AUTH-HANDOFF.md's sibling note.
    func onBackground() {
        leftAt = .now
        guard hub.hasTurnInFlight else {
            hub.disconnect()
            return
        }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "sa-await-answer") { [weak self] in
            self?.endBackgroundGrace()
        }
        // Give up the grace period a little early, so the socket closes on our terms rather
        // than the process being killed mid-write.
        graceTimer = Task { @MainActor in
            try? await Task.sleep(for: .seconds(25))
            self.endBackgroundGrace()
        }
    }

    /// An answer that landed while the app was away, waiting to be pointed out.
    private(set) var answeredWhileAway: Question?
    private var leftAt: Date?

    func dismissAnsweredWhileAway() { answeredWhileAway = nil }

    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var graceTimer: Task<Void, Never>?

    /// End the background grace period, if one is running.
    ///
    /// It used to disconnect unconditionally — including on the very first foreground,
    /// where nothing had been backgrounded at all. So launch connected a socket, then
    /// immediately tore it down and made another. The engine emits a turn's narration to
    /// the socket that ASKED, so churning sockets meant a question could go silent for the
    /// rest of its run.
    ///
    /// The grace period ends only when there was one: it exists to close a socket we chose
    /// to hold open past backgrounding, not to close whatever is currently connected.
    private func endBackgroundGrace() {
        guard backgroundTask != .invalid || graceTimer != nil else { return }
        graceTimer?.cancel()
        graceTimer = nil
        hub.disconnect()
        if backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
    }

    /// Re-point at a different project, or reconnect after signing in.
    func reconnect() {
        hub.disconnect()
        if connection.isReady { hub.connect() }
    }

    func signOut() {
        hub.disconnect()
        auth.signOut()
    }
}
