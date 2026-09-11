import SwiftUI

@main
struct SuperatomApp: App {
    /// Everything below depends on WHICH account is signed in, because each account has its
    /// own database. So the app holds a session rather than a fixed set of objects: signing
    /// in builds one, signing out drops it, and signing in as someone else builds a
    /// different one over a different file.
    @State private var session: UserSession?
    @State private var signIn = SignIn()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        _session = State(initialValue: Accounts.current.flatMap(UserSession.init(accountId:)))
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if let session {
                    NavigationStack { SessionListView() }
                        .environment(session.store)
                        .environment(session.services)
                        .task {
                            session.store.onProjectChange = { project in
                                session.services.connection.projectId = project.id
                                session.services.reconnect()
                            }
                            session.services.start()
                        }
                        .onChange(of: session.services.connection.isSignedIn) { _, signedIn in
                            // Signed out from inside the app: drop the session so the login
                            // screen is backed by nothing, rather than a live socket and an
                            // open database belonging to someone who just left.
                            if !signedIn { self.session = nil }
                        }
                } else {
                    LoginView(signIn: signIn)
                        .onChange(of: signIn.accountId) { _, accountId in
                            guard let accountId else { return }
                            session = UserSession(accountId: accountId)
                        }
                }
            }
            .tint(Theme.ink)
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .active:     session?.services.onForeground()
                case .background: session?.services.onBackground()
                default:          break
                }
            }
        }
    }
}

/// One signed-in account: its database, and everything built on it.
@MainActor
final class UserSession {
    let db: AppDatabase
    let services: Services
    let store: AppStore

    init?(accountId: String) {
        // The path is derived from the account id, so the same person always opens the same
        // file. A database that cannot be opened must not brick the app — fall back to
        // memory for this launch rather than crashing on every one.
        let db = (try? AppDatabase.onDisk(accountId: accountId)) ?? (try? AppDatabase.inMemory())
        guard let db else { return nil }
        self.db = db
        // Conversations opened and never asked in are cleared here, so the list only ever
        // shows real ones.
        try? db.pruneEmptySessions()
        // Anything still "asking" was asked by a process that no longer exists — its socket
        // died with it, so no answer can arrive on that turn. Close them out honestly
        // rather than leaving the list saying "Working…" indefinitely.
        let interrupted = (try? db.reconcileInterruptedTurns()) ?? []
        // Services first: Connection settles the account and project in the database before
        // AppStore takes its synchronous first read, so the first frame is already correct.
        self.services = Services(db: db, accountId: accountId)
        services.interrupted = interrupted
        self.store = AppStore(db: db)
        services.auth.onSignedIn = { _ in }
    }
}
