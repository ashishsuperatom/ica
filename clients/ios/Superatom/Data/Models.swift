import Foundation
import GRDB

// Record types — one per table. Plain structs; GRDB maps them by property name.

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
    var id: String = UUID().uuidString
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

    var id: String = UUID().uuidString      // the qid — the platform's idempotency key
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

    /// Suggested next questions, when this block carries them.
    var followups: [String] {
        guard kind == .followups, let data = payload.data(using: .utf8),
              let items = try? JSONSerialization.jsonObject(with: data) as? [String] else { return [] }
        return items
    }

    /// The payload as an engine Answer. Tolerant by construction — see EngineAnswer —
    /// so an unexpected field costs one value, never the whole report.
    var answer: EngineAnswer? {
        guard kind == .answer else { return nil }
        guard let parsed = EngineAnswer(json: payload), !parsed.isEmpty else { return nil }
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
