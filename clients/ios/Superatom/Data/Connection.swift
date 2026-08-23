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
    private(set) var userId: String
    /// Which project's engine answers. Chosen from what the signed-in user can reach.
    var projectId: String {
        didSet { UserDefaults.standard.set(projectId, forKey: "sa.projectId") }
    }

    init() {
        token = Keychain.get("sa.token") ?? ""
        userId = UserDefaults.standard.string(forKey: "sa.userId") ?? ""
        projectId = UserDefaults.standard.string(forKey: "sa.projectId") ?? ""
    }

    var isSignedIn: Bool { !token.isEmpty }
    var isReady: Bool { isSignedIn && !projectId.isEmpty }

    func signedIn(token: String, userId: String) {
        Keychain.set(token, for: "sa.token")
        UserDefaults.standard.set(userId, forKey: "sa.userId")
        self.token = token
        self.userId = userId
    }

    func signOut() {
        Keychain.set("", for: "sa.token")
        token = ""
        userId = ""
        projectId = ""
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
