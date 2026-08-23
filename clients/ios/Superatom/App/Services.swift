import Foundation
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
    let outbox: AudioOutbox

    init(db: AppDatabase) {
        self.db = db
        let connection = Connection()
        self.connection = connection
        self.auth = AuthController(connection: connection, db: db)
        self.hub = HubClient(db: db, connection: connection)
        self.outbox = AudioOutbox(db: db, client: TranscriptionClient(connection: connection))
    }

    /// Called once at launch. A stored credential means we can connect immediately —
    /// the project list refreshes in the background rather than gating the first screen.
    func start() {
        guard connection.isSignedIn else { return }
        if connection.isReady { hub.connect() }
        Task {
            await auth.loadProjects()
            if connection.isReady, hub.status == .idle { hub.connect() }
            await outbox.drain()
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
