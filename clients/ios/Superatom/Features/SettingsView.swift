import SwiftUI

// ── Settings ─────────────────────────────────────────────────────────────────
// One place for everything that isn't asking a question: what the app shows, which engine
// it is talking to, and who is signed in. No host field, no project id, no token box —
// those all come from signing in.

struct SettingsView: View {
    @Environment(Services.self) private var services
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        @Bindable var preferences = services.preferences

        NavigationStack {
            List {
                Section {
                    Toggle(isOn: $preferences.showFollowUps) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Suggested questions")
                            Text("Shown under an answer as “Next”.")
                                .font(Theme.sans(11))
                                .foregroundStyle(Theme.inkFaint)
                        }
                    }
                    .tint(Theme.accent)
                    Toggle(isOn: $preferences.showTimings) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Show timings")
                            Text("How long each step takes, and how long a question has been running.")
                                .font(Theme.sans(11))
                                .foregroundStyle(Theme.inkFaint)
                        }
                    }
                    .tint(Theme.accent)
                    Toggle(isOn: $preferences.showProgramLogs) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Program logs")
                            Text("What the program is doing while it runs. Off means the engine doesn't send them at all.")
                                .font(Theme.sans(11))
                                .foregroundStyle(Theme.inkFaint)
                        }
                    }
                    .tint(Theme.accent)
                } header: {
                    Text("Answers")
                }

                Section {
                    Toggle(isOn: $preferences.transcribeOnDevice) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Transcribe on this device")
                            Text(services.recorder.speech.available
                                 ? "Instant and works offline. Turn off to transcribe on the server, which covers more languages."
                                 : "Not available on this device — the server is used instead.")
                                .font(Theme.sans(11))
                                .foregroundStyle(Theme.inkFaint)
                        }
                    }
                    .tint(Theme.accent)
                    .disabled(!services.recorder.speech.available)
                } header: {
                    Text("Voice")
                }

                Section {
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
                } header: {
                    Text("Engine")
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
                } header: {
                    Text("Account")
                } footer: {
                    Text("Signing out clears the stored credential on this device. Your conversations stay.")
                }
            }
            .navigationTitle("Settings")
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
