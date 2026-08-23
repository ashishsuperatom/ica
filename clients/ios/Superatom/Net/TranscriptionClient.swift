import Foundation
import UIKit

// POST one audio chunk to /api/transcribe and get its text back.
// Bulk binary over HTTP, deliberately not the hub WebSocket: each chunk is independent
// and must be retryable on its own without disturbing a live socket.

struct TranscriptionClient {
    /// Read on the main actor at call time rather than snapshotted, so re-pointing the
    /// app at a different project or pasting a fresh token takes effect immediately —
    /// including for chunks already queued in the outbox.
    let connection: Connection

    struct Result: Decodable {
        let text: String
        let chunkIndex: Int
        let model: String?
    }

    struct Failure: Error {
        let message: String
        /// Whether sending this exact chunk again could succeed. A client that retries a
        /// 400 forever is the failure this flag exists to prevent.
        let retryable: Bool
    }

    func transcribe(wav: Data, chunkIndex: Int, questionId: String, sessionId: String,
                    durationMs: Int, isFinal: Bool) async throws -> Result {
        let config = await MainActor.run { (url: connection.transcribeURL, token: connection.token) }
        guard let url = config.url, !config.token.isEmpty else {
            throw Failure(message: "Not configured", retryable: false)
        }

        let boundary = "sa-\(UUID().uuidString)"
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 60
        request.httpBody = multipart(boundary: boundary, wav: wav, fields: [
            "chunkIndex": String(chunkIndex),
            "questionId": questionId,
            "sessionId": sessionId,
            "durationMs": String(durationMs),
            "isFinal": isFinal ? "true" : "false",
        ])

        // Keep the upload alive if the user locks the screen right after speaking.
        let task = await UIApplication.shared.beginBackgroundTask(withName: "sa-transcribe")
        defer { if task != .invalid { Task { @MainActor in UIApplication.shared.endBackgroundTask(task) } } }

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw Failure(message: error.localizedDescription, retryable: true)   // network: try again
        }

        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(code) else {
            let problem = try? JSONDecoder().decode(Problem.self, from: data)
            throw Failure(message: problem?.error ?? "Transcription failed (\(code))",
                          retryable: problem?.retryable ?? (code >= 500))
        }
        guard let result = try? JSONDecoder().decode(Result.self, from: data) else {
            throw Failure(message: "Unreadable transcription response", retryable: false)
        }
        return result
    }

    private struct Problem: Decodable { let error: String; let retryable: Bool? }

    private func multipart(boundary: String, wav: Data, fields: [String: String]) -> Data {
        var body = Data()
        func append(_ text: String) { body.append(contentsOf: Array(text.utf8)) }
        for (name, value) in fields {
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n")
        }
        if !wav.isEmpty {
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"chunk.wav\"\r\n")
            append("Content-Type: audio/wav\r\n\r\n")
            body.append(wav)
            append("\r\n")
        }
        append("--\(boundary)--\r\n")
        return body
    }
}
