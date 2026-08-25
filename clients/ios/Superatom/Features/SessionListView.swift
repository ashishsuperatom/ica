import SwiftUI

// The opening screen. It renders from disk, so there is never a moment where the app
// admits it is connecting — your previous conversations are simply already here.
struct SessionListView: View {
    @Environment(AppStore.self) private var store
    @Environment(Services.self) private var services
    @State private var openSession: Session?
    @State private var showSwitcher = false
    @State private var showSettings = false

    var body: some View {
        ZStack(alignment: .bottom) {
            Theme.paper.ignoresSafeArea()

            if store.home.sessions.isEmpty { emptyState } else { list }

            newConversationButton
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { titleBlock }
            ToolbarItem(placement: .topBarLeading) {
                Button { showSettings = true } label: {
                    Image(systemName: "gearshape").font(Theme.sans(15))
                }
                .tint(Theme.ink)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Haptics.light()
                    openSession = store.newSession()
                } label: {
                    Image(systemName: "square.and.pencil").font(Theme.sans(16))
                }
                .tint(Theme.ink)
            }
        }
        .navigationDestination(item: $openSession) { session in
            ConversationView(session: session, services: services)
        }
        .sheet(isPresented: $showSwitcher) { ContextSwitcherView() }
        .sheet(isPresented: $showSettings) { SettingsView() }
    }

    /// The title doubles as the context switcher: project name over org name, tappable.
    /// Which project you are asking is never more than a glance away — on a phone that
    /// matters more than on the web, where the subdomain says it for you.
    private var titleBlock: some View {
        Button {
            Haptics.light()
            showSwitcher = true
        } label: {
            VStack(spacing: 1) {
                HStack(spacing: 4) {
                    Text(store.home.project?.name ?? "Superatom")
                        .font(Theme.serif(17, .medium))
                    Image(systemName: "chevron.down").font(Theme.sans(9, .semibold))
                }
                HStack(spacing: 5) {
                    if services.hub.status == .connected {
                        Circle().fill(Theme.accent).frame(width: 5, height: 5)
                    }
                    Text(services.hub.status.label ?? (store.home.org?.name ?? ""))
                        .font(Theme.sans(11)).foregroundStyle(Theme.inkFaint)
                }
            }
            .foregroundStyle(Theme.ink)
        }
        .buttonStyle(.plain)
    }

    private var list: some View {
        ScrollView(showsIndicators: false) {
            LazyVStack(spacing: 0) {
                ForEach(store.home.sessions) { session in
                    VStack(spacing: 0) {
                        Rule()
                        row(session)
                    }
                }
            }
            .padding(.top, 8)
            .padding(.bottom, 110)
        }
    }

    private func row(_ session: Session) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(session.displayTitle)
                .font(Theme.serif(16))
                .foregroundStyle(Theme.ink)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            Text(session.updatedAt.conversationalLabel)
                .font(Theme.sans(12))
                .foregroundStyle(Theme.inkFaint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Theme.gutter)
        .padding(.vertical, 16)
        .contentShape(Rectangle())
        .onTapGesture { openSession = session }
        .contextMenu {
            Button(role: .destructive) { store.delete(session) } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Text("Nothing asked yet.").font(Theme.serif(19)).foregroundStyle(Theme.inkFaint)
            if let project = store.home.project {
                Text("Ask \(project.name) a question.").font(Theme.sans(13)).foregroundStyle(Theme.inkFaint)
            }
        }
        .padding(.bottom, 90)
    }

    private var newConversationButton: some View {
        Button {
            Haptics.medium()
            openSession = store.newSession()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "mic.fill").font(Theme.sans(14, .medium))
                Text("Ask something").font(Theme.serif(16, .medium))
            }
            .foregroundStyle(Theme.paper)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(Theme.ink, in: Capsule())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, Theme.gutter)
        .padding(.bottom, 20)
        .disabled(store.home.project == nil)
        .opacity(store.home.project == nil ? 0.4 : 1)
    }
}

extension Date {
    /// Dates people actually use: today, yesterday, then a date.
    var conversationalLabel: String {
        let cal = Calendar.current
        if cal.isDateInToday(self) { return formatted(date: .omitted, time: .shortened) }
        if cal.isDateInYesterday(self) { return "Yesterday" }
        if cal.isDate(self, equalTo: .now, toGranularity: .year) {
            return formatted(.dateTime.month(.abbreviated).day())
        }
        return formatted(.dateTime.month(.abbreviated).day().year())
    }
}
