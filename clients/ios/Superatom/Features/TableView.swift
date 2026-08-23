import SwiftUI

// ── A table on a phone ───────────────────────────────────────────────────────
// Heavy rule under the header, hairlines between rows, numbers right-aligned and
// tabular — the web card's rules, which are also just how financial tables are read.
//
// Cells do not wrap. Wrapping makes rows different heights and destroys the vertical
// scan that a table exists for, so the table scrolls sideways instead, inside its own
// bounds. The page itself never scrolls horizontally.

struct TableView: View {
    let columns: [String]
    let rows: [[JSONValue]]
    var total: [JSONValue]?

    private let columnGap: CGFloat = 20

    var body: some View {
        if columns.isEmpty && rows.isEmpty {
            EmptyView()
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                // Grid keeps one set of column widths across every row. Independent
                // stacks per row look aligned in a mockup and drift with real data.
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: columnGap, verticalSpacing: 0) {
                    if !columns.isEmpty {
                        GridRow {
                            ForEach(Array(columns.enumerated()), id: \.offset) { index, name in
                                Text(name.uppercased())
                                    .font(Theme.sans(9.5, .semibold))
                                    .tracking(0.9)
                                    .foregroundStyle(Theme.inkFaint)
                                    .lineLimit(1)
                                    .gridColumnAlignment(isNumeric(index) ? .trailing : .leading)
                            }
                        }
                        .padding(.bottom, 7)
                        rule(1.5, Theme.ink)
                    }

                    ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                        if index > 0 { rule(0.5, Theme.rule.opacity(0.75)) }
                        GridRow { cells(row, weight: .regular, color: Theme.inkSoft) }
                    }

                    if let total, !total.isEmpty {
                        rule(1, Theme.rule)
                        GridRow { cells(total, weight: .semibold, color: Theme.ink) }
                    }
                }
                .padding(.trailing, 2)   // so the last column isn't flush to the edge mid-scroll
            }
        }
    }

    private func rule(_ height: CGFloat, _ color: Color) -> some View {
        Rectangle()
            .fill(color)
            .frame(height: height)
            .gridCellUnsizedAxes(.horizontal)
            .gridCellColumns(max(columns.count, rows.first?.count ?? 1))
    }

    @ViewBuilder
    private func cells(_ row: [JSONValue], weight: Font.Weight, color: Color) -> some View {
        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
            Text(cell.display)
                .font(Theme.sans(13.5, weight))
                .monospacedDigit()
                .foregroundStyle(cell.isNumeric ? Theme.ink : color)
                .lineLimit(1)
                .padding(.vertical, 8)
        }
    }

    /// A column is numeric if its first data cell is — so the heading sits over its digits.
    private func isNumeric(_ index: Int) -> Bool {
        rows.first.flatMap { $0.indices.contains(index) ? $0[index] : nil }?.isNumeric == true
    }
}
