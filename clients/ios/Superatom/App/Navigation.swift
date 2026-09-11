import Foundation
import Observation

// ── Where the app should be looking ──────────────────────────────────────────
// One request at a time: "open this conversation, and put this question in view".
//
// It exists because more than one thing needs to say it — a tapped notification, and the
// "your answer is ready" prompt shown on returning to the app. Both mean the same thing,
// so they say it the same way instead of each reaching into the view layer.
//
// The view CLEARS the request once it has acted on it, so a request is a one-shot
// instruction rather than a piece of state to keep in step.

@MainActor
@Observable
final class Navigation {
    struct Target: Equatable {
        let sessionId: String
        /// The question to bring into view. Nil simply opens the conversation.
        let questionId: String?
    }

    var target: Target?

    func open(sessionId: String, questionId: String? = nil) {
        target = Target(sessionId: sessionId, questionId: questionId)
    }

    /// Called by whichever view honoured the request.
    func consume() { target = nil }
}
