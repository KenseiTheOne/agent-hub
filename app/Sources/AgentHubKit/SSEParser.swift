import Foundation

/// A single SSE event (`text/event-stream`).
public struct SSEEvent: Sendable, Hashable {
    public var id: String?
    public var event: String
    public var data: String

    public init(id: String?, event: String, data: String) {
        self.id = id; self.event = event; self.data = data
    }

    /// Stream liveness signal: a comment arrived (`: ping`, every 15 s). The SSE parser never emits such an event
    /// (an event without `event:` has type `message`); `HubClient.events` injects it.
    public static let keepalive = SSEEvent(id: nil, event: "", data: "")
    public var isKeepalive: Bool { event.isEmpty }
}

/// Streaming SSE parser per the WHATWG spec: `field: value` lines, an empty line ends an event,
/// a leading `:` is a comment (the daemon sends `: ping` every 15 s). Bytes arrive in chunks of arbitrary length,
/// including in the middle of a multibyte UTF-8 character, so the buffer is byte-based.
public struct SSEParser: Sendable {
    private var buffer: [UInt8] = []
    private var dataLines: [String] = []
    private var eventType: String = ""
    private var eventId: String?
    private var sawField = false
    /// The last received `id:`; sent as `Last-Event-ID` on reconnect.
    public private(set) var lastEventId: String?
    /// How many comments (`: ping`) have arrived, for the liveness indicator.
    public private(set) var comments = 0

    /// Line limit: the daemon sends a snapshot as a single `data:` line; anything over 16 MB is garbage.
    public static let maxLine = 16 * 1024 * 1024

    public init() {}

    public mutating func push(_ bytes: some Sequence<UInt8>) -> [SSEEvent] {
        buffer.append(contentsOf: bytes)
        var out: [SSEEvent] = []
        var start = 0
        var i = 0
        while i < buffer.count {
            let b = buffer[i]
            if b == 0x0A || b == 0x0D {
                let line = String(decoding: buffer[start..<i], as: UTF8.self)
                // CRLF counts as a single line break
                if b == 0x0D, i + 1 < buffer.count, buffer[i + 1] == 0x0A { i += 1 }
                if let ev = handle(line: line) { out.append(ev) }
                start = i + 1
            }
            i += 1
        }
        if start > 0 { buffer.removeFirst(start) }
        if buffer.count > Self.maxLine { buffer.removeAll(keepingCapacity: false) }
        return out
    }

    private mutating func handle(line: String) -> SSEEvent? {
        if line.isEmpty {
            defer { dataLines = []; eventType = ""; eventId = nil; sawField = false }
            guard sawField, !dataLines.isEmpty else { return nil }
            if let eventId { lastEventId = eventId }
            return SSEEvent(id: eventId, event: eventType.isEmpty ? "message" : eventType, data: dataLines.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { comments += 1; return nil }
        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            value = line[line.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(line)
            value = ""
        }
        sawField = true
        switch field {
        case "data": dataLines.append(String(value))
        case "event": eventType = String(value)
        case "id": if !value.contains("\0") { eventId = String(value) }
        default: break // retry and unknown fields are not needed
        }
        return nil
    }
}
