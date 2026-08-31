import SwiftUI

// ── Text that arrives ────────────────────────────────────────────────────────
// Transcription finishing is the moment the app shows it understood you, and having the
// sentence simply appear reads as a jump.
//
// The naive way — append a word to a String on a timer — is what this replaces. Growing
// the string re-wraps the whole paragraph on every tick, so lines reflow, later words
// shift around, and the result looks like flickering rather than writing.
//
// The way it is normally done: lay out the FINAL text once, so geometry never moves, and
// animate each word into its already-decided position. Every word fades up from slightly
// below with the blur coming off, staggered a few tens of milliseconds apart. Nothing
// reflows, so the eye can actually follow the sentence being formed.

struct TypedText: View {
    let text: String
    /// Per-word stagger.
    ///
    /// This started at 45ms, tuned when the transcript came from the server a second or
    /// more after you stopped speaking — the reveal filled a wait that already existed.
    /// On-device transcription removed that wait, so the animation became the ONLY thing
    /// to wait for. It is now a flourish that confirms the words arrived, not a reveal
    /// that paces them.
    let step: Double
    /// The whole reveal is capped, so a long transcript animates faster per word rather
    /// than making anyone wait longer to read it.
    let maxDuration: Double

    @State private var revealed = false

    /// Split once, in init — `body` runs on every animation frame while the reveal is
    /// playing, and re-splitting the string on each of them is work for nothing.
    private let words: [String]
    private let stagger: Double

    init(text: String, step: Double = 0.016, maxDuration: Double = 0.3) {
        self.text = text
        self.step = step
        self.maxDuration = maxDuration
        let words = text.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        self.words = words
        self.stagger = words.count > 1 ? min(step, maxDuration / Double(words.count)) : 0
    }

    var body: some View {
        WrappingLayout(spacing: 4.5, lineSpacing: 6) {
            ForEach(Array(words.enumerated()), id: \.offset) { index, word in
                Text(word)
                    .opacity(revealed ? 1 : 0)
                    .blur(radius: revealed ? 0 : 2.5)
                    .offset(y: revealed ? 0 : 5)
                    .animation(
                        .easeOut(duration: 0.18).delay(Double(index) * stagger),
                        value: revealed
                    )
            }
        }
        // Keyed on the text: a new transcript re-runs the reveal instead of appearing
        // fully formed because the view happened to be alive already.
        .task(id: text) {
            revealed = false
            // One frame in the hidden state, so the animation has somewhere to come from.
            try? await Task.sleep(nanoseconds: 16_000_000)
            revealed = true
        }
    }
}

/// Lays subviews out left to right, wrapping to the next line — what a paragraph does,
/// which SwiftUI has no built-in layout for once you need per-word control.
struct WrappingLayout: Layout {
    var spacing: CGFloat = 4
    var lineSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        let rows = rows(subviews: subviews, width: width)
        let height = rows.reduce(0) { $0 + $1.height } + lineSpacing * CGFloat(max(0, rows.count - 1))
        let widest = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? widest, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(subviews: subviews, width: bounds.width) {
            var x = bounds.minX
            for index in row.range {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2),
                                      proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + lineSpacing
        }
    }

    private struct Row {
        var range: Range<Int>
        var width: CGFloat
        var height: CGFloat
    }

    private func rows(subviews: Subviews, width: CGFloat) -> [Row] {
        var rows: [Row] = []
        var start = 0
        var x: CGFloat = 0
        var height: CGFloat = 0

        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let needed = x == 0 ? size.width : x + spacing + size.width
            if needed > width, index > start {
                rows.append(Row(range: start..<index, width: x, height: height))
                start = index
                x = size.width
                height = size.height
            } else {
                x = needed
                height = max(height, size.height)
            }
        }
        if start < subviews.endIndex {
            rows.append(Row(range: start..<subviews.endIndex, width: x, height: height))
        }
        return rows
    }
}
