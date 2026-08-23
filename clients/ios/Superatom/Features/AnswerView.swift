import SwiftUI

// ── Rendering one engine answer ──────────────────────────────────────────────
// Follows the web card's design language (see ANSWER_CSS in user-ui/src/App.tsx), adapted
// to a phone: an editorial page, not a dashboard tile. The rules that carry it:
//
//   • figures sit in a band closed by a heavy rule above and a hairline below, with
//     hairlines between them — the band is what makes them read as one set of numbers
//   • the period is a filled chip, so a time filter is never mistaken for a result
//   • tables lead with a heavy rule under the header, hairlines between rows, numbers
//     right-aligned and tabular so digits line up in columns
//   • prose is quieter than the numbers; the numbers are the point

struct AnswerView: View {
    let answer: EngineAnswer

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Only the terminal case earns a label — "can't answer" changes how you read
            // everything below it. The engine's internal category does not.
            if answer.isTerminal {
                Text("CAN'T ANSWER")
                    .font(Theme.sans(10, .heavy))
                    .tracking(1.4)
                    .foregroundStyle(Theme.warning)
                    .padding(.bottom, 9)
            }

            if let prose = answer.answer, !prose.isEmpty {
                MarkdownText(raw: prose, font: Theme.sans(15), color: Theme.inkSoft, lineSpacing: 7)
                    .padding(.bottom, 14)
            }

            if let period = answer.period, !period.isEmpty {
                PeriodChip(text: period).padding(.bottom, 16)
            }

            if !answer.figures.isEmpty {
                FigureBand(figures: answer.figures).padding(.bottom, 18)
            }

            ForEach(answer.sections) { section in
                SectionView(section: section).padding(.bottom, 26)
            }

            if let caveat = answer.caveat, !caveat.isEmpty {
                MarkdownText(raw: caveat, font: Theme.sans(12.5), color: Theme.inkSoft, lineSpacing: 5)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 4).fill(Theme.paperInset)
                            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Theme.rule.opacity(0.7), lineWidth: 0.5))
                    )
                    .padding(.bottom, 10)
            }

            if hasMetadata {
                VStack(alignment: .leading, spacing: 7) {
                    Rectangle().fill(Theme.rule.opacity(0.7)).frame(height: 0.5)
                        .padding(.bottom, 4)
                    if let scope = answer.scope, !scope.isEmpty { footnote("Scope", scope) }
                    if let source = answer.source, !source.isEmpty { footnote("Source", source) }
                }
                .padding(.top, 10)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var hasMetadata: Bool {
        !(answer.scope ?? "").isEmpty || !(answer.source ?? "").isEmpty
    }

    private func footnote(_ key: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(key.uppercased())
                .font(Theme.sans(9, .bold))
                .tracking(0.8)
                .foregroundStyle(Theme.inkFaint.opacity(0.85))
                .frame(width: 46, alignment: .leading)
            Text(value)
                .font(Theme.sans(11.5))
                .foregroundStyle(Theme.inkFaint)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The time filter. A filled chip because it qualifies the numbers rather than being one
/// — without the background it reads as just another line of prose.
struct PeriodChip: View {
    let text: String

    var body: some View {
        HStack(spacing: 9) {
            Text("TIME FILTER")
                .font(Theme.sans(9.5, .heavy))
                .tracking(0.9)
                .foregroundStyle(Theme.paper)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(Theme.ink)
            Text(text)
                .font(Theme.sans(12, .semibold))
                .foregroundStyle(Theme.ink)
        }
    }
}

/// Headline numbers as one banded set: heavy rule above, hairline below, hairlines
/// between. Two per row on a phone so the values stay large enough to read at a glance.
struct FigureBand: View {
    let figures: [EngineAnswer.Figure]

    private var rows: [[EngineAnswer.Figure]] {
        stride(from: 0, to: figures.count, by: 2).map {
            Array(figures[$0..<min($0 + 2, figures.count)])
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Rectangle().fill(Theme.ink).frame(height: 1.5)
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                if index > 0 {
                    Rectangle().fill(Theme.rule.opacity(0.6)).frame(height: 0.5)
                }
                HStack(alignment: .top, spacing: 0) {
                    ForEach(Array(row.enumerated()), id: \.offset) { position, figure in
                        if position > 0 {
                            Rectangle().fill(Theme.rule.opacity(0.6)).frame(width: 0.5)
                        }
                        cell(figure, isFirst: position == 0)
                    }
                    if row.count == 1 { Color.clear.frame(maxWidth: .infinity) }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            Rectangle().fill(Theme.rule).frame(height: 1)
        }
    }

    private func cell(_ figure: EngineAnswer.Figure, isFirst: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(figure.label.uppercased())
                .font(Theme.sans(9.5, .bold))
                .tracking(0.7)
                .foregroundStyle(Theme.inkFaint)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Text(figure.display)
                .font(.system(size: 25, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(figure.neg == true ? Theme.warning : Theme.ink)
                .minimumScaleFactor(0.5)
                .lineLimit(1)
            if let sub = figure.sub, !sub.isEmpty {
                Text(sub)
                    .font(Theme.sans(11.5))
                    .foregroundStyle(Theme.inkFaint)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, isFirst ? 0 : 14)
        .padding(.trailing, 10)
        .padding(.vertical, 12)
    }
}

/// One block of a multi-block report: a table, a row of numbers, or prose.
struct SectionView: View {
    let section: EngineAnswer.Section

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            if let title = section.title, !title.isEmpty {
                Text(title)
                    .font(Theme.serif(16, .semibold))
                    .foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 2)
            }

            switch section.kind {
            case .kpis:
                FigureBand(figures: section.items)
            case .table:
                TableView(columns: section.columns, rows: section.rows,
                          total: section.total.isEmpty ? nil : section.total)
            case .text:
                if let body = section.body, !body.isEmpty {
                    MarkdownText(raw: body, font: Theme.sans(14.5), color: Theme.inkSoft, lineSpacing: 6)
                }
            }

            if let note = section.note, !note.isEmpty {
                Text(note)
                    .font(Theme.sans(11))
                    .foregroundStyle(Theme.inkFaint)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
