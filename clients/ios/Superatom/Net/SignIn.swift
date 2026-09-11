import Foundation
import CryptoKit
import AuthenticationServices
import Observation

// ── Signing in, before there is a database ───────────────────────────────────
// Each account has its own database, and which one to open is decided by WHO signs in —
// so this cannot depend on a database existing. It does the browser-redirect PKCE flow and
// reports the account id; the app root opens that account's file and builds everything else.
//
// OAuth 2.0 authorization code for native apps (RFC 8252), with PKCE: a random verifier
// stays on the device, only its SHA-256 goes out, and the exchange needs the verifier. An
// intercepted redirect is worthless.

@MainActor
@Observable
final class SignIn: NSObject {

    enum Phase: Equatable { case idle, working, failed(String) }

    private(set) var phase: Phase = .idle
    /// Set once, when sign-in succeeds. The app root watches this.
    private(set) var accountId: String?

    private var session: ASWebAuthenticationSession?

    func start() {
        guard phase != .working else { return }
        phase = .working

        let verifier = Self.randomVerifier()
        var components = URLComponents(string: Connection.host + "/mobile/auth")!
        components.queryItems = [
            URLQueryItem(name: "code_challenge", value: Self.challenge(for: verifier)),
            URLQueryItem(name: "redirect_uri", value: Connection.redirectURI),
        ]
        guard let url = components.url else { phase = .failed("Bad login URL"); return }

        let session = ASWebAuthenticationSession(
            url: url, callbackURLScheme: Connection.callbackScheme
        ) { [weak self] callback, error in
            Task { @MainActor in
                guard let self else { return }
                if let error {
                    // Cancelling is a choice, not a failure — don't shout about it.
                    let cancelled = (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin
                    self.phase = cancelled ? .idle : .failed(error.localizedDescription)
                    return
                }
                guard let callback,
                      let code = URLComponents(url: callback, resolvingAgainstBaseURL: false)?
                          .queryItems?.first(where: { $0.name == "code" })?.value
                else { self.phase = .failed("No code returned"); return }
                await self.exchange(code: code, verifier: verifier)
            }
        }
        // Share the browser's cookies, so someone already signed into the web app on this
        // phone is recognised instead of logging in twice.
        session.prefersEphemeralWebBrowserSession = false
        session.presentationContextProvider = self
        self.session = session
        session.start()
    }

    private func exchange(code: String, verifier: String) async {
        struct Body: Encodable { let code: String; let code_verifier: String }
        struct Reply: Decodable { let token: String; let userId: String }

        var request = URLRequest(url: URL(string: Connection.host + "/api/auth/mobile/exchange")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(Body(code: code, code_verifier: verifier))

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let reply = try? JSONDecoder().decode(Reply.self, from: data)
            else { phase = .failed("Sign-in was rejected."); return }

            // Name the account and store its credential; the root opens its database.
            Accounts.setToken(reply.token, for: reply.userId)
            Accounts.current = reply.userId
            phase = .idle
            accountId = reply.userId
        } catch {
            phase = .failed(error.localizedDescription)
        }
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

extension SignIn: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}
