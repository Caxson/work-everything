import Foundation

/// One NDJSON line in, one dispatched request out. The half of the transport that both
/// transports share.
///
/// Kept apart from the transports on purpose: stdio and the socket differ only in where the
/// bytes come from and where the answers go, and every difference beyond that is a place
/// where the two could answer the same request differently. The protocol document describes
/// one protocol, so there is one parser and one dispatch.
enum RequestPump {
    /// Parses and runs one line, already known to belong to `Connection.current`.
    ///
    /// A line that cannot be parsed is answered with `id: -1` and never terminates the
    /// connection — the client may well be able to send a good one next.
    static func process(line: Data) {
        let trimmed = line.drop { $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }
        guard !trimmed.isEmpty else { return }
        let request: Request
        do {
            request = try Request.parse(line: Data(trimmed))
        } catch let error as BridgeError {
            Output.current.failure(id: -1, error: error)
            return
        } catch {
            return
        }
        Dispatcher.handle(request)
    }
}
