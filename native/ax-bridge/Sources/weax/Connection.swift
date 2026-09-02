import Foundation

/// Everything that belongs to one client rather than to the process.
///
/// The bridge began as one process per caller, which made "process-wide" and "per-caller"
/// the same statement: a `nodeId`, a background session and an observer subscription could
/// all be global because there was only ever one client to confuse. Serving a socket ends
/// that identity — two callers now share one process, and a handle minted for one of them
/// must mean nothing to the other. The failure mode is not a collision that shows up as an
/// error; it is client A's `nodeId: 7` resolving to client B's element, which is a click
/// on the wrong window that reports success.
///
/// So the registries moved off `static let shared` and into instance state owned here,
/// reached through `Connection.current`. Main-thread confined like everything else — every
/// request is dispatched to the main thread, so the swap needs no locking.
final class Connection {
    /// Per-process, for diagnostics only. The stdio connection is 0.
    let id: Int
    let output: Output
    let elements = ElementRegistry()
    let sessions = SessionRegistry()
    let observers = ObserverRegistry()
    /// `stdio` or `socket`. Reported by `env` so a caller can tell which bridge answered.
    let transport: String

    /// What tearing this client down means to its transport: stdio ends the process,
    /// a socket client closes its own descriptor and leaves the service up for the rest.
    private let closer: (Connection) -> Void
    private(set) var closed = false

    init(id: Int, transport: String, output: Output, closer: @escaping (Connection) -> Void) {
        self.id = id
        self.transport = transport
        self.output = output
        self.closer = closer
    }

    /// Releases everything this client owns: on `shutdown`, on a dropped connection, and on
    /// process exit.
    ///
    /// The order is not arbitrary. A suppression tap installed by one of this client's
    /// sessions, left running after the client is gone, would leave somebody else's
    /// application filtered with nothing remaining that could un-filter it — so sessions go
    /// first, then observers, and only then does the transport get to close the descriptor.
    func close() {
        guard !closed else { return }
        closed = true
        sessions.releaseAll()
        observers.teardownAll()
        closer(self)
    }

    // MARK: - The connection a request belongs to

    /// The client whose request is being handled right now.
    ///
    /// Defaults to a connection bound to stdout that closes nothing, which is exactly right
    /// for the stdio path before `main` has replaced it, and deliberately harmless in serve
    /// mode: a registry reached outside any request writes into the launchd log and mints
    /// handles nobody reads, rather than crashing a resident service or — worse — answering
    /// into whichever client happens to be connected.
    static var current = Connection(id: 0, transport: "stdio", output: .standardOutput, closer: { _ in })

    /// Runs `body` with `connection` as the current one, restoring what it replaced rather
    /// than resetting to the default, so a nested call cannot strand the outer one.
    static func with<T>(_ connection: Connection, _ body: () throws -> T) rethrows -> T {
        let previous = current
        current = connection
        defer { current = previous }
        return try body()
    }
}

// MARK: - Reaching the current client's state
//
// These read like the singletons they replaced on purpose: the call sites all mean "the
// registry of whoever is asking", and that was already what they meant when there could
// only be one asker. What changed is that the answer is now a property of the connection
// rather than of the process.

extension Output {
    static var current: Output { Connection.current.output }
}

extension ElementRegistry {
    static var current: ElementRegistry { Connection.current.elements }
}

extension SessionRegistry {
    static var current: SessionRegistry { Connection.current.sessions }
}

extension ObserverRegistry {
    static var current: ObserverRegistry { Connection.current.observers }
}
