import SwiftUI

// Who you are and what you can reach. No host field, no project id field, no token box —
// all three come from signing in.
struct AccountView: View {
    @Environment(Services.self) private var services
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Engine") {
                    LabeledContent("Status") {
                        HStack(spacing: 6) {
                            if services.hub.status == .connected {
                                Circle().fill(Theme.accent).frame(width: 6, height: 6)
                            }
                            Text(statusText).foregroundStyle(statusColor)
                        }
                    }
                    LabeledContent("Project", value: store.home.project?.name ?? "—")
                    LabeledContent("Organisation", value: store.home.org?.name ?? "—")
                }

                Section {
                    Button {
                        Task { await services.auth.loadProjects() }
                    } label: {
                        Label("Refresh projects", systemImage: "arrow.clockwise")
                    }
                    Button(role: .destructive) {
                        services.signOut()
                        dismiss()
                    } label: {
                        Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                } footer: {
                    Text("Signing out clears the stored credential on this device. Your conversations stay.")
                }
            }
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
        }
    }

    private var statusText: String {
        switch services.hub.status {
        case .connected:       return "Connected"
        case .connecting:      return "Connecting…"
        case .waking:          return "Starting the engine…"
        case .idle:            return "Not connected"
        case .failed(let why): return why
        }
    }

    private var statusColor: Color {
        switch services.hub.status {
        case .connected: return Theme.accent
        case .failed:    return Theme.warning
        default:         return Theme.inkFaint
        }
    }
}
