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
            VStack(alignment: .leading, spacing: 7) {
                Text("NEXT")
                    .font(Theme.sans(9.5, .heavy))
                    .tracking(1.2)
                    .foregroundStyle(Theme.inkFaint)
                ForEach(items, id: \.self) { item in
                    Button {
                        Haptics.light()
                        onPick(item)
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 9) {
                            Text(item)
                                .font(Theme.serif(15))
                                .foregroundStyle(Theme.ink)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 4)
                            Image(systemName: "arrow.up.left")
                                .font(Theme.sans(11, .semibold))
                                .foregroundStyle(Theme.accent)
                        }
                        .padding(.horizontal, 13)
                        .padding(.vertical, 11)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: 12).fill(Theme.paperInset)
                                .overlay(RoundedRectangle(cornerRadius: 12)
                                    .stroke(Theme.rule.opacity(0.8), lineWidth: 0.5))
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 4)
        }
    }
}
