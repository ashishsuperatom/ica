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
    /// Rows that MATCHED upstream, when the engine sent a sample.
    var totalRows: Int?
    var title: String?

    /// Same page size as the web card. 220 rows dumped into a phone screen is not a
    /// table, it is a wall — and it pushes everything after it out of reach.
    private static let page = 25

    @State private var shown = TableView.page
    @State private var exported: URL?
    private let columnGap: CGFloat = 20

    private var visible: [[JSONValue]] { Array(rows.prefix(shown)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            grid
            if shown < rows.count { showMore }
            footer
        }
    }

    /// "Show more" sits OUTSIDE the horizontal scroll, so it stays reachable however far
    /// sideways the table has been scrolled.
    private var showMore: some View {
        Button {
            Haptics.light()
            shown = min(shown + Self.page, rows.count)
        } label: {
            Text("Show more  (\(rows.count - shown) more)")
                .font(Theme.sans(12, .medium))
                .foregroundStyle(Theme.ink)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .overlay(alignment: .top) { Rectangle().fill(Theme.rule).frame(height: 0.5) }
                .overlay(alignment: .bottom) { Rectangle().fill(Theme.rule).frame(height: 0.5) }
        }
        .buttonStyle(.plain)
    }

    /// The honest count. A table showing 25 of 220 must SAY so — otherwise the number you
    /// act on is a sample you believed was the whole thing.
    private var footer: some View {
        HStack(spacing: 8) {
            Text(countLabel)
                .font(Theme.sans(11))
                .foregroundStyle(Theme.inkFaint)
            Spacer()
            if let url = csvURL {
                ShareLink(item: url) {
                    HStack(spacing: 4) {
                        Image(systemName: "square.and.arrow.up").font(Theme.sans(11))
                        Text("CSV").font(Theme.sans(11, .medium))
                    }
                    .foregroundStyle(Theme.inkSoft)
                }
            }
        }
        .padding(.top, 8)
    }

    private var countLabel: String {
        if let totalRows, totalRows > rows.count {
            return "\(rows.count.formatted()) of \(totalRows.formatted()) matching rows"
        }
        if shown < rows.count { return "showing \(shown) of \(rows.count.formatted()) rows" }
        return rows.count == 1 ? "1 row" : "\(rows.count.formatted()) rows"
    }

    /// CSV of EVERY row, not just the visible page — exporting a sample would be a trap.
    private var csvURL: URL? {
        guard !rows.isEmpty else { return nil }
        var lines = [columns.map(Self.escape).joined(separator: ",")]
        lines.append(contentsOf: rows.map { $0.map { Self.escape($0.copyText) }.joined(separator: ",") })
        if let total, !total.isEmpty {
            lines.append(total.map { Self.escape($0.copyText) }.joined(separator: ","))
        }
        let name = (title ?? "table").replacingOccurrences(of: " ", with: "-")
            .components(separatedBy: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-")).inverted)
            .joined()
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(name.isEmpty ? "table" : name).csv")
        do {
            try lines.joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
            return url
        } catch { return nil }
    }

    private static func escape(_ field: String) -> String {
        field.contains(where: { $0 == "," || $0 == "\"" || $0 == "\n" })
            ? "\"" + field.replacingOccurrences(of: "\"", with: "\"\"") + "\""
            : field
    }

    @ViewBuilder
    private var grid: some View {
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

                    ForEach(Array(visible.enumerated()), id: \.offset) { index, row in
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
