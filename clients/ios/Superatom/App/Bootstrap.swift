import Foundation
import GRDB

// First-run content.
//
// There is none: orgs, projects and membership all come from /api/me/projects after you
// sign in, and conversations are yours. An empty database and a sign-in screen is the
// correct cold start — seeding placeholder orgs would put projects in the switcher that
// do not exist.
enum Bootstrap {
    static func seedIfEmpty(_ db: AppDatabase) throws {}
}
