// CaretProbe — a throwaway window that reproduces the measured composer caret reset.
//
// One editable field. The first time its text goes from empty to non-empty it puts the
// insertion point back at 0, which is exactly what Feishu's contenteditable was measured to
// do when its placeholder disappears. The flag clears when the field is emptied again, so
// the same window can be driven twice in one run.
//
// It is nobody's real window: its own bundle, its own process, killed at the end.
import AppKit

private let logURL = URL(fileURLWithPath: (ProcessInfo.processInfo.environment["CARET_LOG"] ?? "/tmp/CaretProbe.log"))

func note(_ message: String) {
    let line = String(format: "%.3f %@\n", Date().timeIntervalSince1970, message)
    if let handle = try? FileHandle(forWritingTo: logURL) {
        _ = try? handle.seekToEnd(); try? handle.write(contentsOf: Data(line.utf8)); try? handle.close()
    } else {
        try? line.write(to: logURL, atomically: true, encoding: .utf8)
    }
}

final class Probe: NSObject, NSTextFieldDelegate {
    let window: NSWindow
    let field = NSTextField(string: "")
    private var didReset = false

    override init() {
        let size = NSSize(width: 520, height: 160)
        window = NSWindow(contentRect: NSRect(origin: NSPoint(x: 200, y: 200), size: size),
                          styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.title = "CaretProbe"
        window.isReleasedWhenClosed = false
        let root = NSView(frame: NSRect(origin: .zero, size: size))
        field.frame = NSRect(x: 20, y: 80, width: 480, height: 26)
        field.setAccessibilityIdentifier("caret-probe-field")
        field.delegate = self
        root.addSubview(field)
        window.contentView = root
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.screenSaverWindow)) + 1)
        window.orderFrontRegardless()
        note("ready window=\(window.windowNumber)")
    }

    /// The measured mechanism: the composer re-renders on its first character and the caret
    /// lands back at 0. Reproduced here on the empty-to-non-empty edge only.
    func controlTextDidChange(_ notification: Notification) {
        let text = field.stringValue
        if text.isEmpty { didReset = false; return }
        guard !didReset else { return }
        didReset = true
        field.currentEditor()?.selectedRange = NSRange(location: 0, length: 0)
        note("reset caret to 0 after first character, text=\(text)")
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let probe = Probe()
app.run()
