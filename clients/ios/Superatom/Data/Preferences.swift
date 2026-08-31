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

    /// Transcribe on this device, or send the audio to the platform.
    ///
    /// EXACTLY ONE of them runs. Running both meant two transcripts finishing at
    /// different times for the same spoken question, which is a race with no good
    /// resolution — whichever lands second wants to change a turn the reader may already
    /// have sent.
    ///
    /// On-device is the default on iOS: instant, offline, free. Hosted exists for
    /// languages with no on-device model, and is the path Android will use until it has
    /// an equivalent.
    var transcribeOnDevice: Bool {
        didSet { store.set(transcribeOnDevice, forKey: Key.transcribeOnDevice) }
    }

    private let store: UserDefaults

    private enum Key {
        static let showFollowUps = "sa.pref.showFollowUps"
        static let transcribeOnDevice = "sa.pref.transcribeOnDevice"
    }

    init(store: UserDefaults = .standard) {
        self.store = store
        // `object(forKey:)` rather than `bool(forKey:)`: bool returns false for a missing
        // key, which would silently make the default OFF instead of ON.
        showFollowUps = (store.object(forKey: Key.showFollowUps) as? Bool) ?? true
        transcribeOnDevice = (store.object(forKey: Key.transcribeOnDevice) as? Bool) ?? true
    }
}
