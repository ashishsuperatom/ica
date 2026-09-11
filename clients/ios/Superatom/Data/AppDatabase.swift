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

    /// ONE DATABASE PER ACCOUNT.
    ///
    /// Several people can use one phone, and their conversations must not mix. Separate
    /// files rather than an accountId column on every query: nothing to filter, nothing to
    /// forget to filter, and signing out is closing a file rather than trusting a WHERE
    /// clause. The file is KEPT on sign-out, so returning to an account finds its history.
    ///
    /// WAL via DatabasePool so reads never block the writer — the audio outbox writes while
    /// the feed is rendering.
    static func onDisk(accountId: String) throws -> AppDatabase {
        let dir = try directory(for: accountId)
        let file = dir.appendingPathComponent("superatom.sqlite")
        try adoptLegacyDatabase(into: file, for: accountId)
        return try AppDatabase(try DatabasePool(path: file.path))
    }

    /// Before databases were per account there was ONE, at Superatom/superatom.sqlite.
    /// Moving it under the account it belonged to keeps that history instead of stranding
    /// it beside the new file.
    ///
    /// It is claimed only by the account that actually owned it — the old file records who
    /// was signed in — so on a shared phone the first person to sign in cannot inherit
    /// someone else's conversations. WAL and shared-memory siblings move with it, or the
    /// pool reopens with a truncated tail.
    private static func adoptLegacyDatabase(into file: URL, for accountId: String) throws {
        let fm = FileManager.default

        // Adopt when the account's database is ABSENT *or* EMPTY — not merely absent.
        // A launch between the two schemes creates an empty file at the new path, and
        // testing only for existence let that placeholder permanently shadow the real data.
        // Empty means no conversations at all, so nothing can be lost by replacing it.
        if fm.fileExists(atPath: file.path) {
            let existingIsEmpty = (try? DatabaseQueue(path: file.path).read { db in
                try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM session") ?? 0
            }) ?? 1
            guard existingIsEmpty == 0 else { return }
        }

        let legacy = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                appropriateFor: nil, create: true)
            .appendingPathComponent("Superatom/superatom.sqlite")
        guard fm.fileExists(atPath: legacy.path) else { return }

        // Whose was it? If we cannot tell, leave it alone rather than guess.
        let owner = try? DatabaseQueue(path: legacy.path).read { db in
            try String.fetchOne(db, sql: "SELECT value FROM appState WHERE key = 'currentAccountId'")
        }
        guard owner == accountId else { return }

        for suffix in ["", "-wal", "-shm"] {
            let from = URL(fileURLWithPath: legacy.path + suffix)
            let to = URL(fileURLWithPath: file.path + suffix)
            try? fm.removeItem(at: to)                      // the empty placeholder, if any
            if fm.fileExists(atPath: from.path) { try? fm.moveItem(at: from, to: to) }
        }
        // The audio that went with it.
        let legacyAudio = legacy.deletingLastPathComponent().appendingPathComponent("Audio")
        if fm.fileExists(atPath: legacyAudio.path) {
            try? fm.moveItem(at: legacyAudio, to: file.deletingLastPathComponent().appendingPathComponent("Audio"))
        }
    }

    /// The path is COMPUTED from the account id, never searched for. An account id is
    /// stable (it is the platform's own), so the same person always resolves to the same
    /// file — no listing a folder and guessing which database is whose.
    ///
    /// Sanitised only against path separators: everything else is kept so two ids can never
    /// collapse onto one file.
    private static func folderName(for accountId: String) -> String {
        accountId.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ".", with: "_")
    }

    static func directory(for accountId: String) throws -> URL {
        let fm = FileManager.default
        let dir = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask,
                             appropriateFor: nil, create: true)
            .appendingPathComponent("Superatom/accounts/\(folderName(for: accountId))", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// In-memory, for previews and tests.
    static func inMemory() throws -> AppDatabase {
        try AppDatabase(try DatabaseQueue())
    }

    /// Where recorded WAV chunks live. Audio is a file; the row that tracks it is in
    /// SQLite. Keeping blobs out keeps the database small — and small is what makes
    /// the cold open instant, which is the whole point.
    /// Recorded audio, beside the database it belongs to — same reasoning: one account's
    /// recordings are not another's.
    static func audioDirectory(for accountId: String) -> URL {
        let base = (try? directory(for: accountId))
            ?? FileManager.default.temporaryDirectory
        let dir = base.appendingPathComponent("Audio", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    // ── Schema ───────────────────────────────────────────────────────────────
    static var migrator: DatabaseMigrator {
        var m = DatabaseMigrator()
        // NO eraseDatabaseOnSchemaChange, not even in DEBUG.
        //
        // It wipes the whole database whenever the schema changes, which is fine for a
        // scratch app and completely wrong for this one: every build with a new migration
        // would silently destroy real conversations on a real phone. Schema changes are
        // handled by adding a migration below, which is what a migrator is for.

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

        m.registerMigration("v5.beatSource") { db in
            // Where a line came from. The narrator describes the work; the program reports
            // itself running. They read differently and are worth telling apart.
            try db.alter(table: "narrationBeat") { t in
                t.add(column: "source", .text).notNull().defaults(to: "narrator")
            }
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
