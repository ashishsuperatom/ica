import SwiftUI

// ── One conversation, read as a page ─────────────────────────────────────────
// Question in serif at reading size, the answer beneath it, a hairline between turns.
// No bubbles, no avatars — the answer is the thing being read.
//
// Voice is the DEFAULT input. The big button is the microphone; typing is a deliberate
// toggle away. That ordering is the product, not a preference.

struct ConversationView: View {
    let session: Session

    @Environment(Services.self) private var services
    @State private var conversation: ConversationStore?
    @State private var typing = false
    @State private var editingPending = false
    @State private var pendingText = ""
    @State private var draft = ""
    @State private var now = Date.now
    @FocusState private var composerFocused: Bool

    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 0) {
            if let conversation {
                if conversation.state.isEmpty && !services.recorder.state.isRecording {
                    emptyState
                } else {
                    feed(conversation)
                }
            } else {
                Spacer()
            }
            composer
        }
        .pageBackground()
        .navigationTitle(session.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if conversation == nil {
                conversation = ConversationStore(db: services.db, session: session, services: services)
            }
        }
        .onDisappear { if services.recorder.state.isRecording { conversation?.stopVoice() } }
        // One heartbeat drives BOTH the recording clock and the narration timers. Without
        // it the elapsed seconds only moved when a new beat arrived, which made a long
        // step look frozen exactly when you most want to see it counting.
        .onReceive(timer) { _ in
            if services.recorder.state.isRecording || isWorking { now = .now }
        }
    }

    // ── Feed ─────────────────────────────────────────────────────────────────

    private func feed(_ conversation: ConversationStore) -> some View {
        ScrollViewReader { proxy in
            ScrollView(showsIndicators: false) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(conversation.state.questions.enumerated()), id: \.element.id) { index, question in
                        turn(question, conversation: conversation, isFirst: index == 0)
                            .id(question.id)
                    }
                    Color.clear.frame(height: 28).id(bottomAnchor)
                }
                .padding(.top, 24)
                .contentShape(Rectangle())
                .onTapGesture { dismissKeyboard() }
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: conversation.state.questions.count) { _, _ in scrollToBottom(proxy) }
            .onChange(of: conversation.state.beatsByQuestion.count) { _, _ in scrollToBottom(proxy) }
            .onAppear { scrollToBottom(proxy, animated: false) }
        }
    }

    private let bottomAnchor = "bottom"

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool = true) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            withAnimation(animated ? .easeOut(duration: 0.25) : nil) {
                proxy.scrollTo(bottomAnchor, anchor: .bottom)
            }
        }
    }

    @ViewBuilder
    private func turn(_ question: Question, conversation: ConversationStore, isFirst: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if !isFirst { TurnBreak().padding(.vertical, 26) }

            VStack(alignment: .leading, spacing: 15) {
                VStack(alignment: .leading, spacing: 6) {
                    speaker("you", spoken: question.source == .voice)
                    Text(question.text.isEmpty ? "…" : question.text)
                        .font(Theme.serif(18))
                        .foregroundStyle(question.text.isEmpty ? Theme.inkFaint : Theme.ink)
                        .lineSpacing(6)
                        .fixedSize(horizontal: false, vertical: true)
                }

                // The analyst's live commentary, and its record once finished. Persisted
                // beat by beat, so this survives the app being killed mid-question.
                if let beats = conversation.state.beatsByQuestion[question.id], !beats.isEmpty {
                    NarrationView(beats: beats, live: question.state == .asking, now: now)
                }

                ForEach(conversation.state.itemsByQuestion[question.id] ?? []) { item in
                    block(item)
                }

                if question.state == .asking,
                          (conversation.state.beatsByQuestion[question.id] ?? []).isEmpty {
                    workingLine(services.hub.status.label ?? "Thinking…")
                }
            }
            .padding(.horizontal, Theme.gutter)
        }
    }

    @ViewBuilder
    private func block(_ item: FeedItem) -> some View {
        switch item.kind {
        case .answer:
            VStack(alignment: .leading, spacing: 8) {
                speaker("superatom", accent: true)
                if let answer = item.answer {
                    AnswerView(answer: answer)
                } else {
                    // The payload didn't decode into the shape we expect. Show it raw
                    // rather than rendering nothing — a visible oddity beats a silent
                    // hole where an answer should be.
                    MarkdownText(raw: item.payload, font: Theme.mono(12), color: Theme.inkSoft, lineSpacing: 3)
                }
            }
        case .error:
            VStack(alignment: .leading, spacing: 6) {
                speaker("problem")
                Text(item.payload).font(Theme.sans(13)).foregroundStyle(Theme.warning)
            }
        case .followups:
            FollowUps(items: item.followups) { question in
                conversation?.proposeFollowUp(question)
            }
        case .note:
            EmptyView()
        }
    }

    /// Who is speaking. "you" stays quiet; the engine's name carries the accent, so a
    /// glance down the page separates your questions from its answers without reading.
    /// The answer to a question as copyable text, if it has one.
    private func answerText(for question: Question, in conversation: ConversationStore?) -> String? {
        conversation?.state.itemsByQuestion[question.id]?
            .first(where: { $0.kind == .answer })?.answer?.plainText
    }

    private func speaker(_ name: String, spoken: Bool = false, accent: Bool = false) -> some View {
        HStack(spacing: 6) {
            Text(name.uppercased())
                .font(Theme.sans(9.5, .heavy))
                .tracking(1.2)
                .foregroundStyle(accent ? Theme.accent : Theme.inkFaint)
            if spoken {
                Image(systemName: "waveform").font(Theme.sans(9)).foregroundStyle(Theme.inkFaint)
            }
        }
    }

    private func workingLine(_ text: String) -> some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(text).font(Theme.sans(13)).foregroundStyle(Theme.inkFaint)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Spacer()
            Text("Ask a question.").font(Theme.serif(19)).foregroundStyle(Theme.inkFaint)
            Text("Tap the button and just talk.")
                .font(Theme.sans(13)).foregroundStyle(Theme.inkFaint.opacity(0.85))
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture { dismissKeyboard() }
    }

    /// Give the page back. Dismissing with nothing typed also returns the composer to
    /// its voice state — the keyboard was a detour, and leaving a dead text field behind
    /// would keep the primary control hidden.
    private func dismissKeyboard() {
        guard composerFocused || typing else { return }
        composerFocused = false
        if trimmedDraft.isEmpty { typing = false }
    }

    // ── Composer — voice first ───────────────────────────────────────────────

    @ViewBuilder
    private var composer: some View {
        VStack(spacing: 10) {
            if let failure = conversation?.voiceError ?? services.recorder.state.failure {
                Text(failure).font(Theme.sans(12)).foregroundStyle(Theme.warning)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Theme.gutter)
            }
            if let pending = conversation?.state.pending {
                reviewComposer(pending)
            } else if typing {
                keyboardComposer
            } else {
                voiceComposer
            }
        }
        .padding(.top, 10)
        .padding(.bottom, 14)
        .animation(.easeInOut(duration: 0.22), value: typing)
        .animation(.easeInOut(duration: 0.22), value: services.recorder.state.isRecording)
        .animation(.easeInOut(duration: 0.22), value: conversation?.state.pending?.id)
    }

    /// A spoken question, transcribed and awaiting your say-so. Transcription is not
    /// reliable enough to send blind — a misheard word changes the question and the
    /// engine answers the wrong one perfectly. Tap the text to correct it; the same bar
    /// becomes Cancel / Send.
    private func reviewComposer(_ pending: Question) -> some View {
        let transcribing = pending.state == .transcribing
        return VStack(spacing: 10) {
            Group {
                if transcribing {
                    // The text area itself reports progress, so the transcript lands
                    // exactly where this line was — nothing moves, nothing jumps.
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text("Transcribing…")
                            .font(Theme.serif(17))
                            .foregroundStyle(Theme.inkFaint)
                        Spacer(minLength: 0)
                    }
                } else if editingPending {
                    TextField("", text: $pendingText, axis: .vertical)
                        .font(Theme.serif(17))
                        .foregroundStyle(Theme.ink)
                        .lineSpacing(5)
                        .lineLimit(1...6)
                        .focused($composerFocused)
                        .onChange(of: pendingText) { _, new in conversation?.editPending(new) }
                } else {
                    TypedText(text: pending.text)
                        .font(Theme.serif(17))
                        .foregroundStyle(Theme.ink)
                        .lineSpacing(5)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            Haptics.light()
                            pendingText = pending.text
                            editingPending = true
                            composerFocused = true
                        }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 13)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 20).fill(Theme.paperInset)
                    .overlay(RoundedRectangle(cornerRadius: 20).stroke(Theme.rule, lineWidth: 0.5))
            )

            HStack(spacing: 10) {
                Button {
                    Haptics.light()
                    editingPending = false
                    composerFocused = false
                    conversation?.cancelPending()
                } label: {
                    Text("Cancel")
                        .font(Theme.sans(15, .medium))
                        .foregroundStyle(Theme.inkSoft)
                        .frame(width: 96, height: 52)
                        .background(Capsule().stroke(Theme.rule, lineWidth: 0.5))
                }
                .buttonStyle(.plain)

                Button {
                    Haptics.medium()
                    editingPending = false
                    composerFocused = false
                    conversation?.submitPending()
                } label: {
                    HStack(spacing: 8) {
                        Text("Send").font(Theme.serif(16, .medium))
                        Image(systemName: "arrow.up").font(Theme.sans(13, .semibold))
                    }
                    .foregroundStyle(Theme.paper)
                    .frame(maxWidth: .infinity)
                    .frame(height: 52)
                    .background(transcribing ? Theme.inkFaint : Theme.ink, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(transcribing)
            }
        }
        .padding(.horizontal, Theme.gutter)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    /// ONE control that morphs, rather than a bar plus a separate button.
    ///
    ///   idle        [ ⌨ | ●  Ask                    ]   left segment types, the rest listens
    ///   recording   [ 0:04    0:11              ■ ● ]   speech time · wall time · stop
    ///   typing      [ 🎤  Ask…                    ↑ ]   the same bar, expanded
    ///
    /// The microphone owns ~80% of the target because it is the primary way to ask; the
    /// keyboard is deliberately the smaller affordance, present but not competing.
    private var voiceComposer: some View {
        HStack(spacing: 0) {
            if services.recorder.state.isRecording {
                recordingBar
            } else {
                // Keyboard segment — small, and divided from the mic target so the two
                // tap zones are legible without a second control.
                Button {
                    Haptics.light()
                    typing = true
                    composerFocused = true
                } label: {
                    Image(systemName: "keyboard")
                        .font(Theme.sans(15))
                        .foregroundStyle(Theme.paper.opacity(0.55))
                        .frame(width: 62, height: 52)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Rectangle()
                    .fill(Theme.paper.opacity(0.18))
                    .frame(width: 0.5, height: 22)

                Button(action: toggleRecording) {
                    HStack(spacing: 9) {
                        Image(systemName: "mic.fill").font(Theme.sans(15, .medium))
                        Text("Ask").font(Theme.serif(16, .medium))
                    }
                    .foregroundStyle(Theme.paper)
                    .frame(maxWidth: .infinity)
                    .frame(height: 52)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .frame(height: services.recorder.state.isRecording ? 66 : 52)
        .background(Theme.ink, in: Capsule())
        .padding(.horizontal, Theme.gutter)
    }

    private var recordingBar: some View {
        Button(action: toggleRecording) {
            HStack(spacing: 12) {
                // Speech time, not just wall time: how much you actually SAID.
                Text(clock(services.recorder.state.speechSeconds))
                    .font(Theme.mono(13)).foregroundStyle(Theme.paper.opacity(0.55))
                Spacer()
                Text(wallClock)
                    .font(Theme.mono(26, .medium)).foregroundStyle(Theme.paper)
                Spacer()
                ZStack {
                    Circle().fill(Theme.paper.opacity(0.22)).frame(width: 38, height: 38)
                    Image(systemName: "stop.fill").font(Theme.sans(14, .medium))
                        .foregroundStyle(Theme.paper)
                }
                // The one teal mark in the UI — it pulses only while you are actually
                // speaking, so you can see the VAD hearing you.
                .overlay(alignment: .topTrailing) {
                    Circle().fill(Theme.accent)
                        .frame(width: 8, height: 8)
                        .opacity(services.recorder.state.isSpeaking ? 1 : 0.25)
                }
            }
            .padding(.horizontal, 18)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// The same bar, expanded. Typing is available; it is simply not the default.
    private var keyboardComposer: some View {
        HStack(spacing: 10) {
            Button {
                Haptics.light()
                typing = false
                composerFocused = false
                draft = ""
            } label: {
                Image(systemName: "mic.fill").font(Theme.sans(15))
                    .foregroundStyle(Theme.inkSoft)
                    .frame(width: 34, height: 34)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            TextField("Ask…", text: $draft, axis: .vertical)
                .font(Theme.serif(16))
                .foregroundStyle(Theme.ink)
                .lineLimit(1...5)
                .focused($composerFocused)
                .submitLabel(.send)
                .onSubmit(sendTyped)

            Button(action: sendTyped) {
                Image(systemName: "arrow.up")
                    .font(Theme.sans(15, .semibold))
                    .foregroundStyle(Theme.paper)
                    .frame(width: 34, height: 34)
                    .background(trimmedDraft.isEmpty ? Theme.inkFaint : Theme.ink, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(trimmedDraft.isEmpty)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(
            Capsule().fill(Theme.paperInset)
                .overlay(Capsule().stroke(Theme.rule, lineWidth: 0.5))
        )
        .padding(.horizontal, Theme.gutter)
    }

    private var trimmedDraft: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func sendTyped() {
        guard !trimmedDraft.isEmpty else { return }
        Haptics.light()
        conversation?.ask(trimmedDraft)
        draft = ""
    }

    private func toggleRecording() {
        if services.recorder.state.isRecording {
            Haptics.light()
            conversation?.stopVoice()
        } else {
            Haptics.heavy()
            conversation?.startVoice()
        }
    }

    /// Is anything in flight? Drives the heartbeat so timers keep counting.
    private var isWorking: Bool {
        conversation?.state.questions.contains { $0.state == .asking || $0.state == .transcribing } ?? false
    }

    private var wallClock: String {
        guard let started = services.recorder.state.startedAt else { return "0:00" }
        return clock(now.timeIntervalSince(started))
    }

    private func clock(_ seconds: TimeInterval) -> String {
        let s = Int(seconds)
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

/// The analyst's steps, behind a header that never moves.
///
/// The toggle lives at the TOP and stays put whether the block is open or closed, so
/// collapsing removes content *below* the control you just tapped — the question stays
/// where it was and nothing scrolls out from under you. The height change is deliberately
/// NOT animated: animating it drags the whole feed and leaves you hunting for your place.
struct NarrationView: View {
    let beats: [NarrationBeat]
    let live: Bool
    let now: Date

    @State private var expanded: Bool
    @State private var userChose = false

    init(beats: [NarrationBeat], live: Bool, now: Date) {
        self.beats = beats
        self.live = live
        self.now = now
        _expanded = State(initialValue: live)      // open while it runs; that is when it is worth watching
    }

    var body: some View {
        content.onChange(of: live) { _, _ in
            guard !userChose else { return }       // follow the run until the reader decides
            expanded = live
        }
    }

    @ViewBuilder
    private var content: some View {
        if beats.isEmpty {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 0) {
                header
                if expanded {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(beats.enumerated()), id: \.element.seq) { index, beat in
                            if index > 0 {
                                Rectangle().fill(Theme.rule.opacity(0.5)).frame(height: 0.5)
                            }
                            row(beat, isCurrent: live && beat.seq == beats.last?.seq)
                        }
                    }
                    .padding(.top, 4)
                }
            }
        }
    }

    private var header: some View {
        Button {
            // No withAnimation: an instant height change keeps the feed still.
            expanded.toggle()
            userChose = true
            Haptics.light()
        } label: {
            HStack(spacing: 7) {
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(Theme.sans(9, .semibold))
                    .frame(width: 10)
                Text("Analysis")
                    .font(Theme.sans(11, .medium))
                    .tracking(0.5)
                Text("·")
                Text("\(beats.count) step\(beats.count == 1 ? "" : "s")")
                    .font(Theme.sans(11))
                if let total = totalDuration {
                    Text("·")
                    Text(total).font(Theme.mono(11)).monospacedDigit()
                }
                Spacer()
            }
            .foregroundStyle(Theme.inkFaint)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func row(_ beat: NarrationBeat, isCurrent: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            MarkdownText(raw: beat.text, font: Theme.sans(13),
                         color: isCurrent ? Theme.ink : Theme.inkSoft, lineSpacing: 3)
            // Held back for the first second: a step stamped "0s" reads as though it never
            // ran, when it has only just started.
            let secs = elapsed(for: beat)
            if secs >= 1 {
                Text("\(secs)s")
                    .font(Theme.mono(11))
                    .foregroundStyle(isCurrent ? Theme.accent : Theme.inkFaint)
                    .monospacedDigit()
            }
        }
        .padding(.vertical, 7)
    }

    private func elapsed(for beat: NarrationBeat) -> Int {
        guard let index = beats.firstIndex(where: { $0.seq == beat.seq }) else { return 0 }
        let end = index < beats.count - 1 ? beats[index + 1].atMs : Int64(now.timeIntervalSince1970 * 1000)
        return max(0, Int((end - beat.atMs) / 1000))
    }

    private var totalDuration: String? {
        guard let first = beats.first else { return nil }
        let end = live ? Int64(now.timeIntervalSince1970 * 1000) : (beats.last?.atMs ?? first.atMs)
        let secs = max(0, Int((end - first.atMs) / 1000))
        return secs >= 1 ? "\(secs)s" : nil
    }
}
