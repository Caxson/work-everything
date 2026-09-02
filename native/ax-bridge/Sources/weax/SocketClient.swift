import Darwin
import Foundation

/// One connected socket client: its descriptor, its framing, and the `Connection` that owns
/// its handles, sessions and subscriptions.
///
/// Everything here runs on the main queue. The read source is attached to it directly
/// rather than to a reader thread, because the main queue is drained by the same
/// `CFRunLoop` the accessibility observers fire on — so a request is already on the thread
/// every AX call has to be made from, and there is no hand-off to get wrong. (stdio cannot
/// do this: its reads are blocking, which is why that path keeps a thread and a
/// `DispatchQueue.main.sync`.)
final class SocketClient {
    private static let readChunk = 64 << 10

    private let fd: Int32
    private let sink: Output
    private var buffer = LineBuffer()
    private var source: DispatchSourceRead?
    private var finished = false
    private let onFinish: (SocketClient) -> Void
    /// Assigned in `init` once `sink` exists, because its closer captures `self`.
    private(set) var connection: Connection!

    init(fd: Int32, id: Int, onFinish: @escaping (SocketClient) -> Void) {
        self.fd = fd
        self.onFinish = onFinish
        let sink = Output(fileDescriptor: fd)
        self.sink = sink
        connection = Connection(id: id, transport: "socket", output: sink) { [weak self] _ in
            self?.finish()
        }
    }

    func resume() {
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
        source.setEventHandler { [weak self] in self?.readAvailable() }
        // The descriptor is closed here and nowhere else. Cancellation is asynchronous, so
        // closing it in `finish` would race the source's own last read against a number the
        // kernel is already free to hand to the next client.
        source.setCancelHandler { [fd] in close(fd) }
        source.resume()
        self.source = source
    }

    /// Releases the client's accessibility state, stops the channel, and closes the socket.
    /// Idempotent: it is reached from a dropped peer, from a read error, from `shutdown`,
    /// and from the server tearing everything down.
    func finish() {
        guard !finished else { return }
        finished = true
        // Stops any further write into this descriptor before the number can be recycled.
        sink.invalidate()
        connection.close()
        source?.cancel()
        source = nil
        onFinish(self)
    }

    // MARK: - Reading

    private func readAvailable() {
        guard !finished else { return }
        var chunk = [UInt8](repeating: 0, count: SocketClient.readChunk)
        let count = read(fd, &chunk, SocketClient.readChunk)
        if count > 0 {
            deliver(Data(chunk[0..<count]))
            return
        }
        if count < 0 && (errno == EAGAIN || errno == EINTR) { return }
        // 0 is an orderly close by the peer; anything else is a broken channel. Both mean
        // this client is gone and its sessions have to be released either way.
        if let last = buffer.drain() { dispatch(last) }
        finish()
    }

    private func deliver(_ chunk: Data) {
        for line in buffer.append(chunk) { dispatch(line) }
        guard buffer.overflowed else { return }
        sink.failure(id: -1, error: BridgeError(
            code: "BAD_REQUEST",
            message: "a request exceeded \(LineBuffer.defaultLimit) bytes without a newline; "
                + "the framing is lost, so the connection is being closed"))
        finish()
    }

    private func dispatch(_ line: Data) {
        Connection.with(connection) { RequestPump.process(line: line) }
    }
}
