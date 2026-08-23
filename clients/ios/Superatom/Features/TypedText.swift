import SwiftUI

/// Text that writes itself in, word by word.
///
/// Transcription finishing is the moment the app shows it understood you, and having the
/// sentence simply appear reads as a jump. Writing it out makes the wait legible as
/// progress instead — and, quietly, gives you a beat to read it before deciding to send.
///
/// Word by word rather than character by character: characters look like a typewriter
/// gimmick at this size, and a long question would take too long to finish.
struct TypedText: View {
    let text: String
    /// Whole reveal duration, regardless of length — a long transcript types faster per
    /// word rather than making anyone wait longer.
    var duration: Double = 0.5

    @State private var shown = 0
    @State private var typed = ""

    var body: some View {
        Text(typed.isEmpty ? text : typed)
            .opacity(typed.isEmpty && shown == 0 ? 0 : 1)
            .task(id: text) { await reveal() }
    }

    private func reveal() async {
        let words = text.split(separator: " ", omittingEmptySubsequences: false)
        guard words.count > 1 else { typed = text; shown = words.count; return }

        typed = ""
        shown = 0
        let step = UInt64((duration / Double(words.count)) * 1_000_000_000)
        for index in words.indices {
            typed = words[...index].joined(separator: " ")
            shown = index + 1
            try? await Task.sleep(nanoseconds: step)
            if Task.isCancelled { typed = text; return }
        }
        typed = text
    }
}
