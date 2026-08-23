import SwiftUI

// The cold start when nobody is signed in. One button — identity comes from the platform,
// not from anything typed here.
struct LoginView: View {
    @Environment(Services.self) private var services

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            Mark()
                .frame(width: 64, height: 64)
                .padding(.bottom, 22)

            Text("Superatom")
                .font(Theme.serif(26, .medium))
                .foregroundStyle(Theme.ink)
            Text("Ask your data a question.")
                .font(Theme.sans(14))
                .foregroundStyle(Theme.inkFaint)
                .padding(.top, 5)

            Spacer()

            if case .failed(let why) = services.auth.phase {
                Text(why)
                    .font(Theme.sans(12))
                    .foregroundStyle(Theme.warning)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, Theme.gutter)
                    .padding(.bottom, 12)
            }

            Button {
                Haptics.medium()
                services.auth.signIn()
            } label: {
                Group {
                    if services.auth.phase == .signingIn || services.auth.phase == .loadingProjects {
                        ProgressView().tint(Theme.paper)
                    } else {
                        Text("Sign in").font(Theme.serif(16, .medium))
                    }
                }
                .foregroundStyle(Theme.paper)
                .frame(maxWidth: .infinity)
                .frame(height: 52)
                .background(Theme.ink, in: Capsule())
            }
            .buttonStyle(.plain)
            .disabled(services.auth.phase == .signingIn || services.auth.phase == .loadingProjects)
            .padding(.horizontal, Theme.gutter)
            .padding(.bottom, 34)
        }
        .pageBackground()
    }
}

/// The app mark, drawn rather than shipped as an image so it stays crisp at any size and
/// follows the theme. Teal sits on the smallest element — the electron core.
struct Mark: View {
    var body: some View {
        GeometryReader { geo in
            let s = min(geo.size.width, geo.size.height)
            let line = s * 0.055
            ZStack {
                Circle()
                    .strokeBorder(Theme.ink, lineWidth: line)
                    .frame(width: s * 0.79, height: s * 0.79)
                Circle()
                    .fill(Theme.ink)
                    .frame(width: s * 0.29, height: s * 0.29)
                ZStack {
                    Circle().fill(Theme.paper)
                    Circle().strokeBorder(Theme.ink, lineWidth: line)
                    Circle().fill(Theme.accent).frame(width: s * 0.08, height: s * 0.08)
                }
                .frame(width: s * 0.155, height: s * 0.155)
                .offset(x: s * 0.28, y: -s * 0.28)
            }
            .frame(width: s, height: s)
        }
    }
}
