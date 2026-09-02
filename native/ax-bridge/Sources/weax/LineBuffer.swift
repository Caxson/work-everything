import Foundation

/// Reassembles newline-delimited messages from arbitrary chunk boundaries.
///
/// A pipe and a socket both split wherever they like, and a half-received JSON object must
/// not be parsed as a malformed one. Shared by both transports so the framing cannot drift
/// between them — an NDJSON protocol implemented twice is an NDJSON protocol with two
/// slightly different ideas of where a message ends.
struct LineBuffer {
    /// How much unterminated input to hold before giving up on a client.
    ///
    /// Without a ceiling, a peer that never sends a newline is an unbounded allocation in a
    /// process that is supposed to stay resident for weeks. The limit is far above any real
    /// request: the largest thing this protocol carries is a `setValue` payload.
    static let defaultLimit = 8 << 20

    private var pending = Data()
    private let limit: Int
    /// Set when `limit` was passed. The caller is expected to drop the connection: the
    /// buffer cannot recover, because it has no way to find the start of the next message.
    private(set) var overflowed = false

    init(limit: Int = LineBuffer.defaultLimit) {
        self.limit = limit
    }

    /// Appends a chunk and returns every complete line it finished.
    mutating func append(_ chunk: Data) -> [Data] {
        guard !overflowed else { return [] }
        pending.append(chunk)
        var lines: [Data] = []
        while let newline = pending.firstIndex(of: 0x0A) {
            lines.append(pending.subdata(in: pending.startIndex..<newline))
            pending = pending.subdata(in: pending.index(after: newline)..<pending.endIndex)
        }
        if pending.count > limit {
            overflowed = true
            pending = Data()
        }
        return lines
    }

    /// Whatever is left when the peer closes: a final message with no trailing newline.
    mutating func drain() -> Data? {
        defer { pending = Data() }
        return pending.isEmpty ? nil : pending
    }
}
