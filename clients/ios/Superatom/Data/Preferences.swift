import Foundation
import Observation

// ── What the reader has chosen ───────────────────────────────────────────────
// Small, deliberate, and stored in UserDefaults — these are display choices, not data.
// Kept as one object rather than @AppStorage scattered through views so the defaults live
// in a single place and a new setting has an obvious home.

@MainActor
@Observable
final class Preferences {

    /// Show the engine's suggested next questions under an answer.
    ///
    /// On by default because they are genuinely useful for exploring; off for anyone who
    /// finds them a distraction, or who does not want a tappable thing that costs a run
    /// sitting beneath every answer.
    var showFollowUps: Bool {
        didSet { store.set(showFollowUps, forKey: Key.showFollowUps) }
    }

    private let store: UserDefaults

    private enum Key {
        static let showFollowUps = "sa.pref.showFollowUps"
    }

    init(store: UserDefaults = .standard) {
        self.store = store
        // `object(forKey:)` rather than `bool(forKey:)`: bool returns false for a missing
        // key, which would silently make the default OFF instead of ON.
        showFollowUps = (store.object(forKey: Key.showFollowUps) as? Bool) ?? true
    }
}
