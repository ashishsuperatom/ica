// ── The transport: whole messages in, whole messages out ─────────────────────────────────────────────────────
//
// The Swift twin of clients/transport.ts, kept line-for-line in spirit: everything above it — HubClient's
// handlers, the store, the views — sends and receives WHOLE messages. What the wire does to carry them is this
// file's business and nobody else's: a message too large for one frame goes beside the wire as a PARCEL (a body
// in the object store, named by its hash, fetched with a signed ticket), and when no store is at hand it goes as
// PARTS (numbered slices joined at the other end). Both directions.
//
//   let out = Transport.Sender(send: { frame in … }, parcels: store)     out.send(message)
//   let inn = Transport.Receiver(deliver: { whole in … }, parcels: store) inn.receive(frame)
//
// Order at the send point: measure · under the limit → whole · over → parcel (summary + pointer, whole) · a
// parcel that cannot be made → parts. The receiver joins parts and resolves parcels, then delivers the whole
// message; it never delivers a `part` or a message still carrying a `parcel` pointer.
//
// Pure: no sockets and no networking of its own — the store and the socket are given in.

import Foundation

enum Transport {
    typealias Message = [String: Any]

    struct Parcel: Equatable {
        let hash: String
        let bytes: Int
        let ticket: String
        let expires: Double?

        init?(_ any: Any?) {
            guard let d = any as? [String: Any], let hash = d["hash"] as? String, let ticket = d["ticket"] as? String else { return nil }
            self.hash = hash
            self.bytes = (d["bytes"] as? Int) ?? 0
            self.ticket = ticket
            self.expires = d["expires"] as? Double
        }
        var json: [String: Any] {
            var d: [String: Any] = ["hash": hash, "bytes": bytes, "ticket": ticket]
            if let expires { d["expires"] = expires }
            return d
        }
    }

    /// Where a body goes when it does not fit the wire. `put` is the sender's side, `get` the receiver's.
    struct ParcelStore {
        var put: ((_ body: Data) async throws -> Parcel)?
        var get: ((_ parcel: Parcel) async throws -> Data)?
    }

    /// What may travel through the hub in one frame: lower than the hub's 1 MiB ceiling by choice, so the
    /// Durable Object carries messages and never bulk. The same number as clients/transport.ts.
    static let frameLimit = 128_000
    static let partBytes = 480_000

    /// Which fields of a large message still travel when its body goes as a parcel: the routing and the summary.
    static let summaryKeys = ["t", "reqId", "id", "to", "from", "focus", "label", "title", "words", "said", "today", "ms", "used", "notes"]

    static func isPart(_ m: Message) -> Bool {
        (m["t"] as? String) == "part" && m["id"] is String && m["part"] is Int && m["of"] is Int && m["data"] is String
    }
    static func isParcelled(_ m: Message) -> Bool { Parcel(m["parcel"]) != nil }

    static func encode(_ m: Message) -> Data? { try? JSONSerialization.data(withJSONObject: m) }
    static func decode(_ d: Data) -> Message? { (try? JSONSerialization.jsonObject(with: d)) as? Message }

    private static func idOf(_ m: Message) -> String {
        if let r = m["reqId"] as? String { return r }
        if let i = m["id"] as? String { return i }
        return UUID().uuidString
    }

    // ── Sending ──────────────────────────────────────────────────────────────

    enum Sent { case whole, parcel, parts }

    final class Sender {
        private let send: (Message) -> Void
        private let parcels: ParcelStore?
        private let limit: Int
        private let partBytes: Int
        /// Told when a parcel could not be made and parts were used instead — for a log line, never for behaviour.
        var onFallback: ((String) -> Void)?

        init(send: @escaping (Message) -> Void, parcels: ParcelStore? = nil, limit: Int = Transport.frameLimit, partBytes: Int = Transport.partBytes) {
            self.send = send; self.parcels = parcels; self.limit = limit; self.partBytes = partBytes
        }

        @discardableResult
        func send(_ message: Message) async -> Sent {
            guard let data = Transport.encode(message) else { return .whole }
            if data.count <= limit { send(message); return .whole }
            let id = Transport.idOf(message)
            if let put = parcels?.put {
                do {
                    let parcel = try await put(data)
                    var pointer: Message = [:]
                    for k in Transport.summaryKeys { if let v = message[k] { pointer[k] = v } }
                    pointer["t"] = message["t"] ?? ""
                    pointer["id"] = id
                    pointer["parcel"] = parcel.json
                    if let p = Transport.encode(pointer), p.count <= limit { send(pointer); return .parcel }
                    onFallback?("the summary itself is over the limit")
                } catch {
                    onFallback?(error.localizedDescription)
                }
            }
            sendParts(data, id: id)
            return .parts
        }

        private func sendParts(_ data: Data, id: String) {
            // Slice the UTF-8 text on character boundaries so every part is itself valid text.
            let text = String(decoding: data, as: UTF8.self)
            var slices: [String] = []
            var current = ""; var currentBytes = 0
            for ch in text {
                let n = ch.utf8.count
                if currentBytes + n > partBytes, !current.isEmpty { slices.append(current); current = ""; currentBytes = 0 }
                current.append(ch); currentBytes += n
            }
            if !current.isEmpty || slices.isEmpty { slices.append(current) }
            for (i, s) in slices.enumerated() {
                send(["t": "part", "id": id, "part": i, "of": slices.count, "data": s])
            }
        }
    }

    // ── Receiving ────────────────────────────────────────────────────────────

    final class Receiver {
        private let deliver: (Message) -> Void
        private let parcels: ParcelStore?
        private var held: [String: (of: Int, parts: [Int: String])] = [:]
        /// Told when a parcel could not be fetched; the pointer is then delivered as it is, with `parcelError` set.
        var onError: ((String, Message) -> Void)?

        init(deliver: @escaping (Message) -> Void, parcels: ParcelStore? = nil) {
            self.deliver = deliver; self.parcels = parcels
        }

        /// Feed every frame here. Whole messages are delivered at once; parts are held until the last arrives.
        func receive(_ frame: Message) async {
            guard Transport.isPart(frame) else { await whole(frame); return }
            let id = frame["id"] as! String, part = frame["part"] as! Int, of = frame["of"] as! Int, data = frame["data"] as! String
            var h = held[id] ?? (of: of, parts: [:])
            h.parts[part] = data
            held[id] = h
            guard h.parts.count >= h.of else { return }
            held[id] = nil
            let text = (0..<h.of).map { h.parts[$0] ?? "" }.joined()
            guard let msg = Transport.decode(Data(text.utf8)) else { return }
            await whole(msg)
        }

        private func whole(_ message: Message) async {
            if let parcel = Transport.Parcel(message["parcel"]), let get = parcels?.get {
                do {
                    let body = try await get(parcel)
                    guard var whole = Transport.decode(body) else { throw NSError(domain: "transport", code: 1, userInfo: [NSLocalizedDescriptionKey: "the parcel is not a message"]) }
                    if let reqId = message["reqId"] { whole["reqId"] = reqId }
                    deliver(whole)
                } catch {
                    onError?(error.localizedDescription, message)
                    var marked = message; marked["parcelError"] = error.localizedDescription
                    deliver(marked)
                }
                return
            }
            deliver(message)
        }

        /// How many messages are still arriving, for a status line.
        var pending: Int { held.count }
        /// Forget everything half-arrived — when the socket that was sending it is gone.
        func reset() { held.removeAll() }
    }

    // ── The store behind the worker's parcel route ───────────────────────────

    /// Parcels fetched from the platform: `GET <api>/api/projects/<project>/parcels/<hash>?ticket=…`. The route is
    /// the worker's; the ticket in the message is the whole credential. Upload is the engine's job, not a client's.
    static func store(api: URL, projectId: String) -> ParcelStore {
        ParcelStore(put: nil, get: { parcel in
            var c = URLComponents(url: api.appendingPathComponent("api/projects/\(projectId)/parcels/\(parcel.hash)"), resolvingAgainstBaseURL: false)!
            c.queryItems = [URLQueryItem(name: "ticket", value: parcel.ticket)]
            let (data, response) = try await URLSession.shared.data(from: c.url!)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw NSError(domain: "transport", code: 2, userInfo: [NSLocalizedDescriptionKey: "the parcel could not be fetched (\((response as? HTTPURLResponse)?.statusCode ?? 0))"])
            }
            return data
        })
    }
}
