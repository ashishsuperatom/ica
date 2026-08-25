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
    /// Built in init, NOT in .task — a store created after the first frame means the view
    /// renders its empty state first and only fills in once something forces a redraw,
    /// which reads as a blank screen that "wakes up" when you touch it. The conversation
    /// is already on disk; it should be on screen in the first frame.
    @State private var conversation: ConversationStore
    @State private var typing = false
    @State private var editingPending = false
    @State private var pendingText = ""
    @State private var draft = ""
    @State private var now = Date.now
    @State private var lastTurnHeight: CGFloat = 0
    @FocusState private var composerFocused: Bool

    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    init(session: Session, services: Services) {
        self.session = session
        _conversation = State(initialValue: ConversationStore(db: services.db, session: session, services: services))
    }

    var body: some View {
        VStack(spacing: 0) {
            if conversation.state.isEmpty && !services.recorder.state.isRecording {
                emptyState
            } else {
                feed(conversation)
            }
            composer
        }
        .pageBackground()
        .navigationTitle(session.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear { if services.recorder.state.isRecording { conversation.stopVoice() } }
        // One heartbeat drives BOTH the recording clock and the narration timers. Without
        // it the elapsed seconds only moved when a new beat arrived, which made a long
        // step look frozen exactly when you most want to see it counting.
        .onReceive(timer) { _ in
            if services.recorder.state.isRecording || isWorking { now = .now }
        }
    }

    // ── Feed ─────────────────────────────────────────────────────────────────

    private func feed(_ conversation: ConversationStore) -> some View {
        GeometryReader { viewport in
            ScrollViewReader { proxy in
                ScrollView(showsIndicators: false) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(conversation.state.questions.enumerated()), id: \.element.id) { index, question in
                            turn(question, conversation: conversation, isFirst: index == 0)
                                .id(question.id)
                                // Measure the LAST turn so the tail below it can be sized
                                // exactly — no more, no less.
                                .background(alignment: .top) {
                                    if question.id == conversation.state.questions.last?.id {
                                        GeometryReader { turn in
                                            Color.clear.preference(key: LastTurnHeight.self, value: turn.size.height)
                                        }
                                    }
                                }
                        }
                        // Enough room below the newest question that it can travel all the
                        // way to the top of the screen, even when its answer hasn't arrived
                        // yet and there is nothing under it. Sized to the gap rather than a
                        // fixed slab, so a long answer doesn't leave dead space beneath it.
                        Color.clear
                            .frame(height: max(56, viewport.size.height - lastTurnHeight - 30))
                            .id(bottomAnchor)
                    }
                    .padding(.top, 24)
                    .background {
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture { dismissKeyboard() }
                    }
                }
                .scrollDismissesKeyboard(.interactively)
                .onPreferenceChange(LastTurnHeight.self) { lastTurnHeight = $0 }
                // A new question goes to the TOP, not the bottom: you asked it, so it should
                // be the thing you are looking at while the answer builds underneath it.
                .onChange(of: conversation.state.questions.count) { _, _ in
                    pinLastQuestion(proxy, in: conversation)
                }
                .onAppear { pinLastQuestion(proxy, in: conversation, animated: false) }
            }
        }
    }

    private func pinLastQuestion(_ proxy: ScrollViewProxy, in conversation: ConversationStore, animated: Bool = true) {
        guard let last = conversation.state.questions.last else { return }
        // One frame for the new row to exist before scrolling to it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            withAnimation(animated ? .easeOut(duration: 0.3) : nil) {
                proxy.scrollTo(last.id, anchor: .top)
            }
        }
    }

    private let bottomAnchor = "bottom"

    @ViewBuilder
    private func turn(_ question: Question, conversation: ConversationStore, isFirst: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if !isFirst { TurnBreak().padding(.vertical, 26) }

            VStack(alignment: .leading, spacing: 15) {
                // The question is the handle for its whole exchange. Deleting is
                // deliberately absent: removing a question mid-thread would strand its
                // answer with nothing above it, so that lives on the conversation list.
                Menu {
                    Button {
                        conversation.askAgain(question.text)
                    } label: {
                        Label("Ask again", systemImage: "arrow.clockwise")
                    }
                    if question.state == .asking || question.state == .failed {
                        Button {
                            services.hub.recheck(questionId: question.id)
                            Haptics.light()
                        } label: {
                            Label("Check for answer", systemImage: "arrow.down.circle")
                        }
                    }
                    Button {
                        UIPasteboard.general.string = question.text
                        Haptics.success()
                    } label: {
                        Label("Copy question", systemImage: "doc.on.doc")
                    }
                    if hasAnswer(question, in: conversation) {
                        Button {
                            UIPasteboard.general.string = answerText(for: question, in: conversation)
                            Haptics.success()
                        } label: {
                            Label("Copy answer", systemImage: "doc.on.clipboard")
                        }
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        speaker("you", spoken: question.source == .voice)
                        Text(question.text.isEmpty ? "…" : question.text)
                            .font(Theme.serif(18))
                            .foregroundStyle(question.text.isEmpty ? Theme.inkFaint : Theme.ink)
                            .lineSpacing(6)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .contentShape(Rectangle())
                }
                .menuStyle(.button)
                .buttonStyle(.plain)

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
                    workingLine(services.hub.status.label ?? "Thinking…", since: question.askedAt)
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
                conversation.proposeFollowUp(question)
            }
        case .note:
            EmptyView()
        }
    }

    /// Who is speaking. "you" stays quiet; the engine's name carries the accent, so a
    /// glance down the page separates your questions from its answers without reading.
    private func hasAnswer(_ question: Question, in conversation: ConversationStore) -> Bool {
        conversation.state.itemsByQuestion[question.id]?.contains { $0.kind == .answer } ?? false
    }

    /// The answer to a question as copyable text, if it has one.
    private func answerText(for question: Question, in conversation: ConversationStore) -> String? {
        conversation.state.itemsByQuestion[question.id]?
            .first(where: { $0.kind == .answer })?.answer?
            .plainText(questionId: question.id, answeredAt: question.answeredAt)
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

    /// There is no timeout on a question, so the wait has to be legible: an elapsed
    /// counter is the difference between "still working" and "this has hung".
    private func workingLine(_ text: String, since: Date? = nil) -> some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(text).font(Theme.sans(13)).foregroundStyle(Theme.inkFaint)
            if let since {
                Text(elapsedLabel(since))
                    .font(Theme.mono(11))
                    .monospacedDigit()
                    .foregroundStyle(Theme.inkFaint.opacity(0.8))
            }
        }
    }

    private func elapsedLabel(_ since: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(since)))
        return seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s"
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
            if let failure = conversation.voiceError ?? services.recorder.state.failure {
                Text(failure).font(Theme.sans(12)).foregroundStyle(Theme.warning)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Theme.gutter)
            }
            if services.recorder.state.isRecording, !conversation.liveTranscript.isEmpty {
                Text(conversation.liveTranscript)
                    .font(Theme.serif(17))
                    .foregroundStyle(Theme.inkSoft)
                    .lineSpacing(5)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(
                        RoundedRectangle(cornerRadius: 18).fill(Theme.paperInset)
                    )
                    .padding(.horizontal, Theme.gutter)
                    .transition(.opacity)
            }

            if let pending = conversation.state.pending {
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
        .animation(.easeInOut(duration: 0.22), value: conversation.state.pending?.id)
        .animation(.easeOut(duration: 0.15), value: conversation.liveTranscript.isEmpty)
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
                        .onChange(of: pendingText) { _, new in conversation.editPending(new) }
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
                    conversation.cancelPending()
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
                    conversation.submitPending()
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
        conversation.ask(trimmedDraft)
        draft = ""
    }

    private func toggleRecording() {
        if services.recorder.state.isRecording {
            Haptics.light()
            conversation.stopVoice()
        } else {
            Haptics.heavy()
            conversation.startVoice()
        }
    }

    /// Is anything in flight? Drives the heartbeat so timers keep counting.
    private var isWorking: Bool {
        conversation.state.questions.contains { $0.state == .asking || $0.state == .transcribing }
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
                        ForEach(Array(timed.enumerated()), id: \.element.beat.seq) { index, entry in
                            if index > 0 {
                                Rectangle().fill(Theme.rule.opacity(0.5)).frame(height: 0.5)
                            }
                            row(entry.beat, seconds: entry.seconds, isCurrent: live && index == timed.count - 1)
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
                if live, !userChose, beats.count > liveTail {
                    Text("· showing latest \(liveTail)").font(Theme.sans(10))
                }
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

    /// Each beat paired with how long it took — walked once, in order, instead of
    /// searching the array again for every row.
    private var timed: [(beat: NarrationBeat, seconds: Int)] {
        let end = Int64(now.timeIntervalSince1970 * 1000)
        let all = beats.indices.map { index -> (beat: NarrationBeat, seconds: Int) in
            let next = index < beats.count - 1 ? beats[index + 1].atMs : end
            return (beats[index], max(0, Int((next - beats[index].atMs) / 1000)))
        }
        // A long run can produce twenty-plus steps — a verification loop against a flaky
        // source will do it easily. While it is RUNNING, what matters is what it is doing
        // now, so only the recent steps are shown; tapping the header reveals the lot.
        guard live, !userChose, all.count > liveTail else { return all }
        return Array(all.suffix(liveTail))
    }

    private let liveTail = 5

    private func row(_ beat: NarrationBeat, seconds: Int, isCurrent: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            MarkdownText(raw: beat.text, font: Theme.sans(13),
                         color: isCurrent ? Theme.ink : Theme.inkSoft, lineSpacing: 3)
            // A FIXED column for the elapsed time, wide enough for "999s".
            //
            // Without it the text column is whatever is left over, so "2s" and "92s" give
            // the content different widths and every line re-wraps as the timer ticks past
            // 9 and 99. The space is reserved even while the label is hidden for the first
            // second, so nothing shifts when it appears.
            Text(seconds >= 1 ? "\(seconds)s" : "")
                .font(Theme.mono(11))
                .foregroundStyle(isCurrent ? Theme.accent : Theme.inkFaint)
                .monospacedDigit()
                .frame(width: 34, alignment: .trailing)
        }
        .padding(.vertical, 7)
    }

    private var totalDuration: String? {
        guard let first = beats.first else { return nil }
        let end = live ? Int64(now.timeIntervalSince1970 * 1000) : (beats.last?.atMs ?? first.atMs)
        let secs = max(0, Int((end - first.atMs) / 1000))
        return secs >= 1 ? "\(secs)s" : nil
    }
}

/// Height of the newest turn, so the scroll tail can be sized to exactly the room that
/// question needs to reach the top of the screen.
private struct LastTurnHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
