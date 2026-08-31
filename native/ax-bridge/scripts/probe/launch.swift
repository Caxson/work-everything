// Launches an app bundle without activating it (measured to work on macOS 26.3).
import AppKit
let path = CommandLine.arguments[1]
let config = NSWorkspace.OpenConfiguration()
config.activates = false
config.createsNewApplicationInstance = true
if let dir = ProcessInfo.processInfo.environment["WEAX_LOG_DIR"] {
    config.environment = ["WEAX_LOG_DIR": dir]
}
let done = DispatchSemaphore(value: 0)
NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: config) { app, error in
    if let app = app { print("pid=\(app.processIdentifier)") }
    if let error = error { FileHandle.standardError.write(Data("launch failed: \(error)\n".utf8)) }
    done.signal()
}
_ = done.wait(timeout: .now() + 15)
