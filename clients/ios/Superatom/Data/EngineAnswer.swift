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
        /// How many rows MATCHED, when the engine sent only a sample. Without it a
        /// truncated table silently reads as the whole answer.
        var totalRows: Int?
        /// Position within the answer. STABLE across re-parses — see above.
        var index: Int = 0
        var id: String { "\(index)-\(kind.rawValue)-\(title ?? "")" }
    }

    /// The whole report as plain text, matching what the web card copies (answerToText in
    /// user-ui/src/App.tsx) so an answer pasted from a phone and one pasted from a browser
    /// are the same document.
    ///
    /// Tables are TAB-separated, as on the web: tabs paste into a spreadsheet as real
    /// columns, which is where a copied table usually ends up. Section titles are
    /// uppercased to stand in for the headings plain text cannot carry.
    func plainText(questionId: String? = nil, answeredAt: Date? = nil) -> String {
        var out: [String] = []
        if let answer, !answer.isEmpty { out.append(answer) }
        if let period, !period.isEmpty { out.append("Time filter: \(period)") }
        if !figures.isEmpty { out.append(figures.map(Self.line).joined(separator: "\n")) }

        for section in sections {
            if let title = section.title, !title.isEmpty { out.append(title.uppercased()) }
            switch section.kind {
            case .text:
                if let body = section.body, !body.isEmpty { out.append(body) }
            case .kpis:
                out.append(section.items.map(Self.line).joined(separator: "\n"))
            case .table:
                var rows = [section.columns.joined(separator: "\t")]
                rows.append(contentsOf: section.rows.map { $0.map(\.copyText).joined(separator: "\t") })
                if !section.total.isEmpty { rows.append(section.total.map(\.copyText).joined(separator: "\t")) }
                out.append(rows.joined(separator: "\n"))
            }
            if let note = section.note, !note.isEmpty { out.append(note) }
        }

        if let caveat, !caveat.isEmpty { out.append("Note: \(caveat)") }
        if let scope, !scope.isEmpty { out.append("Scope: \(scope)") }
        if let source, !source.isEmpty { out.append("Source: \(source)") }

        // Provenance footer, kept apart from the answer — where it came from is part of
        // being able to trust it later.
        var meta: [String] = []
        if let questionId { meta.append("Question ID: \(questionId)") }
        if let answeredAt { meta.append("Answered: \(answeredAt.formatted(date: .abbreviated, time: .shortened))") }
        if !meta.isEmpty { out.append("—\n" + meta.joined(separator: "\n")) }

        return out.joined(separator: "\n\n")
    }

    private static func line(_ figure: Figure) -> String {
        let sub = (figure.sub?.isEmpty == false) ? " (\(figure.sub!))" : ""
        return "\(figure.label): \(figure.display)\(sub)"
    }

    init?(json: String) {
        guard let data = json.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        self.init(object: root)
    }

    init(object raw: [String: Any]) {
        // UNWRAP a doubly-wrapped answer.
        //
        // The hub's answer buffer stores the whole `analyst:answer` envelope, so a
        // recovered answer arrives as { t, qid, sid, timing, lastLines, answer: {...} }
        // rather than the answer itself. Reading that as the answer produced a report with
        // no prose and a wall of raw agent terminal — `lastLines` is 22k characters of the
        // analyst's stdout, which must never reach a reader.
        //
        // A nested dictionary under `answer` always means the real answer is inside it.
        var object = raw
        if let inner = raw["answer"] as? [String: Any] {
            object = inner
            // Carry across the fields the envelope holds and the answer does not.
            if object["category"] == nil, let category = raw["category"] { object["category"] = category }
        }

        status   = Coerce.string(object["status"])
        category = Coerce.string(object["category"])
        // Prose may arrive as a string OR an array of paragraphs — the web joins the
        // array, and so do we, rather than dropping it for being the wrong type.
        answer   = Self.prose(object["answer"])
        period   = Coerce.string(object["period"])
        scope    = Coerce.string(object["scope"])
        source   = Coerce.string(object["source"])
        caveat   = Coerce.string(object["caveat"])
        figures  = Self.figures(object["figures"])

        // A single headline may arrive as `headline` rather than in `figures`.
        if figures.isEmpty, let headline = object["headline"] as? [String: Any] {
            figures = Self.figures([headline])
        }

        sections = (object["sections"] as? [Any] ?? []).enumerated().compactMap { index, raw in
            var section = Self.section(raw)
            section?.index = index
            return section
        }

        // Older shape: a bare top-level table. Promote it so there is ONE render path.
        if let table = object["table"] as? [String: Any], sections.isEmpty {
            var promoted = Section(kind: .table)
            promoted.columns = (table["columns"] as? [Any] ?? []).map { Coerce.string($0) ?? "" }
            promoted.rows = Self.rows(table["rows"])
            promoted.total = Self.row(table["total"])
            promoted.totalRows = (table["totalRows"] as? NSNumber)?.intValue
            sections = [promoted]
        }
    }

    /// Prose, however it arrived.
    ///
    /// A string is a paragraph. An array is the engine having several separate things to
    /// say — so ONE entry stays a paragraph, and several become a list, which is what they
    /// actually are. Emitted as markdown bullets so the existing renderer draws them; no
    /// new rendering path.
    private static func prose(_ raw: Any?) -> String? {
        if let text = Coerce.string(raw) { return text }
        guard let parts = (raw as? [Any])?.compactMap(Coerce.string), !parts.isEmpty else { return nil }
        if parts.count == 1 { return parts[0] }
        return parts.map { "- " + $0 }.joined(separator: "\n")
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
        section.totalRows = (item["totalRows"] as? NSNumber)?.intValue
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
        // NSNumber covers BOTH numbers and booleans, and only its CFTypeID can tell them
        // apart. There used to be a `case let value as Bool` above this, which turned the
        // number 1 into "yes" and 0 into "no" — so the first row of every rank column read
        // "yes". Two mistakes compounded: Swift bridges an NSNumber to Bool for exactly 0
        // and 1, and the guard meant to catch that (`value as CFTypeRef`) re-bridged the
        // already-converted Swift Bool back to a CFBoolean, so it was always true.
        case let value as NSNumber:
            self = CFGetTypeID(value) == CFBooleanGetTypeID() ? .bool(value.boolValue) : .number(value.doubleValue)
        case let value as String:  self = .string(value)
        // A cell may carry more than its value — {"value": …, "id": …} to name something the reader can open,
        // or {"value": …, "display": …} where the form cannot be derived. Here the readable form is wanted, and
        // the raw value otherwise. Without this it falls to String(describing:) and the reader sees a printed
        // dictionary where a name should be.
        case let cell as [String: Any] where cell["value"] != nil:
            if let shown = cell["display"] as? String { self = .string(shown) }
            else { self = JSONValue(any: cell["value"]!) }
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

    /// For copying: a blank rather than an em dash, so a pasted table has empty cells
    /// where there was no value instead of a character a spreadsheet reads as text.
    var copyText: String { if case .null = self { return "" }; return display }

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
        // A column may be declared rather than named — {"label": …, "entity": …, "format": …} — so that a
        // richer client can present it. Its label is the name. Without this the header renders empty.
        case let spec as [String: Any]: return spec["label"].flatMap { string($0) }
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
