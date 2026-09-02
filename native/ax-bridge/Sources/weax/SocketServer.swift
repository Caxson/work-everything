import Darwin
import Foundation

/// Filling in a `sockaddr_un` without guessing at its size.
enum UnixSocketAddress {
    /// `sun_path` is a fixed 104-byte array on Darwin, and a path that does not fit is not
    /// truncated by the kernel — `bind` simply fails with a message that names neither the
    /// path nor the limit.
    static var pathCapacity: Int { MemoryLayout.size(ofValue: sockaddr_un().sun_path) }

    static func make(path: String) throws -> sockaddr_un {
        let bytes = Array(path.utf8)
        guard bytes.count < pathCapacity else {
            throw BridgeError(
                code: "SOCKET_PATH_TOO_LONG",
                message: "socket path is \(bytes.count) bytes and a unix socket allows \(pathCapacity - 1); "
                    + "pass a shorter --serve path",
                details: .object(["path": .string(path), "limit": .int(pathCapacity - 1)]))
        }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutablePointer(to: &addr.sun_path) { raw in
            raw.withMemoryRebound(to: CChar.self, capacity: pathCapacity) { dst in
                for (index, byte) in bytes.enumerated() { dst[index] = CChar(bitPattern: byte) }
                dst[bytes.count] = 0
            }
        }
        return addr
    }

    static func withSockaddr<T>(_ addr: inout sockaddr_un, _ body: (UnsafePointer<sockaddr>, socklen_t) -> T) -> T {
        let length = socklen_t(MemoryLayout<sockaddr_un>.size)
        return withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { body($0, length) }
        }
    }
}

/// The bridge as a resident service: one AF_UNIX listener, many clients, and per connection
/// exactly the NDJSON protocol stdio speaks.
///
/// Why this mode exists. macOS attributes an Accessibility grant to the **responsible
/// process**, which for a spawned helper is whatever launched it — not the helper. So the
/// same `we-ax` binary answers `trusted: true` when a terminal spawns it and
/// `trusted: false` when something else does, and granting the binary in System Settings
/// changes neither: the grant being consulted was never its own. Run as a launchd agent the
/// binary is responsible for itself. It is granted once, by hand, and every client that
/// connects here borrows that grant without needing one of its own.
///
/// Nothing about the grant is created here; TCC cannot be given programmatically. What this
/// removes is the dependency on *who called*.
final class SocketServer {
    /// A client that stops reading must not wedge the run loop inside `write`. Five seconds
    /// is far longer than any real reply takes and far shorter than "forever".
    private static let sendTimeoutSeconds = 5
    private static let backlog: Int32 = 16

    private let path: String
    private var listenFd: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    private var nextConnectionId = 1
    private var clients: [ObjectIdentifier: SocketClient] = [:]

    init(path: String) {
        self.path = path
    }

    var socketPath: String { path }
    var clientCount: Int { clients.count }

    // MARK: - Lifecycle

    func start() throws {
        try prepareDirectory()
        try clearStaleSocket()
        listenFd = try bindAndListen()
        let source = DispatchSource.makeReadSource(fileDescriptor: listenFd, queue: .main)
        source.setEventHandler { [weak self] in self?.acceptPending() }
        source.setCancelHandler { [listenFd] in close(listenFd) }
        source.resume()
        acceptSource = source
    }

    /// Drops every client and removes the socket file, so a restart is not met by its own
    /// leftovers. Called on SIGTERM, which is how launchd stops a job.
    func stop() {
        // Snapshotted: `finish` calls back into `forget`, and mutating the dictionary while
        // iterating its own values is not a thing Swift lets you get away with.
        for client in Array(clients.values) { client.finish() }
        clients.removeAll()
        acceptSource?.cancel()
        acceptSource = nil
        unlink(path)
    }

    // MARK: - Binding

    private func prepareDirectory() throws {
        let directory = (path as NSString).deletingLastPathComponent
        do {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
        } catch {
            throw BridgeError(code: "SOCKET_DIR_FAILED",
                              message: "could not create \(directory): \(error.localizedDescription)")
        }
    }

    /// Removes a socket file left behind by a process that died, and refuses to touch one
    /// that is still being served.
    ///
    /// The test is a connection attempt, not the file's existence: a socket file outlives
    /// the process that bound it, so "the file is there" says nothing about whether anybody
    /// is listening. Unlinking on existence alone would let a second instance silently
    /// steal the address from a healthy first one, and every client already connected to it
    /// would keep working while every new one reached the wrong bridge.
    private func clearStaleSocket() throws {
        guard FileManager.default.fileExists(atPath: path) else { return }
        var addr = try UnixSocketAddress.make(path: path)
        let probe = socket(AF_UNIX, SOCK_STREAM, 0)
        guard probe >= 0 else { throw BridgeError(code: "SOCKET_FAILED", message: "socket(2) failed: \(errnoText())") }
        let connected = UnixSocketAddress.withSockaddr(&addr) { pointer, length in
            connect(probe, pointer, length)
        }
        close(probe)
        guard connected != 0 else {
            throw BridgeError(
                code: "SOCKET_IN_USE",
                message: "another we-ax is already serving \(path); stop it first "
                    + "(launchctl bootout gui/$UID/\(ServiceLayout.label))",
                details: .object(["path": .string(path)]))
        }
        unlink(path)
    }

    private func bindAndListen() throws -> Int32 {
        var addr = try UnixSocketAddress.make(path: path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw BridgeError(code: "SOCKET_FAILED", message: "socket(2) failed: \(errnoText())") }
        let bound = UnixSocketAddress.withSockaddr(&addr) { pointer, length in bind(fd, pointer, length) }
        guard bound == 0 else {
            close(fd)
            throw BridgeError(code: "SOCKET_BIND_FAILED",
                              message: "could not bind \(path): \(errnoText())",
                              details: .object(["path": .string(path)]))
        }
        // The socket is a control channel into this user's accessibility grant. Nothing
        // outside their own session has any business opening it.
        chmod(path, 0o600)
        // Non-blocking, so `acceptPending` can drain the backlog in one turn without the
        // last `accept` sitting there waiting for a connection that has not arrived. Two
        // clients connecting between two source fires would otherwise leave the second
        // waiting until a third turned up.
        let flags = fcntl(fd, F_GETFL, 0)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
        guard listen(fd, SocketServer.backlog) == 0 else {
            close(fd)
            unlink(path)
            throw BridgeError(code: "SOCKET_LISTEN_FAILED", message: "could not listen on \(path): \(errnoText())")
        }
        return fd
    }

    // MARK: - Clients

    private func acceptPending() {
        while true {
            let fd = accept(listenFd, nil, nil)
            guard fd >= 0 else { return }
            adopt(fd)
        }
    }

    private func adopt(_ fd: Int32) {
        configure(fd)
        let id = nextConnectionId
        nextConnectionId += 1
        let client = SocketClient(fd: fd, id: id) { [weak self] finished in self?.forget(finished) }
        clients[ObjectIdentifier(client)] = client
        client.resume()
    }

    private func configure(_ fd: Int32) {
        // On BSD — and therefore here — an accepted socket inherits the listener's file
        // status flags, so it arrives non-blocking because the listener has to be. Measured:
        // left that way, a reply larger than the socket buffer gets a partial `write` and
        // then EAGAIN, which this bridge reads as a dead channel; the client that asked for
        // `apps` never heard back and never heard anything again. Writes here are bounded by
        // SO_SNDTIMEO instead, which is the thing that was actually wanted.
        let flags = fcntl(fd, F_GETFL, 0)
        _ = fcntl(fd, F_SETFL, flags & ~O_NONBLOCK)
        var on: Int32 = 1
        // Without this, a client that disappears mid-reply kills the whole service with
        // SIGPIPE — every other client's sessions and taps along with it.
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        var timeout = timeval(tv_sec: SocketServer.sendTimeoutSeconds, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    }

    private func forget(_ client: SocketClient) {
        clients.removeValue(forKey: ObjectIdentifier(client))
    }

    private func errnoText() -> String {
        String(cString: strerror(errno)) + " (\(errno))"
    }
}
