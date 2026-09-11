import SwiftUI

// ── A table on a phone ───────────────────────────────────────────────────────
// Heavy rule under the header, hairlines between rows, numbers right-aligned and
// tabular — the web card's rules, which are also just how financial tables are read.
//
// Cells do not wrap. Wrapping makes rows different heights and destroys the vertical
// scan that a table exists for, so the table scrolls sideways instead, inside its own
// bounds. The page itself never scrolls horizontally.

struct TableView: View {
    let columns: [ColumnSpec]
    let rows: [[Cell]]
    var total: [Cell]?
    /// Tapping a cell that names something asks to open it. Nil = nothing is openable.
    var onEntity: ((_ entity: String, _ id: String, _ label: String) -> Void)?
    /// Rows that MATCHED upstream, when the engine sent a sample.
    var totalRows: Int?
    var title: String?

    /// Same page size as the web card. 220 rows dumped into a phone screen is not a
    /// table, it is a wall — and it pushes everything after it out of reach.
    private static let page = 25

    @State private var shown = TableView.page
    /// Export is revealed by touching the table, then hides itself again.
    @State private var showExport = false
    @State private var hideExport: Task<Void, Never>?

    /// How long the export stays available after a touch. The web reveals it on hover;
    /// a phone has no hover, and a permanently visible export button competes with the
    /// data for attention when almost nobody is exporting. Long enough to notice it and
    /// reach it, short enough that it stops being furniture.
    private static let exportVisible: Duration = .seconds(10)
    private let columnGap: CGFloat = 20

    private var visible: [[Cell]] { Array(rows.prefix(shown)) }

    /// The largest magnitude per column, for the in-cell bar. Taken from the data because a
    /// bar is only meaningful against the column it sits in — nothing to declare and
    /// nothing to keep in step.
    private var peaks: [Double] {
        columns.indices.map { index in
            guard columns[index].bar else { return 0 }
            return rows.compactMap { $0.indices.contains(index) ? $0[index].number.map(abs) : nil }.max() ?? 0
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            grid
                .contentShape(Rectangle())
                .onTapGesture { revealExport() }
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
            if showExport, let url = csvURL {
                ShareLink(item: url) {
                    HStack(spacing: 5) {
                        Image(systemName: "square.and.arrow.up").font(Theme.sans(11, .semibold))
                        Text("CSV").font(Theme.sans(12, .medium))
                    }
                    .foregroundStyle(Theme.inkSoft)
                    .padding(.horizontal, 12)
                    .frame(height: 32)
                    .background(Capsule().fill(Theme.paperInset))
                    .contentShape(Rectangle())
                }
                .transition(.opacity.combined(with: .scale(scale: 0.94, anchor: .trailing)))
            }
        }
        .frame(minHeight: 32)          // reserve the row, so revealing it moves nothing
        .padding(.top, 8)
        .animation(.easeOut(duration: 0.18), value: showExport)
    }

    /// Touching the table offers the export, and each touch restarts the clock.
    private func revealExport() {
        guard csvURL != nil else { return }
        if !showExport { Haptics.light() }
        showExport = true
        hideExport?.cancel()
        hideExport = Task {
            try? await Task.sleep(for: Self.exportVisible)
            guard !Task.isCancelled else { return }
            showExport = false
        }
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
        var lines = [columns.map { Self.escape($0.label) }.joined(separator: ",")]
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
                            ForEach(Array(columns.enumerated()), id: \.offset) { index, column in
                                Text(column.label.uppercased())
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
    private func cells(_ row: [Cell], weight: Font.Weight, color: Color) -> some View {
        ForEach(Array(row.enumerated()), id: \.offset) { index, cell in
            let column = index < columns.count ? columns[index] : ColumnSpec(label: "")
            let peak = index < peaks.count ? peaks[index] : 0
            cellView(cell, column: column, peak: peak, weight: weight, color: color)
        }
    }

    @ViewBuilder
    private func cellView(_ cell: Cell, column: ColumnSpec, peak: Double,
                          weight: Font.Weight, color: Color) -> some View {
        // GOOD OR BAD is the program's call, never ours. `good` says which direction is
        // favourable and `mid` is the line it turns on. No declaration, no colour.
        let tone: Color? = {
            guard let good = column.good, let n = cell.number, n != column.mid else { return nil }
            return (n > column.mid) == (good == "high") ? Theme.positive : Theme.warning
        }()

        let text = Text(cell.text)
            .font(cell.isNumeric ? Theme.mono(13.5, weight) : Theme.sans(13.5, weight))
            .monospacedDigit()
            .lineLimit(1)
            .padding(.vertical, 8)
            .padding(.horizontal, 4)

        Group {
            if let entity = column.entity, let id = cell.id, let onEntity {
                // A cell that NAMES something is the only tappable thing in a table, and it
                // says so by being coloured. Everything else stays ink.
                Button {
                    Haptics.light()
                    onEntity(entity, id, cell.text)
                } label: {
                    text.foregroundStyle(Theme.link)
                }
                .buttonStyle(.plain)
            } else {
                text.foregroundStyle(tone ?? (cell.isNumeric ? Theme.ink : color))
            }
        }
        .background(alignment: .trailing) {
            // THE BAR IS THE CELL'S OWN GROUND, filling from the right behind a
            // right-aligned figure. A rule under the number read as an underline belonging
            // to nothing and pushed every row taller; a shaded ground costs no space at all.
            if column.bar, let n = cell.number, peak > 0 {
                GeometryReader { geo in
                    Rectangle()
                        .fill((tone ?? Theme.accent).opacity(0.13))
                        .frame(width: geo.size.width * min(1, abs(n) / peak))
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
        }
    }

    /// A column is numeric if its first data cell is — so the heading sits over its digits.
    private func isNumeric(_ index: Int) -> Bool {
        rows.first.flatMap { $0.indices.contains(index) ? $0[index] : nil }?.isNumeric == true
    }
}
