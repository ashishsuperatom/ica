import SwiftUI
import UIKit

// ── Visual tokens ────────────────────────────────────────────────────────────
// One source of truth. The app reads like a page of prose: warm paper, serif body,
// hairline rules instead of boxes, and no chat bubbles anywhere. Answers carry
// numbers and tables, so the type scale has to stay quiet enough for those to lead.

enum Theme {

    // White page, near-black ink. Deliberately neutral: an answer carries figures and
    // tables, and any warmth in the background shifts how those numbers read.
    static let paper      = dynamic(light: UIColor(red: 1.00, green: 1.00, blue: 1.00, alpha: 1), dark: UIColor(red: 0.071, green: 0.071, blue: 0.075, alpha: 1))
    static let paperInset = dynamic(light: UIColor(red: 0.965, green: 0.965, blue: 0.970, alpha: 1), dark: UIColor(red: 0.125, green: 0.125, blue: 0.133, alpha: 1))
    static let ink        = dynamic(light: UIColor(red: 0.078, green: 0.078, blue: 0.086, alpha: 1), dark: UIColor(red: 0.949, green: 0.949, blue: 0.957, alpha: 1))
    static let inkSoft    = dynamic(light: UIColor(red: 0.365, green: 0.365, blue: 0.384, alpha: 1), dark: UIColor(red: 0.667, green: 0.667, blue: 0.690, alpha: 1))
    static let inkFaint   = dynamic(light: UIColor(red: 0.576, green: 0.576, blue: 0.600, alpha: 1), dark: UIColor(red: 0.478, green: 0.478, blue: 0.502, alpha: 1))
    static let rule       = dynamic(light: UIColor(red: 0.886, green: 0.886, blue: 0.898, alpha: 1), dark: UIColor(red: 0.220, green: 0.220, blue: 0.235, alpha: 1))
    /// The one accent. Used sparingly and only for LIVE state — a connected hub, an
    /// active microphone. If it starts appearing on ordinary controls it stops meaning
    /// anything.
    static let accent     = dynamic(light: UIColor(red: 0.051, green: 0.580, blue: 0.533, alpha: 1), dark: UIColor(red: 0.176, green: 0.722, blue: 0.667, alpha: 1))
    static let warning    = dynamic(light: UIColor(red: 0.706, green: 0.216, blue: 0.145, alpha: 1), dark: UIColor(red: 0.925, green: 0.451, blue: 0.353, alpha: 1))

    // Type — serif for anything read as prose, sans for labels, mono for figures so
    // digits line up in columns.
    static func serif(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .serif)
    }
    static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }

    static let gutter: CGFloat = 24          // the page margin everything aligns to

    private static func dynamic(light: UIColor, dark: UIColor) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? dark : light })
    }
}

/// Physical feedback on user-initiated actions. Recording start is deliberately the
/// heaviest — it is the one action with a real-world consequence.
enum Haptics {
    static func light()     { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func medium()    { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
    static func heavy()     { UIImpactFeedbackGenerator(style: .heavy).impactOccurred() }
    static func selection() { UISelectionFeedbackGenerator().selectionChanged() }
    static func success()   { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func error()     { UINotificationFeedbackGenerator().notificationOccurred(.error) }
}

extension View {
    func pageBackground() -> some View { background(Theme.paper.ignoresSafeArea()) }
}

/// A hairline rule. Sections are separated by space and a line, never by a card —
/// boxes inside boxes are what make a reading surface feel like a dashboard.
struct Rule: View {
    var inset: CGFloat = Theme.gutter
    var body: some View {
        Rectangle()
            .fill(Theme.rule.opacity(0.55))
            .frame(height: 0.5)
            .padding(.horizontal, inset)
    }
}
