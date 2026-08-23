import Foundation

// 16 kHz mono Float32 PCM → a WAV file the transcription endpoint accepts.
enum AudioUtils {

    static func pcmToWAV(samples: [Float], sampleRate: Int = 16_000) -> Data {
        var data = Data(capacity: 44 + samples.count * 2)

        let channels = UInt16(1)
        let bitsPerSample = UInt16(16)
        let blockAlign = channels * (bitsPerSample / 8)
        let byteRate = UInt32(sampleRate) * UInt32(blockAlign)
        let dataSize = UInt32(samples.count * 2)

        func append<T: FixedWidthInteger>(_ value: T) {
            var little = value.littleEndian
            withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
        }
        func append(_ text: String) { data.append(contentsOf: Array(text.utf8)) }

        append("RIFF");  append(UInt32(36) + dataSize)
        append("WAVE")
        append("fmt ");  append(UInt32(16))
        append(UInt16(1))                       // PCM
        append(channels)
        append(UInt32(sampleRate))
        append(byteRate)
        append(blockAlign)
        append(bitsPerSample)
        append("data");  append(dataSize)

        for sample in samples {
            // Clamp before converting: a value outside [-1, 1] wraps and becomes a loud
            // click rather than clipping quietly.
            let clamped = max(-1.0, min(1.0, sample))
            append(Int16(clamped * 32_767))
        }
        return data
    }
}
