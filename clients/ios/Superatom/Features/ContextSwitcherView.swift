import SwiftUI

// ── Choosing what you're asking ──────────────────────────────────────────────
// Organisation and project are different KINDS of thing, so they must not look alike.
// An org gets a monogram tile — a solid, identity-bearing object. A project is a plain
// row nested beneath its org, with a rule marking the indent. Reading down the sheet,
// the hierarchy is visible before any label is read.

struct ContextSwitcherView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    ForEach(store.home.orgs) { org in
                        orgSection(org)
                    }
                    if store.home.orgs.isEmpty {
                        Text("No organisations yet.")
                            .font(Theme.sans(14))
                            .foregroundStyle(Theme.inkFaint)
                            .padding(.horizontal, Theme.gutter)
                    }
                }
                .padding(.vertical, 14)
            }
            .pageBackground()
            .navigationTitle("Switch project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }.tint(Theme.ink)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder
    private func orgSection(_ org: Organization) -> some View {
        let projects = store.home.projects(in: org)
        VStack(alignment: .leading, spacing: 0) {
            // The organisation — a heading, not a choice. You pick a project; the org
            // comes with it.
            HStack(spacing: 12) {
                Monogram(name: org.name)
                VStack(alignment: .leading, spacing: 1) {
                    Text(org.name)
                        .font(Theme.serif(17, .medium))
                        .foregroundStyle(Theme.ink)
                    Text(projects.count == 1 ? "1 project" : "\(projects.count) projects")
                        .font(Theme.sans(11))
                        .foregroundStyle(Theme.inkFaint)
                }
                Spacer()
            }
            .padding(.horizontal, Theme.gutter)
            .padding(.bottom, 10)

            // Projects hang beneath their org, indented past the monogram so the
            // nesting is structural rather than something you have to infer.
            VStack(alignment: .leading, spacing: 0) {
                ForEach(projects) { project in
                    projectRow(project)
                }
            }
            .padding(.leading, Theme.gutter + 38 + 12)
            .overlay(alignment: .leading) {
                Rectangle()
                    .fill(Theme.rule)
                    .frame(width: 1)
                    .padding(.leading, Theme.gutter + 19)
            }
        }
    }

    private func projectRow(_ project: Project) -> some View {
        let selected = project.id == store.home.project?.id
        return Button {
            Haptics.selection()
            store.switchTo(project: project)
            dismiss()
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(project.name)
                        .font(Theme.serif(16, selected ? .medium : .regular))
                        .foregroundStyle(Theme.ink)
                    if let subdomain = project.subdomain, !subdomain.isEmpty {
                        Text(subdomain)
                            .font(Theme.mono(10))
                            .foregroundStyle(Theme.inkFaint)
                    }
                }
                Spacer()
                if selected {
                    Circle().fill(Theme.accent).frame(width: 7, height: 7)
                }
            }
            .padding(.trailing, Theme.gutter)
            .padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// An organisation's mark: its initials on a colour derived from its name, so the same
/// org is always the same colour on every device without anyone configuring anything.
/// Stands in until real logos exist — the shape and size are already right for one.
struct Monogram: View {
    let name: String
    var size: CGFloat = 38

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
            .fill(colour)
            .frame(width: size, height: size)
            .overlay(
                Text(initials)
                    .font(.system(size: size * 0.36, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
            )
    }

    /// "Fusion5" → "F5", "TotalGroup" → "TG", "Acme Freight Co" → "AF".
    private var initials: String {
        let words = name.split(whereSeparator: { $0 == " " || $0 == "-" || $0 == "_" })
        if words.count >= 2 {
            return words.prefix(2).compactMap { $0.first }.map(String.init).joined().uppercased()
        }
        guard let word = words.first else { return "?" }
        // A single word: take its capitals (TotalGroup → TG), or a leading letter plus a
        // trailing digit (Fusion5 → F5), or just the first two characters.
        let capitals = word.filter(\.isUppercase)
        if capitals.count >= 2 { return String(capitals.prefix(2)) }
        if let digit = word.last, digit.isNumber, let first = word.first {
            return (String(first) + String(digit)).uppercased()
        }
        return String(word.prefix(2)).uppercased()
    }

    /// Deterministic hue from the name — stable across devices and launches, unlike
    /// anything seeded with a random or a hash that varies per process.
    private var colour: Color {
        var hash: UInt64 = 5381
        for byte in name.lowercased().utf8 { hash = (hash &* 33) &+ UInt64(byte) }
        let hue = Double(hash % 360) / 360
        return Color(hue: hue, saturation: 0.42, brightness: 0.58)
    }
}
