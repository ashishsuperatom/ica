import Foundation
import CryptoKit
import AuthenticationServices
import Observation

// ── Sign in ──────────────────────────────────────────────────────────────────
// OAuth 2.0 authorization code for native apps (RFC 8252), with PKCE:
//
//   1. mint a random verifier; send only its SHA-256 challenge
//   2. ASWebAuthenticationSession opens the platform's Clerk page
//   3. it redirects to superatom://auth?code=… — a 60s single-use code, not a token
//   4. exchange code + verifier over HTTPS for the platform token
//
// The token never touches the redirect, so an intercepted callback URL is worthless
// without the verifier, which never left the app.

@MainActor
@Observable
final class AuthController: NSObject {

    enum Phase: Equatable {
        case signedOut, signingIn, loadingProjects, ready, failed(String)
    }

    private(set) var phase: Phase = .signedOut
    /// What this identity can reach, straight from /api/me/projects.
    private(set) var reachable: [OrgProjects] = []

    struct OrgProjects: Decodable, Equatable {
        struct Org: Decodable, Equatable { let id: String; let name: String }
        struct Proj: Decodable, Equatable { let id: String; let name: String; let subdomain: String? }
        let org: Org
        let projects: [Proj]
    }

    private let connection: Connection
    private let db: AppDatabase
    private var session: ASWebAuthenticationSession?

    init(connection: Connection, db: AppDatabase) {
        self.connection = connection
        self.db = db
        super.init()
        phase = connection.isSignedIn ? .ready : .signedOut
    }

    // ── Flow ─────────────────────────────────────────────────────────────────

    func signIn() {
        guard phase != .signingIn else { return }
        phase = .signingIn

        let verifier = Self.randomVerifier()
        let challenge = Self.challenge(for: verifier)

        var components = URLComponents(string: Connection.host + "/mobile/auth")!
        components.queryItems = [
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "redirect_uri", value: Connection.redirectURI),
        ]
        guard let url = components.url else { phase = .failed("Bad login URL"); return }

        let session = ASWebAuthenticationSession(
            url: url, callbackURLScheme: Connection.callbackScheme
        ) { [weak self] callback, error in
            guard let self else { return }
            Task { @MainActor in
                if let error {
                    // Cancelling is a choice, not a failure — don't shout about it.
                    let cancelled = (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin
                    self.phase = cancelled ? .signedOut : .failed(error.localizedDescription)
                    return
                }
                guard let callback,
                      let code = URLComponents(url: callback, resolvingAgainstBaseURL: false)?
                          .queryItems?.first(where: { $0.name == "code" })?.value
                else { self.phase = .failed("No code returned"); return }
                await self.exchange(code: code, verifier: verifier)
            }
        }
        // Use the shared cookie jar so someone already signed into the web app on this
        // phone is recognised instead of being asked to log in twice.
        session.prefersEphemeralWebBrowserSession = false
        session.presentationContextProvider = self
        self.session = session
        session.start()
    }

    private func exchange(code: String, verifier: String) async {
        struct Body: Encodable { let code: String; let code_verifier: String }
        struct Reply: Decodable { let token: String; let userId: String; let role: String? }

        var request = URLRequest(url: URL(string: Connection.host + "/api/auth/mobile/exchange")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(Body(code: code, code_verifier: verifier))

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let reply = try? JSONDecoder().decode(Reply.self, from: data)
            else { phase = .failed("Sign-in was rejected."); return }
            // Signing in NAMES the account, and the account names its database. So the
            // credential is stored against that account and the app is told to open it —
            // this controller does not switch databases itself.
            Accounts.setToken(reply.token, for: reply.userId)
            Accounts.current = reply.userId
            onSignedIn?(reply.userId)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Pull the orgs and projects this identity can reach, and mirror them into the local
    /// database — so the switcher keeps working offline, on the next cold start, and in
    /// the air with no signal.
    func loadProjects() async {
        phase = .loadingProjects
        var request = URLRequest(url: URL(string: Connection.host + "/api/me/projects")!)
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status == 401 {
                // The token expired or was revoked — back to the sign-in screen rather
                // than a wall of failing requests.
                connection.signOut()
                phase = .signedOut
                return
            }
            guard status == 200,
                  let orgs = try? JSONDecoder().decode([OrgProjects].self, from: data)
            else { phase = .failed("Could not load your projects."); return }

            reachable = orgs
            try? db.sync(orgs: orgs, accountId: connection.userId)

            // Keep the current project if it still exists; otherwise fall back to the
            // first one this identity can reach.
            let all = orgs.flatMap(\.projects).map(\.id)
            if connection.projectId.isEmpty || !all.contains(connection.projectId) {
                connection.projectId = all.first ?? ""
            }
            phase = .ready
        } catch {
            // Offline with a stored token is a normal state, not an error: the database
            // already holds the last known orgs and projects.
            phase = connection.isReady ? .ready : .failed(error.localizedDescription)
        }
    }

    /// Set by the app root: a successful sign-in hands over the account id, and the root
    /// opens that account's database.
    var onSignedIn: ((String) -> Void)?

    func signOut() {
        connection.signOut()
        reachable = []
        phase = .signedOut
    }

    // ── PKCE ─────────────────────────────────────────────────────────────────

    private static func randomVerifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64URLEncoded
    }

    private static func challenge(for verifier: String) -> String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncoded
    }
}

extension AuthController: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}

extension Data {
    /// base64url, unpadded — what PKCE requires.
    var base64URLEncoded: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
