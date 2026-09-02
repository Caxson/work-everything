import Foundation

/// Serializes every byte that leaves the bridge on one channel. Responses (from the reader
/// thread, or from the main queue on a socket) and AX observer events (from the main run
/// loop) share one lock and one descriptor.
///
/// One instance per client, not per process: a socket server writes each client's replies
/// into that client's own descriptor, and an observer event belongs to whoever subscribed.
final class Output {
    /// The stdio channel. Also where the serve-mode process writes diagnostics, which
    /// launchd captures into `~/Library/Logs/work-everything`.
    static let standardOutput = Output(fileDescriptor: FileHandle.standardOutput.fileDescriptor)

    private let lock = NSLock()
    private let fd: Int32
    private var live = true
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }()

    init(fileDescriptor: Int32) {
        fd = fileDescriptor
    }

    /// Stops this sink before its descriptor is closed.
    ///
    /// Not cosmetic: descriptor numbers are reused the moment they are freed, so a
    /// subscription that outlived its client and kept writing would deliver one client's
    /// events into the next client's socket. Dropping the writes is the only safe answer
    /// once the channel is gone.
    func invalidate() {
        lock.lock()
        defer { lock.unlock() }
        live = false
    }

    func emit(_ value: JSONValue) {
        guard var data = try? encoder.encode(value) else {
            emitRaw(Data(#"{"ok":false,"error":{"code":"ENCODE_ERROR","message":"failed to encode response"}}"#.utf8))
            return
        }
        data.append(0x0A)
        emitRaw(data)
    }

    /// `data` must already contain its trailing newline when coming from `emit`.
    private func emitRaw(_ data: Data) {
        lock.lock()
        defer { lock.unlock() }
        guard live else { return }
        var payload = data
        if payload.last != 0x0A { payload.append(0x0A) }
        payload.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
            var offset = 0
            while offset < buf.count {
                let written = write(fd, buf.baseAddress!.advanced(by: offset), buf.count - offset)
                if written <= 0 {
                    // A peer that stopped reading, or a descriptor already gone. Either way
                    // this channel is finished; further writes would block the run loop.
                    if written < 0 && errno == EINTR { continue }
                    live = false
                    break
                }
                offset += written
            }
        }
    }

    func success(id: Int, result: JSONValue) {
        emit(.object(["id": .int(id), "ok": .bool(true), "result": result]))
    }

    func failure(id: Int, error: BridgeError) {
        var payload: [String: JSONValue] = ["code": .string(error.code), "message": .string(error.message)]
        if let details = error.details { payload["details"] = details }
        emit(.object(["id": .int(id), "ok": .bool(false), "error": .object(payload)]))
    }

    /// Diagnostics never pollute a client's channel; the NDJSON stream must stay parseable.
    func log(_ message: String) {
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }
}
