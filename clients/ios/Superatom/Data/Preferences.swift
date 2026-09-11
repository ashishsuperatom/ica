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

    /// Subscribe to the program's own log channel.
    ///
    /// This is not a display toggle. When it is off the app does not ATTACH to the channel,
    /// so the engine never sends those events at all — they do not cross the wire, are not
    /// parsed, and are not stored. Filtering them on arrival would still pay for every
    /// line of a chatty program over a mobile connection.
    var showProgramLogs: Bool {
        didSet {
            store.set(showProgramLogs, forKey: Key.showProgramLogs)
            onProgramLogsChanged?(showProgramLogs)
        }
    }

    /// Set by Services so a change attaches or detaches immediately, without a reconnect.
    var onProgramLogsChanged: ((Bool) -> Void)?

    /// Show how long each step took, and how long the turn has been running.
    ///
    /// OFF by default, and the reasoning is not that the number is uninteresting — it is
    /// that a visible clock turns waiting into watching a clock. Someone who asked a
    /// business question reads "94s" as the system being slow; someone building the system
    /// reads it as where to look next. Same number, opposite effect, so it belongs to
    /// whoever wants it rather than being shown to everyone.
    var showTimings: Bool {
        didSet { store.set(showTimings, forKey: Key.showTimings) }
    }

    private let store: UserDefaults

    private enum Key {
        static let showFollowUps = "sa.pref.showFollowUps"
        static let transcribeOnDevice = "sa.pref.transcribeOnDevice"
        static let showProgramLogs = "sa.pref.showProgramLogs"
        static let showTimings = "sa.pref.showTimings"
    }

    init(store: UserDefaults = .standard) {
        self.store = store
        // `object(forKey:)` rather than `bool(forKey:)`: bool returns false for a missing
        // key, which would silently make the default OFF instead of ON.
        showFollowUps = (store.object(forKey: Key.showFollowUps) as? Bool) ?? true
        transcribeOnDevice = (store.object(forKey: Key.transcribeOnDevice) as? Bool) ?? true
        showProgramLogs = (store.object(forKey: Key.showProgramLogs) as? Bool) ?? true
        showTimings = (store.object(forKey: Key.showTimings) as? Bool) ?? false
    }
}
