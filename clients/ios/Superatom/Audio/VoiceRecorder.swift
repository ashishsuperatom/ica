import AVFoundation
import Observation
import UIKit
import RealTimeCutVADLibrary

// ── Voice capture ────────────────────────────────────────────────────────────
// Continuous mic → Silero VAD → speech-only chunks.
//
//   voiceDidContinue  accumulate speech PCM (the library only calls this during speech)
//   voiceEnded        a natural pause: flush if we've banked ≥10s
//   hard cap          every 0.5s, force a flush at ≥15s so a long sentence still streams
//   stop              flush whatever is banked, whatever its length
//
// The last rule is why short questions work: a two-second question banks nothing until
// you stop, and stopping flushes unconditionally. The 10s floor only governs flushes
// MID-recording.
//
// THIS CLASS IS DELIBERATELY NOT ACTOR-ISOLATED.
// AVAudioEngine taps, dispatch timers and the VAD delegate all call back on their own
// threads. Marking the class @MainActor makes Swift 6 insert an executor assertion into
// every one of those callbacks, and the process traps the moment audio starts. The
// observable UI state lives in `VoiceState` instead, updated on the main queue.

final class VoiceRecorder: NSObject {

    /// (wav, speechMs, chunkIndex, isFinal) — always delivered on the main queue.
    var onChunk: ((Data, Int, Int, Bool) -> Void)?

    /// What the UI observes. Separate object so the audio engine needs no isolation.
    let state = VoiceState()

    /// On-device transcription, fed from the same tap. It sees EVERY buffer, not just the
    /// speech the VAD keeps, because the analyzer does its own endpointing and hearing the
    /// silences helps it decide where phrases end.
    let speech = SpeechBridge()

    private var engine: AVAudioEngine?
    private var vad: VADWrapper?
    private let audioQueue = DispatchQueue(label: "ai.superatom.audio", qos: .userInitiated)

    // Touched only on audioQueue.
    private var speechSamples: [Float] = []
    private var chunkIndex = 0
    private var didCaptureSpeech = false

    private var speechStartedAt: Date?
    private var hardCapTimer: DispatchSourceTimer?
    private var observers: [NSObjectProtocol] = []
    private var converter: AVAudioConverter?
    private var targetFormat: AVAudioFormat?
    private var useOnDevice = true

    private let sampleRate: Double = 16_000
    private let minSamples = 10 * 16_000
    private let maxSamples = 15 * 16_000

    override init() {
        super.init()
        configureVAD()
        observeInterruptions()
    }

    private func configureVAD() {
        guard let vad = VADWrapper() else { return }
        vad.delegate = self
        vad.setSileroModel(.v5)
        vad.setSamplerate(.SAMPLERATE_16)
        vad.setThresholdWithVadStartDetectionProbability(
            0.7, vadEndDetectionProbability: 0.7,
            voiceStartVadTrueRatio: 0.8, voiceEndVadFalseRatio: 0.95,
            voiceStartFrameCount: 10, voiceEndFrameCount: 10
        )
        self.vad = vad
    }

    // ── Interruptions ────────────────────────────────────────────────────────
    // A call, a Bluetooth handoff or a media-services reset stops the engine. Without
    // these the UI keeps counting while the microphone is dead, and someone finishes a
    // long question into nothing.

    private func observeInterruptions() {
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()

        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification,
                                           object: session, queue: .main) { [weak self] note in
            guard let self,
                  let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began,
                  self.state.isRecording else { return }
            // Bank what we have — a call can last minutes. Not auto-resuming afterwards
            // is deliberate: restarting the mic unannounced is worse than a second tap.
            self.stop(reason: "interrupted")
        })

        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification,
                                           object: session, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.configureVAD()                      // every audio object is invalid now
            if self.state.isRecording { self.stop(reason: "audio reset") }
        })

        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification,
                                           object: session, queue: .main) { [weak self] note in
            guard let self, self.state.isRecording,
                  let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable
            else { return }
            self.stop(reason: "input device removed")
        })
    }

    // ── Control ──────────────────────────────────────────────────────────────

    func requestPermission(_ done: @escaping (Bool) -> Void) {
        AVAudioApplication.requestRecordPermission { granted in
            DispatchQueue.main.async {
                self.state.permissionDenied = !granted
                done(granted)
            }
        }
    }

    /// `onDevice` decides which transcriber runs — never both. See Preferences.
    func start(onDevice: Bool) {
        guard !state.isRecording else { return }
        useOnDevice = onDevice
        requestPermission { [weak self] granted in
            guard let self, granted else { return }
            self.beginSession()
        }
    }

    private func beginSession() {
        state.failure = nil
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .measurement,
                                    options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
            try session.setActive(true)
        } catch {
            state.failure = "Microphone unavailable."
            return
        }

        do {
            try buildEngine()
        } catch {
            // A failed start must not leave the session held with the UI looking idle.
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            state.failure = "Could not start recording."
            return
        }

        audioQueue.sync {
            speechSamples = []
            chunkIndex = 0
            didCaptureSpeech = false
        }
        if useOnDevice { speech.start() }
        state.isRecording = true
        state.startedAt = .now
        state.speechSeconds = 0
        UIApplication.shared.isIdleTimerDisabled = true
        startHardCapTimer()
    }

    func stop() { stop(reason: nil) }

    private func stop(reason: String?) {
        guard state.isRecording else { return }
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        state.isRecording = false
        state.isSpeaking = false
        state.startedAt = nil
        speechStartedAt = nil
        UIApplication.shared.isIdleTimerDisabled = false
        stopHardCapTimer()
        if let reason { state.failure = "Recording stopped — \(reason)." }

        // Ordered behind anything the tap already queued: removing the tap does not
        // guarantee an in-flight callback has finished, and the last samples would
        // otherwise land after the final flush and be lost.
        audioQueue.async { [weak self] in
            guard let self else { return }
            if !self.speechSamples.isEmpty {
                self.flush(isFinal: true)
            } else if self.didCaptureSpeech {
                // Speech was heard and already flushed — send the end marker so the
                // question can complete. If the VAD never heard anything, send NOTHING:
                // no chunk, no question, no empty conversation.
                let index = self.chunkIndex
                self.chunkIndex += 1
                let handler = self.onChunk
                DispatchQueue.main.async { handler?(Data(), 0, index, true) }
            }
            self.speechSamples = []
        }

        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // ── Engine ───────────────────────────────────────────────────────────────

    private func buildEngine() throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0 else { throw RecorderError.noInput }

        guard let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate,
                                         channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: inputFormat, to: target)
        else { throw RecorderError.noConverter }
        self.converter = converter
        self.targetFormat = target

        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            self?.feedVAD(buffer)
        }
        engine.prepare()
        try engine.start()
        self.engine = engine
    }

    /// Runs on the audio thread. Resample and hand straight to the VAD — no queue hop,
    /// no isolation, nothing that can block a real-time callback.
    private func feedVAD(_ buffer: AVAudioPCMBuffer) {
        guard let converter, let targetFormat else { return }
        let ratio = sampleRate / buffer.format.sampleRate
        let frames = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up))
        guard frames > 0, let converted = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: frames)
        else { return }

        var error: NSError?
        converter.convert(to: converted, error: &error) { _, status in
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, converted.frameLength > 0,
              let channel = converted.floatChannelData?[0] else { return }
        vad?.processAudioData(withBuffer: channel, count: UInt(converted.frameLength))
        if useOnDevice { speech.append(buffer) }   // raw tap buffer: the analyzer picks its own format
    }

    // ── Flushing ─────────────────────────────────────────────────────────────

    private func startHardCapTimer() {
        stopHardCapTimer()
        let timer = DispatchSource.makeTimerSource(queue: audioQueue)
        timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
        timer.setEventHandler { [weak self] in
            guard let self, self.speechSamples.count >= self.maxSamples else { return }
            self.flush(isFinal: false)
        }
        timer.resume()
        hardCapTimer = timer
    }

    private func stopHardCapTimer() {
        hardCapTimer?.cancel()
        hardCapTimer = nil
    }

    /// Called on audioQueue. Encodes here, not on the main thread — 15s is 240k samples
    /// and converting those on the main queue is a visible hitch on every flush.
    private func flush(isFinal: Bool) {
        guard !speechSamples.isEmpty else { return }
        guard !useOnDevice else { speechSamples = []; return }   // nothing to upload
        let samples = speechSamples
        speechSamples = []
        let index = chunkIndex
        chunkIndex += 1
        didCaptureSpeech = true

        let wav = AudioUtils.pcmToWAV(samples: samples)
        let ms = Int(Double(samples.count) / sampleRate * 1000)
        let handler = onChunk
        DispatchQueue.main.async { handler?(wav, ms, index, isFinal) }
    }

    enum RecorderError: Error { case noInput, noConverter }
}

// ── VAD callbacks (audio thread) ─────────────────────────────────────────────

extension VoiceRecorder: VADDelegate {

    func voiceStarted() {
        DispatchQueue.main.async {
            self.state.isSpeaking = true
            self.speechStartedAt = .now
        }
    }

    func voiceEnded(withWavData _: Data!) {
        DispatchQueue.main.async {
            self.state.isSpeaking = false
            if let started = self.speechStartedAt {
                self.state.speechSeconds += Date.now.timeIntervalSince(started)
                self.speechStartedAt = nil
            }
        }
        audioQueue.async { [weak self] in
            guard let self, self.speechSamples.count >= self.minSamples else { return }
            self.flush(isFinal: false)
        }
    }

    func voiceDidContinue(withPCMFloat pcmData: Data!) {
        // No is-speaking guard: the library only calls this during speech, and gating on
        // an async flag drops samples through dispatch reordering.
        guard let pcmData, !pcmData.isEmpty else { return }
        audioQueue.async { [weak self] in
            guard let self else { return }
            self.speechSamples.append(contentsOf: pcmData.withUnsafeBytes {
                Array($0.bindMemory(to: Float.self))
            })
        }
    }
}

// ── Observable surface ───────────────────────────────────────────────────────
// The only part the UI touches. NOT @MainActor: the recorder holds it, and the recorder
// must stay isolation-free so audio callbacks never hit an executor assertion.
//
// The discipline instead of the annotation: every mutation below happens on the main
// queue (UI actions, NotificationCenter observers registered with `queue: .main`, and
// explicit DispatchQueue.main.async hops out of the audio thread), and SwiftUI only ever
// reads it on the main thread. That is what `@unchecked` is asserting here.

@Observable
final class VoiceState: @unchecked Sendable {
    var isRecording = false
    var isSpeaking = false
    var startedAt: Date?
    var speechSeconds: TimeInterval = 0
    var permissionDenied = false
    var failure: String?
}
