import Foundation
import GRDB

// ── The local database — the app's ONLY source of truth ──────────────────────
//
// Every surface of the app reads from here and nothing else. The network (the hub
// WebSocket, the transcription POST) is a WRITER into this file, never something a
// view waits on. That single rule is what makes the app open instantly into your
// last conversation, survive being killed mid-question, and work offline — instead
// of needing a separate mechanism for each.
//
// The file mirrors the platform hierarchy, because the same device can hold more
// than one of each and switching must never lose the others:
//
//   account → organization → project → session → question → audioChunk
//
// Answers are stored as OPAQUE JSON (see feedItem.payload). The engine's Answer
// shape is a render contract that keeps growing new section kinds; storing it
// verbatim means the engine can evolve without a schema migration here.
final class AppDatabase: Sendable {
    let writer: any DatabaseWriter

    init(_ writer: any DatabaseWriter) throws {
        self.writer = writer
        try Self.migrator.migrate(writer)
    }

    /// The on-disk database, in Application Support. WAL via DatabasePool so reads
    /// never block the writer (the audio outbox writes while the feed is rendering).
    static func onDisk() throws -> AppDatabase {
        let fm = FileManager.default
        let dir = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask,
                             appropriateFor: nil, create: true)
            .appendingPathComponent("Superatom", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return try AppDatabase(try DatabasePool(path: dir.appendingPathComponent("superatom.sqlite").path))
    }

    /// In-memory, for previews and tests.
    static func inMemory() throws -> AppDatabase {
        try AppDatabase(try DatabaseQueue())
    }

    /// Where recorded WAV chunks live. Audio is a file; the row that tracks it is in
    /// SQLite. Keeping blobs out keeps the database small — and small is what makes
    /// the cold open instant, which is the whole point.
    static var audioDirectory: URL {
        // swiftlint:disable:next force_try
        let dir = try! FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                               appropriateFor: nil, create: true)
            .appendingPathComponent("Superatom/Audio", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    // ── Schema ───────────────────────────────────────────────────────────────
    static var migrator: DatabaseMigrator {
        var m = DatabaseMigrator()
        #if DEBUG
        m.eraseDatabaseOnSchemaChange = true
        #endif

        m.registerMigration("v1.identity") { db in
            // The signed-in person on this device. The platform JWT is NOT stored here —
            // it belongs in the Keychain (step 2), never in a file that gets backed up.
            try db.create(table: "account") { t in
                t.primaryKey("id", .text)                 // our platform principal id
                t.column("email", .text)
                t.column("displayName", .text)
                t.column("createdAt", .datetime).notNull()
                t.column("lastSignedInAt", .datetime)
            }
            try db.create(table: "organization") { t in
                t.primaryKey("id", .text)
                t.column("name", .text).notNull()
                t.column("createdAt", .datetime).notNull()
            }
            // An account can belong to several orgs; an org can be shared by several
            // accounts signed in on this device. Neither owns the other.
            try db.create(table: "membership") { t in
                t.column("accountId", .text).notNull().references("account", onDelete: .cascade)
                t.column("orgId", .text).notNull().references("organization", onDelete: .cascade)
                t.column("role", .text).notNull().defaults(to: "member")
                t.primaryKey(["accountId", "orgId"])
            }
            try db.create(table: "project") { t in
                t.primaryKey("id", .text)
                t.column("orgId", .text).notNull().references("organization", onDelete: .cascade)
                t.column("name", .text).notNull()
                t.column("subdomain", .text)              // <sub>.superatom.site
                t.column("createdAt", .datetime).notNull()
                t.column("lastOpenedAt", .datetime)
            }
            try db.create(indexOn: "project", columns: ["orgId"])
            try db.create(table: "projectAccess") { t in
                t.column("accountId", .text).notNull().references("account", onDelete: .cascade)
                t.column("projectId", .text).notNull().references("project", onDelete: .cascade)
                t.column("role", .text).notNull().defaults(to: "analyst")
                t.primaryKey(["accountId", "projectId"])
            }
            // Which account / org / project the UI is currently pointed at. A plain
            // key-value row so switching context is ONE write that every observation
            // downstream reacts to.
            try db.create(table: "appState") { t in
                t.primaryKey("key", .text)
                t.column("value", .text).notNull()
            }
        }

        m.registerMigration("v2.conversation") { db in
            try db.create(table: "session") { t in
                t.primaryKey("id", .text)
                t.column("projectId", .text).notNull().references("project", onDelete: .cascade)
                t.column("accountId", .text).notNull().references("account", onDelete: .cascade)
                t.column("title", .text)
                t.column("createdAt", .datetime).notNull()
                t.column("updatedAt", .datetime).notNull()
            }
            try db.create(indexOn: "session", columns: ["projectId", "updatedAt"])

            // `id` IS the qid the platform already mints client-side and threads through
            // the engine to out/<qid>.json. Using it as the primary key means reconnect
            // replays de-duplicate by construction rather than by checking a flag.
            try db.create(table: "question") { t in
                t.primaryKey("id", .text)
                t.column("sessionId", .text).notNull().references("session", onDelete: .cascade)
                t.column("seq", .integer).notNull()
                t.column("text", .text).notNull().defaults(to: "")
                t.column("source", .text).notNull().defaults(to: "text")   // text | voice
                t.column("state", .text).notNull().defaults(to: "draft")   // draft|transcribing|asking|answered|failed
                t.column("createdAt", .datetime).notNull()
                t.column("askedAt", .datetime)
                t.column("answeredAt", .datetime)
            }
            try db.create(indexOn: "question", columns: ["sessionId", "seq"])

            // Renderable blocks, in order. `payload` is the engine's JSON, stored verbatim.
            try db.create(table: "feedItem") { t in
                t.primaryKey("id", .text)
                t.column("sessionId", .text).notNull().references("session", onDelete: .cascade)
                t.column("questionId", .text).references("question", onDelete: .cascade)
                t.column("seq", .integer).notNull()
                t.column("kind", .text).notNull()        // answer | error | followups | note
                t.column("payload", .text).notNull()
                t.column("createdAt", .datetime).notNull()
            }
            try db.create(indexOn: "feedItem", columns: ["sessionId", "seq"])

            // The analyst's live commentary, persisted beat by beat as it arrives — so a
            // relaunch mid-question restores the run in progress instead of losing it.
            try db.create(table: "narrationBeat") { t in
                t.column("questionId", .text).notNull().references("question", onDelete: .cascade)
                t.column("seq", .integer).notNull()
                t.column("text", .text).notNull()
                t.column("atMs", .integer).notNull()      // arrival, for the per-beat timer
                t.primaryKey(["questionId", "seq"])
            }
        }

        m.registerMigration("v3.audioOutbox") { db in
            // Recorded audio is durable the moment it exists. Upload and this row race
            // freely — both paths UPSERT on (questionId, chunkIndex), so they converge
            // whichever lands first, and a failed transcription is simply retried.
            try db.create(table: "audioChunk") { t in
                t.primaryKey("id", .text)
                t.column("questionId", .text).notNull().references("question", onDelete: .cascade)
                t.column("chunkIndex", .integer).notNull()
                t.column("path", .text)                   // WAV on disk
                t.column("durationMs", .integer).notNull().defaults(to: 0)
                t.column("isFinal", .boolean).notNull().defaults(to: false)
                t.column("state", .text).notNull().defaults(to: "pending")  // pending|uploading|transcribed|failed
                t.column("attempts", .integer).notNull().defaults(to: 0)
                t.column("lastError", .text)
                t.column("transcript", .text)
                t.column("createdAt", .datetime).notNull()
                t.column("updatedAt", .datetime).notNull()
            }
            try db.create(indexOn: "audioChunk", columns: ["questionId", "chunkIndex"], options: .unique)
            try db.create(indexOn: "audioChunk", columns: ["state"])
        }

        m.registerMigration("v4.search") { db in
            // Local full-text search over what you asked and what came back. Finding a
            // months-old answer is a local query, not a round trip.
            try db.create(virtualTable: "searchIndex", using: FTS5()) { t in
                t.tokenizer = .porter(wrapping: .unicode61())
                t.column("body")
                t.column("kind").notIndexed()
                t.column("refId").notIndexed()
                t.column("sessionId").notIndexed()
            }
        }

        return m
    }
}
