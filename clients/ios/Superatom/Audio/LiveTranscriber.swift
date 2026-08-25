import Foundation
import AVFoundation
import Speech
import Observation

// ── On-device speech to text ─────────────────────────────────────────────────
// Apple's SpeechAnalyzer (iOS 26). Runs entirely on the phone, so words appear WHILE you
// speak rather than a second or more after you stop — the difference between the app
// feeling instant and feeling like it is thinking.
//
// It is the PRIMARY transcriber. The server (Gemini) stays as the fallback for what
// on-device cannot cover: a locale with no installed model, or nothing recognised at all.
// Neither ever sends on its own — both land in the review card, which was already the
// design, so the two can disagree without any harm.
//
// `progressiveTranscription` yields volatile partials as you talk plus corrected finals,
// so the live text tightens up instead of only appearing at the end.

@available(iOS 26.0, *)
@Observable
final class LiveTranscriber: @unchecked Sendable {

    /// What has been heard so far, updated continuously while speaking.
    private(set) var partial = ""
    private(set) var isRunning = false
    /// Set when on-device transcription is unavailable, so the caller can lean on the
    /// server rather than the user losing their question.
    private(set) var unavailable: String?

    private var analyzer: SpeechAnalyzer?
    private var transcriber: SpeechTranscriber?
    private var inputStream: AsyncStream<AnalyzerInput>.Continuation?
    private var resultsTask: Task<Void, Never>?
    private var converter: AVAudioConverter?
    private var analyzerFormat: AVAudioFormat?

    /// Everything already finalised. Volatile partials are shown appended to this but
    /// never committed — otherwise a correction would duplicate text instead of replacing it.
    private var settled = ""

    static func isSupported(_ locale: Locale = .current) async -> Bool {
        let supported = await SpeechTranscriber.supportedLocales
        return supported.contains { $0.identifier(.bcp47) == locale.identifier(.bcp47) }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    func start(locale: Locale = .current) async {
        guard !isRunning else { return }
        partial = ""
        settled = ""
        unavailable = nil

        guard await Self.isSupported(locale) else {
            unavailable = "No on-device model for \(locale.identifier)."
            return
        }

        let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        self.transcriber = transcriber

        do {
            // The model is a downloadable asset: the first run for a locale fetches it,
            // every run after returns immediately.
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                try await request.downloadAndInstall()
            }
        } catch {
            unavailable = "Speech model unavailable."
            return
        }

        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer
        analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])

        resultsTask = Task { [weak self] in
            guard let self, let transcriber = self.transcriber else { return }
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    if result.isFinal {
                        self.settled = self.settled.isEmpty ? text : self.settled + " " + text
                        self.partial = self.settled
                    } else {
                        self.partial = self.settled.isEmpty ? text : self.settled + " " + text
                    }
                }
            } catch {
                // Not fatal: the server transcript still arrives.
            }
        }

        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        inputStream = continuation
        do {
            try await analyzer.start(inputSequence: stream)
            isRunning = true
        } catch {
            unavailable = "Could not start on-device transcription."
        }
    }

    /// Feed one buffer from the microphone tap. Called on the audio thread, so it does
    /// nothing beyond a format conversion and a queue append.
    func append(_ buffer: AVAudioPCMBuffer) {
        guard isRunning, let continuation = inputStream, let converted = convert(buffer) else { return }
        continuation.yield(AnalyzerInput(buffer: converted))
    }

    @discardableResult
    func finish() async -> String {
        guard isRunning else { return partial.trimmingCharacters(in: .whitespacesAndNewlines) }
        isRunning = false
        inputStream?.finish()
        inputStream = nil
        try? await analyzer?.finalizeAndFinishThroughEndOfInput()
        resultsTask?.cancel()
        resultsTask = nil
        analyzer = nil
        transcriber = nil
        converter = nil
        return partial.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func cancel() {
        isRunning = false
        inputStream?.finish()
        inputStream = nil
        resultsTask?.cancel()
        resultsTask = nil
        let dying = analyzer
        Task { await dying?.cancelAndFinishNow() }
        analyzer = nil
        transcriber = nil
        partial = ""
        settled = ""
    }

    // ── Format ───────────────────────────────────────────────────────────────

    /// The analyzer has its own preferred format, which is not the 16 kHz mono the upload
    /// path uses — so the tap's buffer is converted here rather than forcing one format
    /// on both consumers.
    private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let target = analyzerFormat else { return buffer }
        if buffer.format.isEqual(target) { return buffer }

        if converter == nil || converter?.inputFormat.isEqual(buffer.format) == false {
            converter = AVAudioConverter(from: buffer.format, to: target)
        }
        guard let converter else { return nil }

        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up))
        guard capacity > 0, let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity)
        else { return nil }

        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            status.pointee = .haveData
            return buffer
        }
        return error == nil && out.frameLength > 0 ? out : nil
    }
}


// ── Availability bridge ──────────────────────────────────────────────────────
// The app supports iOS 17; SpeechAnalyzer arrived in 26. Rather than raise the floor for
// everyone — the server path works perfectly well without it — this holds the transcriber
// behind an untyped reference so the property itself carries no availability requirement.
// On an older device every call is a no-op and `text` stays empty, which the caller
// already treats as "use the server transcript".

@Observable
final class SpeechBridge: @unchecked Sendable {
    /// Live text so far, or empty when on-device transcription isn't running.
    private(set) var text = ""
    private(set) var available = false

    private var impl: AnyObject?
    private var mirror: Task<Void, Never>?

    init() {
        if #available(iOS 26.0, *) { available = true }
    }

    func start() {
        guard #available(iOS 26.0, *), available else { return }
        let transcriber = LiveTranscriber()
        impl = transcriber
        text = ""
        Task { await transcriber.start() }
        // Mirror the transcriber's partial into a property this class can expose without
        // an availability annotation.
        mirror = Task { [weak self] in
            while !Task.isCancelled {
                if let current = (self?.impl as? LiveTranscriber)?.partial, current != self?.text {
                    await MainActor.run { self?.text = current }
                }
                try? await Task.sleep(nanoseconds: 120_000_000)
            }
        }
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        guard #available(iOS 26.0, *), let transcriber = impl as? LiveTranscriber else { return }
        transcriber.append(buffer)
    }

    /// Final on-device text, or empty when unavailable — the caller then waits for the server.
    func finish() async -> String {
        guard #available(iOS 26.0, *), let transcriber = impl as? LiveTranscriber else { return "" }
        mirror?.cancel(); mirror = nil
        let final = await transcriber.finish()
        impl = nil
        await MainActor.run { self.text = final }
        return final
    }

    func cancel() {
        guard #available(iOS 26.0, *), let transcriber = impl as? LiveTranscriber else { return }
        mirror?.cancel(); mirror = nil
        transcriber.cancel()
        impl = nil
        text = ""
    }
}
