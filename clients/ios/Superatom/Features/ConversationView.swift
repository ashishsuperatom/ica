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
    /// Which input you last used, remembered across conversations and launches. Switching
    /// to the keyboard means you want the keyboard next time too.
    /// Typing is the default, and the choice is remembered on this device: switching to
    /// the keyboard means you want the keyboard next time too, and switching back to voice
    /// means the opposite. Neither is imposed after the first time you say which you want.
    @AppStorage("sa.pref.composeByTyping") private var typing = true
    @State private var editingPending = false
    @State private var pendingText = ""
    @State private var draft = ""
    @State private var now = Date.now
    @State private var copiedItem: String?
    @State private var confirmingStop = false
    @State private var notifyDenied = false
    @State private var pendingView: EntityTap?

    /// A tapped cell, waiting to be confirmed.
    struct EntityTap: Identifiable {
        let entity: String, id: String, label: String
    }
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
        .confirmationDialog("Look at \(pendingView?.label ?? "this")?",
                            isPresented: .init(get: { pendingView != nil },
                                               set: { if !$0 { pendingView = nil } }),
                            titleVisibility: .visible) {
            Button("Open") {
                if let tap = pendingView { conversation.openEntity(tap.entity, id: tap.id) }
                pendingView = nil
            }
            Button("Cancel", role: .cancel) { pendingView = nil }
        } message: {
            Text("Asks the engine for everything it knows about this \(pendingView?.entity ?? "item").")
        }
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
                            // The separator is a SIBLING of the turn, not part of it.
                            // Inside, it became the top of the identified view — so
                            // scrolling a new question to the top actually parked the
                            // separator there, leaving the previous answer's actions still
                            // on screen and stealing a chunk of the view from the answer
                            // about to arrive.
                            if index > 0 { TurnBreak().padding(.vertical, 26) }
                            turn(question, conversation: conversation)
                                .id(question.id)
                        }
                        // Enough room below the newest question that it can travel all the
                        // way to the top of the screen, even when its answer hasn't arrived
                        // yet and there is nothing under it. Sized to the gap rather than a
                        // fixed slab, so a long answer doesn't leave dead space beneath it.
                        // The same mark that separates turns, closing the last one — so
                        // scrolling to the bottom you can see the conversation has ended
                        // rather than wondering whether more is still loading.
                        if !conversation.state.questions.isEmpty {
                            TurnBreak().padding(.top, 26)
                        }

                        // Half a screen of tail: enough for the newest question to travel
                        // to the top, never enough to scroll into emptiness.
                        //
                        // This used to be computed from a measurement of the last turn,
                        // which created a feedback loop — measuring set state, state
                        // resized the tail, resizing re-triggered the measurement, and
                        // sub-pixel differences kept it oscillating forever. The view
                        // rebuilt continuously, which is what made the selection menu
                        // flicker on and off while nothing was being touched. A constant
                        // cannot oscillate.
                        Color.clear
                            .frame(height: max(56, viewport.size.height * 0.5))
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
                // A new question goes to the TOP, not the bottom: you asked it, so it should
                // be the thing you are looking at while the answer builds underneath it.
                .onChange(of: conversation.state.questions.count) { _, _ in
                    pinLastQuestion(proxy, in: conversation)
                }
                .onAppear {
                    // A request to show a particular answer wins over the usual "newest at
                    // the top" — you tapped a notification about THAT one.
                    if let target = services.navigation.target,
                       target.sessionId == session.id, let qid = target.questionId {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                            proxy.scrollTo(qid, anchor: .top)
                        }
                        services.navigation.consume()
                    } else {
                        pinLastQuestion(proxy, in: conversation)
                    }
                }
            }
        }
    }

    /// Put the newest question at the top. Deliberately NOT animated.
    ///
    /// Animating it meant the feed visibly travelled from wherever it was to the top on
    /// every single ask — which reads as the app fidgeting, and is doubly odd for a
    /// question that was already near the top. You asked; it is there. The answer building
    /// underneath is the thing worth watching, not the journey to it.
    private func pinLastQuestion(_ proxy: ScrollViewProxy, in conversation: ConversationStore) {
        guard let last = conversation.state.questions.last else { return }
        // One frame for the new row to exist before scrolling to it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) {
            proxy.scrollTo(last.id, anchor: .top)
        }
    }

    private let bottomAnchor = "bottom"

    @ViewBuilder
    private func turn(_ question: Question, conversation: ConversationStore) -> some View {
        VStack(alignment: .leading, spacing: 0) {
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
                    // Only offered where there IS a saved program to re-run — an answer.
                    if hasAnswer(question, in: conversation) {
                        Button {
                            Haptics.medium()
                            conversation.runAgain(questionId: question.id)
                        } label: {
                            Label("Run again", systemImage: "play.circle")
                        }
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
                    NarrationView(beats: services.preferences.showProgramLogs
                                         ? beats : beats.filter { $0.source == .narrator },
                                  live: question.state == .asking, now: now,
                                  showTimings: services.preferences.showTimings)
                }

                ForEach(conversation.state.itemsByQuestion[question.id] ?? []) { item in
                    block(item)
                }

                if question.state == .asking,
                          (conversation.state.beatsByQuestion[question.id] ?? []).isEmpty {
                    workingLine(services.hub.status.label ?? "Thinking…",
                                since: services.preferences.showTimings ? question.askedAt : nil)
                }
                if question.state == .asking {
                    // Actions ON the turn, in the same place the answer's Copy/Share sit —
                    // they belong to this question and scroll with it, rather than being
                    // pinned to the bottom of the screen where they read as app chrome.
                    // Stop left, notify right: destructive on the side you reach past.
                    HStack(spacing: 10) {
                        stopControl
                        Spacer()
                        if isSlow(question) { notifyControl(question) }
                    }
                    .padding(.top, 4)
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
                    // Deliberately NOT selectable. Selectable text needs per-glyph hit
                    // testing, selection rects and the edit menu on the most-instantiated
                    // view in the app — real cost in a long feed, for something the Copy
                    // button below does better anyway.
                    AnswerView(answer: answer) { entity, id, label in
                        // Confirmed, never sent outright. Opening an entity costs a turn,
                        // and a table is something you scroll — a stray tap must not spend
                        // a run.
                        pendingView = EntityTap(entity: entity, id: id, label: label)
                    }
                } else {
                    // The payload didn't decode into the shape we expect. Show it raw
                    // rather than rendering nothing — a visible oddity beats a silent
                    // hole where an answer should be.
                    MarkdownText(raw: item.payload, font: Theme.mono(12), color: Theme.inkSoft, lineSpacing: 3)
                }
                // Cheap check — do NOT build the report text just to decide whether to
                // show the row. That ran on every render pass.
                if item.answer != nil { answerActions(item) }
            }
        case .error:
            VStack(alignment: .leading, spacing: 6) {
                speaker("problem")
                Text(item.payload).font(Theme.sans(13)).foregroundStyle(Theme.warning)
            }
        case .followups:
            if services.preferences.showFollowUps {
                FollowUps(items: item.followups) { question in
                    conversation.proposeFollowUp(question)
                }
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

    /// Copy / share under each answer.
    ///
    /// Both are real tap targets — padded to the 44pt Apple asks for and given an explicit
    /// content shape. Before, the hit area was the glyphs themselves, so a tap that looked
    /// like it landed usually missed, and nothing happened. A control that works one time
    /// in five is worse than no control.
    @ViewBuilder
    private func answerActions(_ item: FeedItem) -> some View {
        let copied = copiedItem == item.id
        VStack(alignment: .leading, spacing: 0) {
        // A faint rule closes the answer before the handles for taking it away — the
        // actions are about the answer, not part of it.
        Rectangle()
            .fill(Theme.rule.opacity(0.45))
            .frame(height: 0.5)
            .padding(.top, 14)

        HStack(spacing: 10) {
            Button {
                // Built HERE, on the tap, not during layout.
                UIPasteboard.general.string = AnswerText.of(item)
                Haptics.success()
                copiedItem = item.id
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
                    if copiedItem == item.id { copiedItem = nil }
                }
            } label: {
                actionChip(copied ? "Copied" : "Copy",
                           icon: copied ? "checkmark" : "doc.on.doc",
                           active: copied)
            }
            .buttonStyle(.plain)
            .disabled(copied)          // nothing to gain from copying twice in a second

            ShareLink(item: AnswerText.of(item)) {
                actionChip("Share", icon: "square.and.arrow.up", active: false)
            }
            Spacer()
        }
        .animation(.easeOut(duration: 0.15), value: copied)
        .padding(.top, 4)
        }
    }

    /// A visible, pressable target — not bare text.
    private func actionChip(_ title: String, icon: String, active: Bool) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon).font(Theme.sans(11, .semibold))
            Text(title).font(Theme.sans(12, .medium))
        }
        .foregroundStyle(active ? Theme.accent : Theme.inkSoft)
        .padding(.horizontal, 12)
        .frame(height: 32)
        .background(
            Capsule().fill(active ? Theme.accent.opacity(0.12) : Theme.paperInset)
        )
        // The visible chip is 32pt; the TAPPABLE area is padded out to 44.
        .padding(.vertical, 6)
        .contentShape(Rectangle())
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
        Elapsed.short(Int(now.timeIntervalSince(since)))
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Spacer()
            Text("Ask a question.").font(Theme.serif(19)).foregroundStyle(Theme.inkFaint)
            // Says what THIS composer does. It always read "just talk", which was wrong
            // the moment someone chose the keyboard — and reads as the app ignoring them.
            Text(typing ? "Type it below, or switch to voice." : "Tap the button and just talk.")
                .font(Theme.sans(13)).foregroundStyle(Theme.inkFaint.opacity(0.85))
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture { dismissKeyboard() }
    }

    /// Give the page back — the keyboard goes away, the composer does NOT change.
    ///
    /// It used to snap back to voice whenever you dismissed with nothing typed, which quietly
    /// wrote the preference too. So choosing the keyboard and then tapping the page put you
    /// back on voice and REMEMBERED voice — the setting could never stick. Which input you
    /// want is something you say by tapping the mic or the keyboard, not something inferred
    /// from an empty field.
    private func dismissKeyboard() {
        guard composerFocused else { return }
        composerFocused = false
    }

    // ── Composer — voice first ───────────────────────────────────────────────

    @ViewBuilder
    private var composer: some View {
        VStack(spacing: 10) {
            if let notice = services.hub.notice {
                Text(notice)
                    .font(Theme.sans(12))
                    .foregroundStyle(Theme.inkFaint)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Theme.gutter)
                    .transition(.opacity)
            }
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

    /// After a question has genuinely been slow, offer to fetch you rather than make you
    /// wait. Not shown before then: most answers arrive quickly, and an always-present
    /// "notify me" would be an admission that waiting is expected.
    private func isSlow(_ question: Question) -> Bool {
        guard let asked = question.askedAt else { return false }
        // A minute. Long enough that waiting has genuinely become the situation, rather
        // than offering an escape hatch from a normal pause.
        return now.timeIntervalSince(asked) >= 60
    }

    @ViewBuilder
    private func notifyControl(_ question: Question) -> some View {
        let armed = services.notifier.isArmed(question.id)
        Button {
            Haptics.light()
            if armed {
                services.notifier.disarm(questionId: question.id)
            } else {
                Task {
                    // Permission is requested HERE, at the moment it is wanted — far more
                    // likely to be granted than asked for at launch for a reason nobody
                    // can see yet.
                    let granted = await services.notifier.arm(questionId: question.id)
                    if !granted { notifyDenied = true }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: armed ? "bell.fill" : "bell")
                    .font(Theme.sans(11, .semibold))
                Text(armed ? "We'll tell you when it's ready" : "Notify me when ready")
                    .font(Theme.sans(12, .medium))
            }
            .foregroundStyle(armed ? Theme.accent : Theme.inkSoft)
            .padding(.horizontal, 12)
            .frame(height: 32)
            .background(Capsule().fill(armed ? Theme.accent.opacity(0.12) : Theme.paperInset))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .alert("Notifications are off", isPresented: $notifyDenied) {
            Button("OK", role: .cancel) { }
        } message: {
            Text("Turn them on for Superatom in Settings to be told when an answer is ready.")
        }
    }

    /// Stop the turn in progress.
    ///
    /// Confirmed, deliberately. On a phone this sits inches from where a thumb rests while
    /// reading, and stopping is not free — it abandons work that may be nearly done and
    /// cannot be resumed. A dialog is the difference between a decision and a brush.
    private var stopControl: some View {
        Button(role: .destructive) {
            Haptics.medium()
            confirmingStop = true
        } label: {
            // Small and quiet. It sits beside a log people scroll and read, so a large
            // tinted button is both a distraction and something a thumb finds by accident.
            HStack(spacing: 5) {
                Image(systemName: "stop.fill").font(Theme.sans(9))
                Text("Stop").font(Theme.sans(11, .medium))
            }
            .foregroundStyle(Theme.inkFaint)
            .padding(.horizontal, 9)
            .frame(height: 26)
            .background(Capsule().stroke(Theme.rule, lineWidth: 0.5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .confirmationDialog("Stop this question?", isPresented: $confirmingStop, titleVisibility: .visible) {
            Button("Stop", role: .destructive) {
                Haptics.heavy()
                conversation.stopTurn()
            }
            Button("Keep going", role: .cancel) { }
        } message: {
            Text("The engine will abandon the work it has done so far. You can ask again afterwards.")
        }
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
    /// Program runs the reader has opened, keyed by the first line of the run.
    @State private var openRuns: Set<Int> = []

    /// Timings are opt-in — see Preferences.showTimings for why.
    let showTimings: Bool

    init(beats: [NarrationBeat], live: Bool, now: Date, showTimings: Bool) {
        self.beats = beats
        self.live = live
        self.now = now
        self.showTimings = showTimings
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
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, group in
                            // The collapsed count rides the rule too, so the log line
                            // itself runs the full width with nothing set into it.
                            let collapsible = group.isProgram && group.beats.count > 1
                            stepRule(seconds: group.seconds, isProgram: group.isProgram,
                                     isFirst: index == 0,
                                     hidden: collapsible && !openRuns.contains(group.id)
                                             ? group.beats.count - 1 : 0,
                                     open: collapsible && openRuns.contains(group.id),
                                     onToggle: collapsible ? {
                                         if openRuns.contains(group.id) { openRuns.remove(group.id) }
                                         else { openRuns.insert(group.id) }
                                     } : nil)
                            beatRow(group, isLast: index == rows.count - 1)
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
                if showTimings, let total = totalDuration {
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
    /// Beats grouped for display: consecutive PROGRAM lines become one row.
    ///
    /// A program emits a line per unit, per decision and per query, so a real one buries
    /// the narrator's few sentences under thirty of its own. A run collapses to its LATEST
    /// line — which is what a progress line is for, each replacing the last — with a count
    /// to open the rest.
    private var rows: [BeatRow] {
        let end = Int64(now.timeIntervalSince1970 * 1000)
        func seconds(_ index: Int) -> Int {
            let next = index < beats.count - 1 ? beats[index + 1].atMs : end
            return max(0, Int((next - beats[index].atMs) / 1000))
        }

        var out: [BeatRow] = []
        var index = 0
        while index < beats.count {
            if beats[index].source == .program {
                let first = index
                while index < beats.count, beats[index].source == .program { index += 1 }
                let run = Array(beats[first..<index])
                // The run's own duration: from its first line to whatever follows it.
                let span = max(0, Int(((index < beats.count ? beats[index].atMs : end) - run[0].atMs) / 1000))
                out.append(BeatRow(id: run[0].seq, beats: run, seconds: span, isProgram: true))
            } else {
                out.append(BeatRow(id: beats[index].seq, beats: [beats[index]],
                                   seconds: seconds(index), isProgram: false))
                index += 1
            }
        }
        return out
    }

    struct BeatRow: Identifiable {
        let id: Int
        let beats: [NarrationBeat]
        let seconds: Int
        let isProgram: Bool
    }

    /// While a run is live, only the most recent steps are shown — a verification loop
    /// against a flaky source produces twenty-plus, and your question should not be pushed
    /// off the screen by them. Opening the block shows the lot.
    private let liveTail = 5

    /// One display row: a narrator line, or a run of program lines collapsed to its latest.
    @ViewBuilder
    private func beatRow(_ group: BeatRow, isLast: Bool) -> some View {
        let open = openRuns.contains(group.id)
        if group.isProgram && group.beats.count > 1 && !open {
            // THE WHOLE ROW toggles, not a small chevron: on a phone a 10pt glyph is a
            // miss waiting to happen, and there is nothing else in this row to hit.
            Button {
                Haptics.light()
                openRuns.insert(group.id)
            } label: {
                // The LATEST line only — a progress line replaces the one before it — and
                // it runs the full width, because the count and the time both live in the
                // rule above.
                MarkdownText(raw: group.beats.last!.text, font: Theme.mono(11),
                             color: Theme.accent, lineSpacing: 3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.vertical, 7)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(group.beats.enumerated()), id: \.element.seq) { index, beat in
                    // Tapping the FIRST line closes the run — the same row that opened it.
                    // A separate "Hide" at the bottom meant scrolling past everything you
                    // just opened to get rid of it, and two controls for one state.
                    if index == 0, group.isProgram, group.beats.count > 1 {
                        Button {
                            Haptics.light()
                            openRuns.remove(group.id)
                        } label: {
                            row(beat, isCurrent: false)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    } else {
                        row(beat, isCurrent: live && isLast && index == group.beats.count - 1)
                    }
                }
            }
        }
    }

    private func row(_ beat: NarrationBeat, isCurrent: Bool) -> some View {
        // No timer column: the duration rides the RULE above each step instead, so a line
        // of log runs the full width from one edge to the other.
        //
        // Two voices, told apart by colour AND typeface, needing no glyph:
        //   narrator — the engine describing its work, in the reading face
        //   program  — the computation reporting itself, in mono and the accent
        let isProgram = beat.source == .program
        return MarkdownText(raw: beat.text,
                            font: isProgram ? Theme.mono(11) : Theme.sans(13),
                            color: isProgram ? Theme.accent : (isCurrent ? Theme.ink : Theme.inkSoft),
                            lineSpacing: 3)
            .padding(.vertical, 7)
    }

    /// The rule above a step, with that step's duration set into it.
    ///
    /// The duration used to be a fixed column on the right, which cost width on every line
    /// and left a ragged channel down the page. Here it rides a rule that was already being
    /// drawn as a separator: the number costs no width, and the text runs edge to edge.
    ///
    /// ABOVE rather than below, because a step's block grows downward when it expands — an
    /// anchor above it stays put while everything else moves.
    ///
    /// With timings off it is simply the separator. Same element, one fewer piece of
    /// information, rather than a different layout.
    @ViewBuilder
    private func stepRule(seconds: Int, isProgram: Bool, isFirst: Bool,
                          hidden: Int = 0, open: Bool = false,
                          onToggle: (() -> Void)? = nil) -> some View {
        let showsTime = showTimings && seconds >= 1
        let showsCount = hidden > 0 || open
        if !isFirst || showsTime || showsCount {
            HStack(spacing: 8) {
                Rectangle().fill(Theme.rule.opacity(0.5)).frame(height: 0.5)
                if showsTime || showsCount {
                    HStack(spacing: 6) {
                        if showsTime {
                            Text(Elapsed.short(seconds))
                                .font(Theme.mono(10)).monospacedDigit()
                                .foregroundStyle(isProgram ? Theme.accent.opacity(0.7) : Theme.inkFaint)
                        }
                        if showsCount {
                            HStack(spacing: 2) {
                                if hidden > 0 { Text("+\(hidden)").font(Theme.mono(10)) }
                                Image(systemName: open ? "chevron.up" : "chevron.down")
                                    .font(Theme.sans(7, .semibold))
                            }
                            .foregroundStyle(Theme.accent.opacity(0.8))
                        }
                    }
                    Rectangle().fill(Theme.rule.opacity(0.5)).frame(height: 0.5)
                }
            }
            .padding(.vertical, 2)
            // The chevron sits in this rule, so the rule has to answer to it. An arrow that
            // looks like it opens something and does nothing is worse than no arrow.
            .contentShape(Rectangle())
            .onTapGesture {
                guard let onToggle else { return }
                Haptics.light()
                onToggle()
            }
        }
    }

    private var totalDuration: String? {
        guard let first = beats.first else { return nil }
        let end = live ? Int64(now.timeIntervalSince1970 * 1000) : (beats.last?.atMs ?? first.atMs)
        let secs = max(0, Int((end - first.atMs) / 1000))
        return secs >= 1 ? Elapsed.short(secs) : nil
    }
}
