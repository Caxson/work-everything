// WeAxProbe — throwaway target for verifying the we-ax background path.
// Two windows, a button at the exact centre of each (so a mis-aimed activation primer
// is caught), and a text field to prove typing landed.
import AppKit

private let probeName = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "WeAxProbe"
private let logDir = ProcessInfo.processInfo.environment["WEAX_LOG_DIR"] ?? "/private/tmp"
private let logURL = URL(fileURLWithPath: "\(logDir)/\(probeName).log")

func note(_ message: String) {
    let line = String(format: "%.3f %@\n", Date().timeIntervalSince1970, message)
    if let h = try? FileHandle(forWritingTo: logURL) {
        _ = try? h.seekToEnd(); try? h.write(contentsOf: Data(line.utf8)); try? h.close()
    } else {
        try? line.write(to: logURL, atomically: true, encoding: .utf8)
    }
}

final class ProbeWindow: NSWindow {
    var tag = "?"
    override func sendEvent(_ event: NSEvent) {
        switch event.type {
        case .leftMouseDown, .leftMouseUp:
            note("recv[\(tag)/\(windowNumber)] mouse=\(event.type.rawValue) loc=(\(Int(event.locationInWindow.x)),\(Int(event.locationInWindow.y))) clicks=\(event.clickCount)")
        case .keyDown: note("recv[\(tag)/\(windowNumber)] keyDown chars=\(event.characters ?? "")")
        case .appKitDefined: note("recv[\(tag)/\(windowNumber)] appKitDefined subtype=\(event.subtype.rawValue)")
        case .scrollWheel: note("recv[\(tag)/\(windowNumber)] scrollWheel dy=\(event.scrollingDeltaY)")
        default: break
        }
        super.sendEvent(event)
    }
}

final class Unit: NSObject {
    let tag: String
    let window: ProbeWindow
    let field: NSTextField
    var clicks = 0

    init(tag: String, origin: NSPoint) {
        self.tag = tag
        let size = NSSize(width: 520, height: 300)
        window = ProbeWindow(contentRect: NSRect(origin: origin, size: size),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable],
                             backing: .buffered, defer: false)
        field = NSTextField(string: "")
        super.init()
        window.tag = tag
        window.title = "\(probeName) \(tag)"
        window.isReleasedWhenClosed = false
        let root = NSView(frame: NSRect(origin: .zero, size: size))
        root.autoresizingMask = [.width, .height]

        // Dead centre, so anything aimed at the middle of the window presses it.
        let button = NSButton(title: "CENTRE", target: self, action: #selector(pressed))
        button.frame = NSRect(x: size.width / 2 - 60, y: size.height / 2 - 16, width: 120, height: 32)
        button.setAccessibilityIdentifier("probe-button-\(tag)")
        root.addSubview(button)

        field.frame = NSRect(x: 20, y: size.height - 60, width: 480, height: 24)
        field.setAccessibilityIdentifier("probe-field-\(tag)")
        root.addSubview(field)

        // A label: same AXRole family as the editable field, no way to take focus, and
        // nothing happens when it is clicked. It exists so the suite can drive a focus
        // strategy that reports success while the caret provably does not move — the
        // case that must send zero keys.
        let label = NSTextField(labelWithString: "not focusable")
        label.frame = NSRect(x: 20, y: 20, width: 200, height: 20)
        label.setAccessibilityIdentifier("probe-label-\(tag)")
        root.addSubview(label)

        window.contentView = root
        // Join whatever Space is active. Without this a window opened while a full-screen
        // app is in front lands on the desktop Space, is never on screen, and accessibility
        // never materialises it — the third silent failure mode, reproduced by accident.
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.screenSaverWindow)) + 1)
        window.orderFrontRegardless()
    }

    @objc func pressed() {
        clicks += 1
        note("PRESSED[\(tag)/\(window.windowNumber)] clicks=\(clicks)")
    }

    var state: String {
        "\(tag)/\(window.windowNumber) key=\(window.isKeyWindow) main=\(window.isMainWindow) clicks=\(clicks) field=\(field.stringValue)"
    }
}

final class Delegate: NSObject, NSApplicationDelegate {
    var units: [Unit] = []
    func applicationDidFinishLaunching(_ notification: Notification) {
        try? "".write(to: logURL, atomically: true, encoding: .utf8)
        units = [Unit(tag: "W0", origin: NSPoint(x: 200, y: 300)),
                 Unit(tag: "W1", origin: NSPoint(x: 200, y: 700))]
        note("READY pids=\(ProcessInfo.processInfo.processIdentifier) windows=\(units.map { $0.window.windowNumber })")
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [self] _ in
            let front = NSWorkspace.shared.frontmostApplication?.localizedName ?? "?"
            note("STATE active=\(NSApp.isActive) front=\(front) " + units.map { $0.state }.joined(separator: " | "))
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Delegate()
app.delegate = delegate
app.run()
