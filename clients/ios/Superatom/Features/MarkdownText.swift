import SwiftUI

// ── Block-level markdown ─────────────────────────────────────────────────────
// SwiftUI's AttributedString(markdown:) handles emphasis inside ONE line and nothing
// else — no line breaks, no lists, and no tables. The engine emits all three, so prose
// that contained a table was arriving as a wall of pipe characters.
//
// This splits the text into blocks and renders each properly: a pipe table becomes a
// real table, a bullet run becomes a list, and everything else stays prose with its line
// breaks intact. Emphasis is still handled per line by AttributedString.

struct MarkdownText: View {
    let raw: String
    var font: Font = Theme.serif(16)
    var color: Color = Theme.ink
    var lineSpacing: CGFloat = 6

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(MarkdownBlock.cached(raw).enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let text):
                    inline(text)
                case .bullets(let items):
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text("•").font(font).foregroundStyle(Theme.inkFaint)
                                inline(item)
                            }
                        }
                    }
                case .table(let columns, let rows):
                    TableView(columns: columns, rows: rows)
                }
            }
        }
    }

    private func inline(_ text: String) -> some View {
        Text(attributed(text))
            .font(font)
            .foregroundStyle(color)
            .lineSpacing(lineSpacing)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func attributed(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text,
                               options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}

enum MarkdownBlock {
    /// Parsed blocks, keyed by the source text.
    ///
    /// `body` runs on EVERY render pass, and this view renders answer prose, caveats,
    /// section bodies and every narration beat — the last of which re-renders once a
    /// second while a question is running. Re-parsing markdown each time is pure waste,
    /// and the same text always produces the same blocks, so it is cached and never needs
    /// invalidating.
    static func cached(_ raw: String) -> [MarkdownBlock] {
        if let hit = store.object(forKey: raw as NSString) { return hit.blocks }
        let blocks = parse(raw)
        store.setObject(Parsed(blocks), forKey: raw as NSString)
        return blocks
    }

    private final class Parsed { let blocks: [MarkdownBlock]; init(_ b: [MarkdownBlock]) { blocks = b } }
    private static let store = NSCache<NSString, Parsed>()

    case paragraph(String)
    case bullets([String])
    case table(columns: [String], rows: [[JSONValue]])

    /// Group lines into blocks. Deliberately small: the engine is told to emit simple
    /// markdown, and a full parser here would be a liability, not an asset.
    static func parse(_ raw: String) -> [MarkdownBlock] {
        let lines = raw.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var bullets: [String] = []
        var table: [String] = []

        func flushParagraph() {
            let text = paragraph.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { blocks.append(.paragraph(text)) }
            paragraph = []
        }
        func flushBullets() {
            if !bullets.isEmpty { blocks.append(.bullets(bullets)); bullets = [] }
        }
        func flushTable() {
            defer { table = [] }
            guard table.count >= 2 else {
                // Not actually a table — put the lines back as prose rather than losing them.
                paragraph.append(contentsOf: table)
                return
            }
            let columns = cells(table[0])
            // Row 1 of a markdown table is the |---|---| separator.
            let body = table.dropFirst(isSeparator(table[1]) ? 2 : 1)
            let rows = body.map { line in cells(line).map { JSONValue.parse($0) } }
            blocks.append(.table(columns: columns, rows: Array(rows)))
        }

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("|") && trimmed.hasSuffix("|") && trimmed.count > 1 {
                flushParagraph(); flushBullets()
                table.append(trimmed)
            } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
                flushParagraph(); flushTable()
                bullets.append(String(trimmed.dropFirst(2)))
            } else if trimmed.isEmpty {
                flushParagraph(); flushBullets(); flushTable()
            } else {
                flushBullets(); flushTable()
                paragraph.append(line)
            }
        }
        flushParagraph(); flushBullets(); flushTable()
        return blocks
    }

    private static func cells(_ line: String) -> [String] {
        line.trimmingCharacters(in: CharacterSet(charactersIn: "|"))
            .components(separatedBy: "|")
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func isSeparator(_ line: String) -> Bool {
        let body = line.replacingOccurrences(of: "|", with: "").trimmingCharacters(in: .whitespaces)
        return !body.isEmpty && body.allSatisfy { $0 == "-" || $0 == ":" || $0 == " " }
    }
}

extension JSONValue {
    /// A markdown cell is text; recover numbers so they right-align and group like the
    /// engine's own numeric columns.
    static func parse(_ text: String) -> JSONValue {
        if text.isEmpty || text == "—" || text == "-" { return .null }
        let cleaned = text.replacingOccurrences(of: ",", with: "")
        if let number = Double(cleaned) { return .number(number) }
        return .string(text)
    }
}
