import Foundation

/// Where a resident bridge keeps its socket, and what launchd calls it.
///
/// One place, because four things have to agree on these strings and they are written in
/// four languages: this binary's `--serve` default, the plist `scripts/install-service.sh`
/// writes, `launchctl`'s job label, and the TypeScript client's `axBridge.socketPath`. A
/// path spelled differently in any one of them produces a client that connects to nothing
/// and a service nobody reaches — and both halves of that look like a bug in the other.
///
/// `--socket-path` prints `defaultSocketPath` so the install script can ask the binary
/// rather than reimplement this, which is the only way the two can be wrong together
/// instead of separately.
enum ServiceLayout {
    /// The launchd job label. Also the plist's file name.
    static let label = "com.work-everything.ax-bridge"

    static let socketFileName = "we-ax.sock"

    /// `~/Library/Application Support/work-everything`. Created 0700 by the server: the
    /// socket is a control channel into the accessibility grant, and nothing outside this
    /// user's session has any business reaching it.
    static var supportDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Application Support", isDirectory: true)
            .appendingPathComponent("work-everything", isDirectory: true)
    }

    static var defaultSocketPath: String {
        supportDirectory.appendingPathComponent(socketFileName, isDirectory: false).path
    }

    /// Where the install script points launchd's stdout and stderr.
    static var logDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Logs", isDirectory: true)
            .appendingPathComponent("work-everything", isDirectory: true)
    }
}
