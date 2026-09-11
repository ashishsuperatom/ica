import Foundation
import Security
import Observation

// ── How this device reaches the platform ─────────────────────────────────────
// The host is a build constant, not a preference — it is infrastructure, and a text
// field for it is a support incident waiting to happen. Identity comes from signing in;
// the project comes from what that identity can reach. The only thing stored is the
// platform token, and it lives in the Keychain because it is a credential.

@MainActor
@Observable
final class Connection {

    /// Where the platform lives. One value, compiled in.
    static let host = "https://superatom.site"

    /// Custom scheme the login redirect comes back on (declared in Info.plist).
    static let callbackScheme = "superatom"
    static let redirectURI = "superatom://auth"

    /// Platform JWT. Keychain-backed; this property is a cache of it.
    private(set) var token: String
    /// Who is signed in. In the DATABASE for the same reason as `projectId`: the queries
    /// that render the app key off it, and a second copy in UserDefaults could disagree —
    /// which shows as an app with a valid token and an empty screen.
    private(set) var userId: String
    /// Which project's engine answers. Chosen from what the signed-in user can reach.
    ///
    /// Stored in the DATABASE, not UserDefaults. It used to live in both: here for the
    /// socket URL, and in `appState` for the queries that drive the session list. They were
    /// written at different moments and drifted, so the list showed whatever project came
    /// first alphabetically while the socket talked to another one.
    ///
    /// One value, one place. The database is the right place because the observations that
    /// render the app already watch it — writing it here updates the list for free.
    var projectId: String {
        didSet { try? db.setSetting(.currentProjectId, projectId) }
    }

    private let db: AppDatabase

    init(db: AppDatabase, accountId: String) {
        self.db = db
        // The account is FIXED for the life of this object: it is whose database this is.
        // It used to be a stored value that could drift from the data around it; now it is
        // simply which file is open.
        self.userId = accountId
        token = Accounts.token(for: accountId)
        let storedProject = (try? db.writer.read { try db.setting(.currentProjectId, $0) }) as? String ?? ""
        projectId = storedProject
        try? db.setSetting(.currentAccountId, accountId)
    }

    var isSignedIn: Bool { !token.isEmpty }
    var isReady: Bool { isSignedIn && !projectId.isEmpty }



    /// Signing out forgets the credential and who is here — see Accounts. The database
    /// stays: these conversations are this account's, and they may sign back in.
    func signOut() {
        Accounts.signOut()
        token = ""
    }

    /// wss://<host>/_ws/<projectId>?token=… — the handshake in clients/protocol.ts.
    var webSocketURL: URL? {
        guard var components = URLComponents(string: Self.host), !projectId.isEmpty, !token.isEmpty
        else { return nil }
        components.scheme = components.scheme == "http" ? "ws" : "wss"
        components.path = "/_ws/\(projectId)"
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        return components.url
    }

    var transcribeURL: URL? { URL(string: Self.host)?.appendingPathComponent("api/transcribe") }
}

/// Minimal Keychain wrapper for a single string value per key.
enum Keychain {
    private static func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "ai.superatom.ask",
         kSecAttrAccount as String: key]
    }

    static func get(_ key: String) -> String? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func set(_ value: String, for key: String) {
        let q = query(key)
        SecItemDelete(q as CFDictionary)
        guard !value.isEmpty, let data = value.data(using: .utf8) else { return }
        var add = q
        add[kSecValueData as String] = data
        // Readable after first unlock so a queued audio upload still works in the
        // background, but never syncs off this device.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}
