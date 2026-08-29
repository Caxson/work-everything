import Foundation

/// Serializes every byte that leaves the bridge. Responses (from the reader thread)
/// and AX observer events (from the main run loop) share one lock and one fd.
final class Output {
    static let shared = Output()

    private let lock = NSLock()
    private let handle = FileHandle.standardOutput
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }()

    private init() {}

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
        var payload = data
        if payload.last != 0x0A { payload.append(0x0A) }
        payload.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
            var offset = 0
            while offset < buf.count {
                let written = write(handle.fileDescriptor, buf.baseAddress!.advanced(by: offset), buf.count - offset)
                if written <= 0 { break }
                offset += written
            }
        }
    }

    func success(id: Int, result: JSONValue) {
        emit(.object(["id": .int(id), "ok": .bool(true), "result": result]))
    }

    func failure(id: Int, error: BridgeError) {
        emit(.object([
            "id": .int(id),
            "ok": .bool(false),
            "error": .object(["code": .string(error.code), "message": .string(error.message)])
        ]))
    }

    /// Diagnostics never pollute stdout; the NDJSON stream must stay parseable.
    func log(_ message: String) {
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }
}
