import ApplicationServices
import Foundation

/// we-ax — a thin macOS Accessibility bridge speaking NDJSON over stdio.
///
/// Threading contract:
///   * main thread  — CFRunLoop, so AXObserver sources can fire; every op executes here
///   * reader thread — blocking stdin reads, hands each line to the main thread
///   * stdout        — serialized behind a single lock in `Output`
enum Bridge {
    static func main() {
        let reader = Thread { readLoop() }
        reader.name = "we-ax.stdin"
        reader.stackSize = 4 << 20
        reader.start()
        CFRunLoopRun()
    }

    private static func readLoop() {
        let input = FileHandle.standardInput
        var buffer = Data()
        while true {
            let chunk = input.availableData
            if chunk.isEmpty { break }
            buffer.append(chunk)
            while let newline = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<newline)
                buffer = buffer.subdata(in: buffer.index(after: newline)..<buffer.endIndex)
                process(line: line)
            }
        }
        if !buffer.isEmpty { process(line: buffer) }
        // stdin closed: the supervisor went away, so tear down instead of idling forever.
        DispatchQueue.main.async {
            SessionRegistry.shared.releaseAll()
            ObserverRegistry.shared.teardownAll()
            exit(0)
        }
    }

    private static func process(line: Data) {
        let trimmed = line.drop { $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }
        guard !trimmed.isEmpty else { return }
        let request: Request
        do {
            request = try Request.parse(line: Data(trimmed))
        } catch let error as BridgeError {
            Output.shared.failure(id: -1, error: error)
            return
        } catch {
            return
        }
        // AX calls and both registries are main-thread confined; block the reader until
        // the op completes so per-connection ordering is preserved.
        DispatchQueue.main.sync { Dispatcher.handle(request) }
    }
}

setvbuf(stdout, nil, _IONBF, 0)
Bridge.main()
