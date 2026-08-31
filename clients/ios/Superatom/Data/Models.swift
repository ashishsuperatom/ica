import Foundation
import GRDB

// Record types — one per table. Plain structs; GRDB maps them by property name.

/// Identifiers minted on this device.
///
/// Session and question ids carry an `IOS` prefix because they do not stay here: the qid
/// travels to the engine, becomes `out/<qid>/answer.json` on its disk and a row in its
/// database, and is echoed back on the answer. The prefix makes the originating surface
/// visible wherever the id turns up — a log line, a filename, a support question — with no
/// lookup and no extra field to thread through.
///
/// Hyphen-separated, matching the UUID's own grouping — the id reads as one thing rather
/// than a prefix jammed onto a value. Still a single token: no spaces, filename-safe, and
/// safe unquoted in a URL or a log line. Named `SurfaceID`
/// rather than `ID` because `Identifiable` already gives every record an `ID` typealias,
/// which would shadow it inside them.
enum SurfaceID {
    /// Uppercase to match the rest of the id — UUID strings are uppercase hex, and a
    /// lowercase prefix made the id read as two different things stuck together.
    static let surface = "IOS"
    static func mint() -> String { surface + "-" + UUID().uuidString }
}

struct Account: Codable, Identifiable, Hashable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "account"
    var id: String
    var email: String?
    var displayName: String?
    var createdAt: Date = .now
    var lastSignedInAt: Date?
}

struct Organization: Codable, Identifiable, Hashable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "organization"
    var id: String
    var name: String
    var createdAt: Date = .now
}

struct Membership: Codable, Hashable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "membership"
    var accountId: String
    var orgId: String
    var role: String = "member"
}

struct Project: Codable, Identifiable, Hashable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "project"
    var id: String
    var orgId: String
    var name: String
    var subdomain: String?
    var createdAt: Date = .now
    var lastOpenedAt: Date?
}

struct ProjectAccess: Codable, Hashable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "projectAccess"
    var accountId: String
    var projectId: String
    var role: String = "analyst"
}

struct Session: Codable, Identifiable, Hashable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "session"
    var id: String = SurfaceID.mint()
    var projectId: String
    var accountId: String
    var title: String?
    var createdAt: Date = .now
    var updatedAt: Date = .now

    var displayTitle: String { (title?.isEmpty == false ? title! : nil) ?? "New conversation" }
}

struct Question: Codable, Identifiable, Hashable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "question"

    enum State: String, Codable { case draft, transcribing, asking, answered, failed }
    enum Source: String, Codable { case text, voice }

    var id: String = SurfaceID.mint()              // the qid — the platform's idempotency key
    var sessionId: String
    var seq: Int
    var text: String = ""
    var source: Source = .text
    var state: State = .draft
    var createdAt: Date = .now
    var askedAt: Date?
    var answeredAt: Date?
}

struct FeedItem: Codable, Identifiable, Hashable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "feedItem"

    enum Kind: String, Codable { case answer, error, followups, note }

    var id: String = UUID().uuidString
    var sessionId: String
    var questionId: String?
    var seq: Int
    var kind: Kind
    var payload: String                     // the engine's JSON, stored verbatim
    var createdAt: Date = .now

    /// Suggested next questions, when this block carries them. Cached for the same
    /// reason as `answer`: this is read on every render pass and the payload never changes.
    var followups: [String] {
        guard kind == .followups else { return [] }
        if let cached = FollowUpCache.shared.value(for: id) { return cached }
        guard let data = payload.data(using: .utf8),
              let items = try? JSONSerialization.jsonObject(with: data) as? [String] else { return [] }
        FollowUpCache.shared.store(items, for: id)
        return items
    }

    /// The payload as an engine Answer. Tolerant by construction — see EngineAnswer —
    /// so an unexpected field costs one value, never the whole report.
    var answer: EngineAnswer? {
        guard kind == .answer else { return nil }
        // Cached: this is read on every render pass, and re-parsing a large report each
        // time is both wasteful and a source of churn in the view tree.
        if let cached = AnswerCache.shared.value(for: id) { return cached }
        guard let parsed = EngineAnswer(json: payload), !parsed.isEmpty else { return nil }
        AnswerCache.shared.store(parsed, for: id)
        return parsed
    }
}

struct NarrationBeat: Codable, Hashable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "narrationBeat"
    var questionId: String
    var seq: Int
    var text: String
    var atMs: Int64
}

struct AudioChunk: Codable, Identifiable, Hashable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "audioChunk"

    enum State: String, Codable { case pending, uploading, transcribed, failed }

    var id: String = UUID().uuidString
    var questionId: String
    var chunkIndex: Int
    var path: String?
    var durationMs: Int = 0
    var isFinal: Bool = false
    var state: State = .pending
    var attempts: Int = 0
    var lastError: String?
    var transcript: String?
    var createdAt: Date = .now
    var updatedAt: Date = .now
}

/// Key-value context pointer: which account / org / project the UI is showing.
struct AppState: Codable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "appState"
    var key: String
    var value: String

    enum Key: String {
        case currentAccountId, currentOrgId, currentProjectId
    }
}


/// Parsed follow-up lists, keyed by feed-item id.
final class FollowUpCache: @unchecked Sendable {
    static let shared = FollowUpCache()
    private let cache = NSCache<NSString, NSArray>()

    func value(for id: String) -> [String]? { cache.object(forKey: id as NSString) as? [String] }
    func store(_ value: [String], for id: String) { cache.setObject(value as NSArray, forKey: id as NSString) }
}

/// Parsed answers, keyed by feed-item id. An answer never changes once stored, so this
/// needs no invalidation — and NSCache sheds entries by itself under memory pressure.
final class AnswerCache: @unchecked Sendable {
    static let shared = AnswerCache()
    private let cache = NSCache<NSString, Box>()

    private final class Box { let value: EngineAnswer; init(_ v: EngineAnswer) { value = v } }

    func value(for id: String) -> EngineAnswer? { cache.object(forKey: id as NSString)?.value }
    func store(_ value: EngineAnswer, for id: String) { cache.setObject(Box(value), forKey: id as NSString) }
}

/// The plain-text form of an answer, built once per feed item.
///
/// Assembling a whole report — prose, figures, every table row, the provenance footer —
/// is not something to do during layout. It is built on demand and cached, so a Share
/// sheet and a Copy tap reuse the same string.
enum AnswerText {
    private static let cache = NSCache<NSString, NSString>()

    static func of(_ item: FeedItem) -> String {
        if let hit = cache.object(forKey: item.id as NSString) { return hit as String }
        let text = item.answer?.plainText(questionId: item.questionId) ?? item.payload
        cache.setObject(text as NSString, forKey: item.id as NSString)
        return text
    }
}
