import Foundation
import UserNotifications
import UIKit
import Observation

// ── "Tell me when it's done" ─────────────────────────────────────────────────
// A local notification, scheduled on this device when the answer lands. No push service,
// no server, no device token — the app is already running the socket that will receive
// the answer, so it is the thing best placed to say so.
//
// Deliberately OPT-IN PER QUESTION rather than a global setting. Most answers arrive
// quickly enough to wait for; the ones that don't are the ones worth being told about, and
// asking for permission at the moment someone actually wants it is far likelier to be
// granted than asking at launch for a reason they cannot yet see.

@MainActor
@Observable
final class Notifier: NSObject {

    /// Questions the reader asked to be told about, and when they asked.
    ///
    /// PERSISTED, because the arming has to outlive the app. iOS suspends and eventually
    /// kills a backgrounded app — which is exactly the situation someone arms this for — so
    /// keeping it in memory meant the app could quietly fail to keep the one promise it had
    /// made. Aged out after a day: an answer that never came is not worth announcing later.
    private(set) var armed: [String: Date] = [:] {
        didSet { Self.save(armed) }
    }

    private static let storeKey = "sa.notify.armed"
    private static let maxAge: TimeInterval = 24 * 3600

    private static func load() -> [String: Date] {
        let raw = UserDefaults.standard.dictionary(forKey: storeKey) as? [String: Double] ?? [:]
        let cutoff = Date.now.addingTimeInterval(-maxAge)
        return raw.compactMapValues { stamp in
            let date = Date(timeIntervalSince1970: stamp)
            return date > cutoff ? date : nil
        }
    }

    private static func save(_ value: [String: Date]) {
        UserDefaults.standard.set(value.mapValues(\.timeIntervalSince1970), forKey: storeKey)
    }

    /// Set by Services: a tapped notification asks for that question to be shown.
    var onOpen: ((String) -> Void)?

    private let center = UNUserNotificationCenter.current()

    override init() {
        super.init()
        armed = Self.load()
        center.delegate = self
    }

    func isArmed(_ questionId: String) -> Bool { armed[questionId] != nil }

    /// Ask to be told when this question is answered. Requests permission the first time.
    /// Returns false if permission was refused, so the caller can say so rather than
    /// arming something that will never fire.
    @discardableResult
    func arm(questionId: String) async -> Bool {
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
        let settings = await center.notificationSettings()
        NSLog("[notify] arm qid=%@ granted=%@ authStatus=%ld alert=%ld",
              questionId, granted ? "yes" : "no",
              settings.authorizationStatus.rawValue, settings.alertSetting.rawValue)
        guard granted else { return false }
        armed[questionId] = .now
        return true
    }

    func disarm(questionId: String) {
        armed[questionId] = nil
        center.removePendingNotificationRequests(withIdentifiers: [questionId])
        center.removeDeliveredNotifications(withIdentifiers: [questionId])
    }

    /// The answer (or failure) for a question arrived. Fires only if it was asked for.
    func deliver(questionId: String, question: String, body: String) {
        guard armed.removeValue(forKey: questionId) != nil else {
            NSLog("[notify] answer for qid=%@ but not armed", questionId)
            return
        }

        // Someone looking at the app does not need to be told. iOS would suppress the
        // BANNER on its own, but it would still deliver — leaving a notification sitting in
        // Notification Center for an answer already read, to be tapped later and lead
        // nowhere. So nothing is posted at all while the app is active.
        //
        // Only `.active` counts as watching. `.inactive` covers the moments in between —
        // the switcher, a pulled-down Notification Center — where the answer is genuinely
        // not being seen.
        let state = UIApplication.shared.applicationState
        guard state != .active else {
            NSLog("[notify] skipped for qid=%@ — app is in the foreground", questionId)
            return
        }

        let content = UNMutableNotificationContent()
        // The question is the title, because that is what identifies WHICH answer this is
        // when three have been asked.
        content.title = question.isEmpty ? "Your answer is ready" : String(question.prefix(80))
        content.body = body
        content.sound = .default
        content.userInfo = ["qid": questionId]

        // nil trigger = deliver now. iOS suppresses it while the app is in the foreground
        // unless we say otherwise, which is the behaviour we want: someone already looking
        // at the screen does not need to be told.
        center.add(UNNotificationRequest(identifier: questionId, content: content, trigger: nil)) { error in
            NSLog("[notify] posted qid=%@ %@", questionId, error.map { "FAILED: \($0.localizedDescription)" } ?? "ok")
        }
    }
}

extension Notifier: UNUserNotificationCenterDelegate {
    /// A tapped notification names the question it was about, so it opens that answer
    /// rather than the app. Being dropped at the session list to hunt for it would make the
    /// notification a interruption rather than a shortcut.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        let qid = response.notification.request.content.userInfo["qid"] as? String
        await MainActor.run { self.onOpen?(qid ?? response.notification.request.identifier) }
    }
}
