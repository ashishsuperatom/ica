import Foundation

// ── The engine's Answer, as this app reads it ────────────────────────────────
// Mirrors clients/protocol.ts — the ONE JSON every surface renders its own way.
//
// Parsed by hand rather than with Codable, deliberately. Codable is all-or-nothing: one
// unexpected field type anywhere and the ENTIRE answer fails to decode, so a whole
// report is lost because a single figure came back as a number instead of a string.
// That is exactly what happened. Everything below coerces rather than throws — a value
// we can't read becomes empty, and the rest of the report still renders.

struct EngineAnswer: Hashable {
    var status: String?
    var category: String?
    var answer: String?          // prose
    var period: String?
    var scope: String?
    var source: String?
    var caveat: String?
    var figures: [Figure] = []
    var sections: [Section] = []

    var isTerminal: Bool { status == "unknowable" || status == "cannot_answer" }

    /// True when there is genuinely nothing to draw — used to fall back to raw output
    /// rather than rendering an empty card.
    var isEmpty: Bool {
        (answer ?? "").isEmpty && figures.isEmpty && sections.isEmpty && (caveat ?? "").isEmpty
    }

    struct Figure: Hashable, Identifiable {
        var label: String
        var display: String
        var sub: String?
        var neg: Bool
        var id: String { label + display + (sub ?? "") }
    }

    struct Section: Hashable, Identifiable {
        enum Kind: String { case table, kpis, text }
        var kind: Kind
        var title: String?
        var columns: [String] = []
        var rows: [[JSONValue]] = []
        var total: [JSONValue] = []
        var note: String?
        var items: [Figure] = []
        var body: String?
        let id = UUID()
    }

    /// The whole report as plain text, for copying out. Tables become aligned columns
    /// rather than JSON — what lands in a message or an email should be readable there,
    /// not a shape that only means something inside this app.
    var plainText: String {
        var out: [String] = []
        if let answer, !answer.isEmpty { out.append(answer) }
        if let period, !period.isEmpty { out.append("Time filter: \(period)") }
        if !figures.isEmpty {
            out.append(figures.map { figure in
                let sub = figure.sub.map { " (\($0))" } ?? ""
                return "\(figure.label): \(figure.display)\(sub)"
            }.joined(separator: "\n"))
        }
        for section in sections {
            var block: [String] = []
            if let title = section.title, !title.isEmpty { block.append(title) }
            switch section.kind {
            case .text:
                if let body = section.body { block.append(body) }
            case .kpis:
                block.append(section.items.map { "\($0.label): \($0.display)" }.joined(separator: "\n"))
            case .table:
                block.append(Self.textTable(columns: section.columns, rows: section.rows, total: section.total))
            }
            if let note = section.note, !note.isEmpty { block.append(note) }
            out.append(block.joined(separator: "\n"))
        }
        if let caveat, !caveat.isEmpty { out.append("Caveat: \(caveat)") }
        if let scope, !scope.isEmpty { out.append("Scope: \(scope)") }
        if let source, !source.isEmpty { out.append("Source: \(source)") }
        return out.joined(separator: "\n\n")
    }

    /// Pad every column to its widest cell so the table survives being pasted anywhere
    /// that uses a fixed-width font.
    private static func textTable(columns: [String], rows: [[JSONValue]], total: [JSONValue]) -> String {
        var lines: [[String]] = []
        if !columns.isEmpty { lines.append(columns) }
        lines.append(contentsOf: rows.map { $0.map(\.display) })
        if !total.isEmpty { lines.append(total.map(\.display)) }
        guard let width = lines.map(\.count).max() else { return "" }
        let widths = (0..<width).map { column in
            lines.map { $0.indices.contains(column) ? $0[column].count : 0 }.max() ?? 0
        }
        return lines.map { line in
            (0..<width).map { column in
                let cell = line.indices.contains(column) ? line[column] : ""
                return cell.padding(toLength: max(widths[column], cell.count), withPad: " ", startingAt: 0)
            }.joined(separator: "  ").trimmingCharacters(in: .whitespaces)
        }.joined(separator: "\n")
    }

    init?(json: String) {
        guard let data = json.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        self.init(object: root)
    }

    init(object: [String: Any]) {
        status   = Coerce.string(object["status"])
        category = Coerce.string(object["category"])
        answer   = Coerce.string(object["answer"])
        period   = Coerce.string(object["period"])
        scope    = Coerce.string(object["scope"])
        source   = Coerce.string(object["source"])
        caveat   = Coerce.string(object["caveat"])
        figures  = Self.figures(object["figures"])

        // A single headline may arrive as `headline` rather than in `figures`.
        if figures.isEmpty, let headline = object["headline"] as? [String: Any] {
            figures = Self.figures([headline])
        }

        sections = (object["sections"] as? [Any] ?? []).compactMap(Self.section)

        // Older shape: a bare top-level table. Promote it so there is ONE render path.
        if let table = object["table"] as? [String: Any], sections.isEmpty {
            var promoted = Section(kind: .table)
            promoted.columns = (table["columns"] as? [Any] ?? []).map { Coerce.string($0) ?? "" }
            promoted.rows = Self.rows(table["rows"])
            promoted.total = Self.row(table["total"])
            sections = [promoted]
        }
    }

    private static func figures(_ raw: Any?) -> [Figure] {
        (raw as? [Any] ?? []).compactMap { entry in
            guard let item = entry as? [String: Any] else { return nil }
            let label = Coerce.string(item["label"]) ?? ""
            // `display` is the formatted value; fall back to the raw value when absent,
            // because a figure with no text is worse than an unformatted one.
            let display = Coerce.string(item["display"]) ?? Coerce.string(item["value"]) ?? ""
            guard !label.isEmpty || !display.isEmpty else { return nil }
            return Figure(label: label, display: display,
                          sub: Coerce.string(item["sub"]),
                          neg: Coerce.bool(item["neg"]))
        }
    }

    private static func section(_ raw: Any) -> Section? {
        guard let item = raw as? [String: Any] else { return nil }
        let columns = (item["columns"] as? [Any] ?? []).map { Coerce.string($0) ?? "" }
        let rows = Self.rows(item["rows"])
        let items = figures(item["items"])
        let body = Coerce.string(item["body"])

        // Trust the CONTENT over the declared kind: a mislabelled section still renders
        // as whatever it actually contains.
        let declared = Section.Kind(rawValue: Coerce.string(item["kind"]) ?? "")
        let kind: Section.Kind = {
            if !rows.isEmpty || !columns.isEmpty { return .table }
            if !items.isEmpty { return .kpis }
            if declared == .table || declared == .kpis { return .text }
            return declared ?? .text
        }()

        guard !rows.isEmpty || !items.isEmpty || !(body ?? "").isEmpty || !columns.isEmpty
        else { return nil }

        var section = Section(kind: kind)
        section.title = Coerce.string(item["title"])
        section.columns = columns
        section.rows = rows
        section.total = Self.row(item["total"])
        section.note = Coerce.string(item["note"])
        section.items = items
        section.body = body
        return section
    }

    private static func rows(_ raw: Any?) -> [[JSONValue]] {
        (raw as? [Any] ?? []).map { row($0) }.filter { !$0.isEmpty }
    }

    private static func row(_ raw: Any?) -> [JSONValue] {
        (raw as? [Any] ?? []).map(JSONValue.init(any:))
    }
}

/// One cell. Table rows are heterogeneous by design — numbers, strings, nulls — and
/// occasionally something nested, which becomes text rather than an error.
enum JSONValue: Hashable {
    case string(String), number(Double), bool(Bool), null

    init(any: Any) {
        switch any {
        case is NSNull:            self = .null
        case let value as Bool where CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID():
            self = .bool(value)
        case let value as NSNumber:
            self = CFGetTypeID(value) == CFBooleanGetTypeID() ? .bool(value.boolValue) : .number(value.doubleValue)
        case let value as String:  self = .string(value)
        default:                   self = .string(String(describing: any))
        }
    }

    var display: String {
        switch self {
        case .string(let v): return v
        case .bool(let v):   return v ? "yes" : "no"
        case .null:          return "—"
        case .number(let v):
            if v == v.rounded(), abs(v) < 1e15 {
                return Self.integer.string(from: NSNumber(value: Int64(v))) ?? String(Int64(v))
            }
            return Self.decimal.string(from: NSNumber(value: v)) ?? String(v)
        }
    }

    var isNumeric: Bool { if case .number = self { return true }; return false }

    // Grouping is pinned rather than taken from the device locale: the engine formats its
    // own figures in western grouping, and a table rendering "4,12,000" beneath "$412k"
    // makes one answer look like two.
    private static func formatter(_ digits: Int) -> NumberFormatter {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "en_US_POSIX")
        f.groupingSeparator = ","
        f.decimalSeparator = "."
        f.maximumFractionDigits = digits
        return f
    }
    private static let integer = formatter(0)
    private static let decimal = formatter(2)
}

enum Coerce {
    /// Numbers and booleans become text rather than nothing — a label is a label whatever
    /// type it arrived as.
    static func string(_ any: Any?) -> String? {
        switch any {
        case let value as String: return value.isEmpty ? nil : value
        case let value as NSNumber: return JSONValue(any: value).display
        case is NSNull, .none: return nil
        default: return nil
        }
    }

    static func bool(_ any: Any?) -> Bool {
        switch any {
        case let value as Bool: return value
        case let value as NSNumber: return value.boolValue
        case let value as String: return value == "true" || value == "1"
        default: return false
        }
    }
}
