import SwiftUI

@main
struct SuperatomApp: App {
    @State private var store: AppStore
    @State private var services: Services
    private let database: AppDatabase

    init() {
        // Opening the database and reading the first screen's worth of rows happens
        // here, synchronously, before the first frame. It is a local file read — the
        // app is on screen with real content before any network exists.
        // A corrupt or unreadable file must not brick the app: fall back to memory for
        // this launch so the user can still work, rather than crashing every launch.
        let db = Self.openDatabase()
        self.database = db
        // Abandoned conversations from a previous run — opened, never asked in — are
        // cleared here so the list only ever shows real ones.
        try? db.pruneEmptySessions()
        _store = State(initialValue: AppStore(db: db))
        _services = State(initialValue: Services(db: db))
    }

    private static func openDatabase() -> AppDatabase {
        do {
            let db = try AppDatabase.onDisk()
            try Bootstrap.seedIfEmpty(db)
            return db
        } catch {
            assertionFailure("database unavailable: \(error)")
            // swiftlint:disable:next force_try
            return try! AppDatabase.inMemory()
        }
    }

    var body: some Scene {
        WindowGroup {
            // The gate: signed out shows the login screen, and nothing behind it is
            // reachable. Everything else assumes an identity exists.
            Group {
                if services.connection.isSignedIn {
                    NavigationStack { SessionListView() }
                } else {
                    LoginView()
                }
            }
            .environment(store)
            .environment(services)
            .tint(Theme.ink)
            .task {
                store.onProjectChange = { project in
                    services.connection.projectId = project.id
                    services.reconnect()
                }
                services.start()
            }
        }
    }
}
