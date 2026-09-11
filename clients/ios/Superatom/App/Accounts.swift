import Foundation

// ── Which account this device is signed into ─────────────────────────────────
// Several people can use one phone — one at a time — and each gets their OWN database.
// Signing out does not delete it: coming back to an account finds its conversations where
// they were.
//
// This pointer therefore CANNOT live in a database, because it is what decides which
// database to open. UserDefaults is the right home for exactly one value of this kind.

enum Accounts {
    private static let currentKey = "sa.currentAccount"

    /// The signed-in account, or nil when nobody is.
    static var current: String? {
        get {
            let value = UserDefaults.standard.string(forKey: currentKey)
            return (value?.isEmpty ?? true) ? nil : value
        }
        set { UserDefaults.standard.set(newValue, forKey: currentKey) }
    }

    /// Tokens are per account, so signing out of one leaves the other's credential alone.
    static func token(for accountId: String) -> String {
        Keychain.get("sa.token." + accountId) ?? ""
    }

    static func setToken(_ token: String, for accountId: String) {
        Keychain.set(token, for: "sa.token." + accountId)
    }

    /// Sign out: forget who is here and drop the credential. The DATABASE stays — the
    /// conversations are theirs, and they may sign back in.
    static func signOut() {
        if let account = current { Keychain.set("", for: "sa.token." + account) }
        current = nil
    }
}
