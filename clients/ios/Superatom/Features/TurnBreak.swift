import SwiftUI

/// The end of one exchange and the start of the next.
///
/// A plain hairline isn't enough here: answers contain their own rules — around figure
/// bands, under table headers — so another thin line reads as more of the same. This is
/// deliberately a different mark, with air around it, so scrolling past you can see where
/// one question ended without reading a word.
struct TurnBreak: View {
    var body: some View {
        HStack(spacing: 6) {
            Rectangle().fill(Theme.rule).frame(height: 0.5)
            Circle().fill(Theme.rule).frame(width: 3, height: 3)
            Rectangle().fill(Theme.rule).frame(height: 0.5)
        }
        .padding(.horizontal, Theme.gutter)
    }
}

/// Where the conversation could go next.
///
/// Deliberately compact and quiet: these are asides, not content. They sit below the
/// answer and must not compete with it for attention or for vertical space — a phone
/// screen spent on suggestions is a screen not spent on the report.
///
/// Tapping one does NOT ask it — it becomes a draft in the composer with Send and Cancel,
/// exactly like a spoken question. A suggestion is the engine's idea, not yours, and it
/// should pass through the same moment of consent before it costs a run.
struct FollowUps: View {
    let items: [String]
    let onPick: (String) -> Void

    var body: some View {
        if items.isEmpty {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 5) {
                Text("NEXT")
                    .font(Theme.sans(9, .heavy))
                    .tracking(1.1)
                    .foregroundStyle(Theme.inkFaint)
                    .padding(.bottom, 1)
                ForEach(items, id: \.self) { item in
                    Button {
                        Haptics.light()
                        onPick(item)
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 7) {
                            Image(systemName: "arrow.turn.down.right")
                                .font(Theme.sans(9, .semibold))
                                .foregroundStyle(Theme.accent)
                            Text(item)
                                .font(Theme.sans(13))
                                .foregroundStyle(Theme.inkSoft)
                                .multilineTextAlignment(.leading)
                                .lineSpacing(2)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: 9).fill(Theme.paperInset)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 4)
            .padding(.bottom, 2)
        }
    }
}
