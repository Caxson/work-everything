import ApplicationServices
import Darwin
import Foundation

/// How this process was asked to run.
enum Launch {
    case stdio
    case serve(path: String)
    case printSocketPath
    case usage(String, status: Int32)

    static func parse(_ arguments: [String]) -> Launch {
        var rest = arguments.dropFirst()
        guard let first = rest.popFirst() else { return .stdio }
        switch first {
        case "--serve":
            let path = rest.first ?? ServiceLayout.defaultSocketPath
            return .serve(path: path)
        case "--socket-path":
            return .printSocketPath
        case "--help", "-h":
            return .usage(help, status: 0)
        default:
            return .usage("unknown argument '\(first)'\n\n" + help, status: 2)
        }
    }

    static let help = """
        we-ax — macOS Accessibility bridge, NDJSON in and out.

          we-ax                   read requests on stdin, answer on stdout (one client)
          we-ax --serve [path]    listen on a unix socket, many clients, stay resident
                                  default: \(ServiceLayout.defaultSocketPath)
          we-ax --socket-path     print that default and exit
          we-ax --help            this

        Serve mode exists so the Accessibility grant belongs to this binary rather than to
        whoever spawned it. Install it as a launchd agent with scripts/install-service.sh,
        then grant it once in System Settings > Privacy & Security > Accessibility.
        """
}

/// The two transports.
///
/// Threading contract, stdio:
///   * main thread   — CFRunLoop, so AXObserver sources can fire; every op executes here
///   * reader thread — blocking stdin reads, hands each line to the main thread
/// Threading contract, serve:
///   * main thread   — CFRunLoop; accept and per-client reads are main-queue sources, so
///                     requests already arrive on the thread AX has to be called from
enum Bridge {
    static func main() {
        switch Launch.parse(CommandLine.arguments) {
        case .stdio:
            runStdio()
        case .serve(let path):
            runServer(path: path)
        case .printSocketPath:
            print(ServiceLayout.defaultSocketPath)
        case .usage(let text, let status):
            FileHandle.standardError.write(Data((text + "\n").utf8))
            exit(status)
        }
    }

    // MARK: - stdio

    private static func runStdio() {
        Connection.current = Connection(id: 0, transport: "stdio", output: .standardOutput) { _ in exit(0) }
        let reader = Thread { readLoop() }
        reader.name = "we-ax.stdin"
        reader.stackSize = 4 << 20
        reader.start()
        CFRunLoopRun()
    }

    private static func readLoop() {
        let input = FileHandle.standardInput
        var buffer = LineBuffer()
        while true {
            let chunk = input.availableData
            if chunk.isEmpty { break }
            for line in buffer.append(chunk) { process(line: line) }
            if buffer.overflowed {
                // The framing is lost and there is no way to find the start of the next
                // message, so say so rather than going quiet mid-stream.
                DispatchQueue.main.sync {
                    Output.current.failure(id: -1, error: BridgeError(
                        code: "BAD_REQUEST",
                        message: "a request exceeded \(LineBuffer.defaultLimit) bytes without a newline; "
                            + "the framing is lost, so the bridge is shutting down"))
                }
                break
            }
        }
        if let last = buffer.drain() { process(line: last) }
        // stdin closed: the supervisor went away, so tear down instead of idling forever.
        DispatchQueue.main.async { Connection.current.close() }
    }

    private static func process(line: Data) {
        // AX calls and every registry are main-thread confined; block the reader until the
        // op completes so per-connection ordering is preserved.
        DispatchQueue.main.sync { RequestPump.process(line: line) }
    }

    // MARK: - serve

    private static func runServer(path: String) {
        // A client that vanishes mid-reply must not take the service down with it.
        signal(SIGPIPE, SIG_IGN)
        let server = SocketServer(path: path)
        do {
            try server.start()
        } catch let error as BridgeError {
            FileHandle.standardError.write(Data("we-ax: \(error.code): \(error.message)\n".utf8))
            exit(1)
        } catch {
            FileHandle.standardError.write(Data("we-ax: \(error)\n".utf8))
            exit(1)
        }
        Output.standardOutput.log("we-ax serving \(path) (trusted: \(AXIsProcessTrusted()))")
        installTerminationHandler(server)
        CFRunLoopRun()
    }

    /// launchd stops a job with SIGTERM. Handling it is not tidiness: a suppression tap
    /// installed on somebody else's application would otherwise survive the process that
    /// installed it, with nothing left able to remove it.
    private static func installTerminationHandler(_ server: SocketServer) {
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler {
                server.stop()
                exit(0)
            }
            source.resume()
            terminationSources.append(source)
        }
    }

    /// Signal sources stop firing the moment they are released.
    private static var terminationSources: [DispatchSourceSignal] = []
}

setvbuf(stdout, nil, _IONBF, 0)
Bridge.main()
