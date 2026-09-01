// BgProbe — 一次性目标 app，用于后台驱动可行性闸门。
// 刻意开【两个窗口】：单窗口时 postToPid 路由无歧义，测不出私有字段 51/58 的价值。
// 自报 isActive / isKey / isMain / frontmost / 每窗口 clicks 与文本，全部写日志。
import AppKit

private let probeName = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "BgProbe"
private let logDir = ProcessInfo.processInfo.environment["BGGATE_LOG_DIR"] ?? "/private/tmp"
private let logURL = URL(fileURLWithPath: "\(logDir)/\(probeName).log")

func appendLog(_ message: String) {
    let line = String(format: "%.4f %@\n", Date().timeIntervalSince1970, message)
    if !FileManager.default.fileExists(atPath: logURL.path) {
        try? line.write(to: logURL, atomically: true, encoding: .utf8)
        return
    }
    if let h = try? FileHandle(forWritingTo: logURL) {
        _ = try? h.seekToEnd()
        try? h.write(contentsOf: Data(line.utf8))
        try? h.close()
    }
}

/// 记录所有到达该窗口的事件——「事件真的投进来了」的一手证据，且带窗口号。
final class ProbeWindow: NSWindow {
    var probeTag = "?"
    override func sendEvent(_ event: NSEvent) {
        switch event.type {
        case .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp:
            appendLog("recv[\(probeTag)/\(windowNumber)] mouse type=\(event.type.rawValue) loc=(\(Int(event.locationInWindow.x)),\(Int(event.locationInWindow.y))) clickCount=\(event.clickCount)")
        case .keyDown:
            appendLog("recv[\(probeTag)/\(windowNumber)] keyDown chars=\(event.characters ?? "")")
        case .keyUp:
            break
        case .flagsChanged:
            appendLog("recv[\(probeTag)/\(windowNumber)] flagsChanged flags=\(event.modifierFlags.rawValue)")
        case .appKitDefined:
            appendLog("recv[\(probeTag)/\(windowNumber)] appKitDefined subtype=\(event.subtype.rawValue) win=\(event.windowNumber)")
        case .scrollWheel:
            appendLog("recv[\(probeTag)/\(windowNumber)] scrollWheel dy=\(event.scrollingDeltaY)")
        default:
            break
        }
        super.sendEvent(event)
    }
}

final class ProbeRootView: NSView {
    var probeTag = "?"
    override var acceptsFirstResponder: Bool { true }
    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        appendLog("root[\(probeTag)].mouseDown loc=(\(Int(p.x)),\(Int(p.y)))")
        super.mouseDown(with: event)
    }
}

/// 一个窗口 + 它的输入框 + 正中心按钮
final class ProbeUnit: NSObject, NSWindowDelegate, NSTextFieldDelegate {
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

        window.probeTag = tag
        window.title = "\(probeName) \(tag)"
        window.delegate = self
        window.isReleasedWhenClosed = false

        let root = ProbeRootView(frame: NSRect(origin: .zero, size: size))
        root.probeTag = tag
        root.autoresizingMask = [.width, .height]

        let label = NSTextField(labelWithString: "\(probeName) window \(tag)")
        label.font = .systemFont(ofSize: 18, weight: .semibold)
        label.frame = NSRect(x: 24, y: 250, width: 400, height: 24)
        label.setAccessibilityIdentifier("probe-title")
        root.addSubview(label)

        field.placeholderString = "probe input \(tag)"
        field.frame = NSRect(x: 24, y: 180, width: 380, height: 26)
        field.setAccessibilityIdentifier("probe-input")
        field.delegate = self
        root.addSubview(field)

        // 按钮放在窗口正中心：center primer 落点就是这里，专门用来暴露误触
        let button = NSButton(title: "Probe Button \(tag)", target: self, action: #selector(buttonPressed(_:)))
        button.bezelStyle = .rounded
        button.frame = NSRect(x: size.width / 2 - 80, y: size.height / 2 - 17, width: 160, height: 34)
        button.setAccessibilityIdentifier("probe-button")
        root.addSubview(button)

        window.contentView = root
        window.makeFirstResponder(field)
        window.orderFront(nil)          // 只 orderFront，不 makeKey：绝不抢前台
    }

    @objc private func buttonPressed(_ sender: NSButton) {
        clicks += 1
        appendLog("buttonPressed[\(tag)/\(window.windowNumber)] clicks=\(clicks)")
    }

    func controlTextDidChange(_ obj: Notification) {
        appendLog("field[\(tag)/\(window.windowNumber)]=\(field.stringValue)")
    }

    func windowDidBecomeKey(_ n: Notification) { appendLog("note[\(tag)] didBecomeKey") }
    func windowDidBecomeMain(_ n: Notification) { appendLog("note[\(tag)] didBecomeMain") }
    func windowDidResignKey(_ n: Notification) { appendLog("note[\(tag)] didResignKey") }
    func windowDidResignMain(_ n: Notification) { appendLog("note[\(tag)] didResignMain") }

    var frameLine: String {
        let f = window.frame
        let screenH = NSScreen.screens.first?.frame.height ?? 0
        return String(format: "%@ win=%d frameAX=%.0f,%.0f,%.0f,%.0f",
                      tag, window.windowNumber, f.minX, screenH - (f.minY + f.height), f.width, f.height)
    }

    var stateLine: String {
        "\(tag)/\(window.windowNumber) isKey=\(window.isKeyWindow) isMain=\(window.isMainWindow) clicks=\(clicks) field=\(field.stringValue)"
    }
}

final class ProbeAppDelegate: NSObject, NSApplicationDelegate {
    var units: [ProbeUnit] = []
    private var lastState = ""

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let base: CGFloat = probeName.hasSuffix("A") ? 60 : 700
        units = [ProbeUnit(tag: "W0", origin: NSPoint(x: base, y: 400)),
                 ProbeUnit(tag: "W1", origin: NSPoint(x: base, y: 400))]  // 完全重叠：W1 在前遮住 W0

        let c = NotificationCenter.default
        c.addObserver(forName: NSApplication.didBecomeActiveNotification, object: NSApp, queue: .main) { [weak self] _ in
            appendLog("note didBecomeActive"); self?.writeState(force: true)
        }
        c.addObserver(forName: NSApplication.didResignActiveNotification, object: NSApp, queue: .main) { [weak self] _ in
            appendLog("note didResignActive"); self?.writeState(force: true)
        }
        Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.writeState(force: false) }

        appendLog("launched pid=\(ProcessInfo.processInfo.processIdentifier) " + units.map(\.frameLine).joined(separator: " | "))
        writeState(force: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    private func writeState(force: Bool) {
        let front = NSWorkspace.shared.frontmostApplication?.localizedName ?? "nil"
        let s = "isActive=\(NSApp.isActive) front=\(front) " + units.map(\.stateLine).joined(separator: " || ")
        if force || s != lastState {
            lastState = s
            appendLog("STATE \(s)")
        }
    }
}

private let delegate = ProbeAppDelegate()
NSApplication.shared.delegate = delegate
NSApplication.shared.run()
