import ApplicationServices
import CoreGraphics
import Foundation

/// Mutating operations. Every one returns a structured result; none of them ever
/// traps, and AXError values are surfaced verbatim.
enum Actions {
    static func enableAX(pid: pid_t) -> JSONValue {
        let app = AXElement.application(pid: pid)
        let manual = app.setAttribute("AXManualAccessibility", kCFBooleanTrue)
        let enhanced = app.setAttribute("AXEnhancedUserInterface", kCFBooleanTrue)
        return .object([
            "manualAccessibility": outcome(manual),
            "enhancedUserInterface": outcome(enhanced)
        ])
    }

    private static func outcome(_ err: AXError) -> JSONValue {
        .object([
            "ok": .bool(err == .success),
            "axError": .int(Int(err.rawValue)),
            "name": .string(axErrorName(err))
        ])
    }

    static func setValue(nodeId: Int, value: JSONValue) throws -> JSONValue {
        let element = AXElement(try ElementRegistry.current.element(for: nodeId))
        let err = element.setAttribute(kAXValueAttribute, try JSONCoercion.toCF(value))
        guard err == .success else { throw BridgeError.ax(err, "setValue on node \(nodeId)") }
        return .object(["nodeId": .int(nodeId), "ok": .bool(true)])
    }

    static func press(nodeId: Int, action: String) throws -> JSONValue {
        let element = AXElement(try ElementRegistry.current.element(for: nodeId))
        let err = element.perform(action)
        guard err == .success else { throw BridgeError.ax(err, "perform \(action) on node \(nodeId)") }
        return .object(["nodeId": .int(nodeId), "action": .string(action), "ok": .bool(true)])
    }

    static func focus(nodeId: Int) throws -> JSONValue {
        let element = AXElement(try ElementRegistry.current.element(for: nodeId))
        let err = element.setAttribute(kAXFocusedAttribute, kCFBooleanTrue)
        guard err == .success else { throw BridgeError.ax(err, "focus node \(nodeId)") }
        return .object(["nodeId": .int(nodeId), "ok": .bool(true)])
    }

    /// Sends one keystroke to `pid`.
    ///
    /// Two rules, both learned the hard way (see spikes/README.md):
    ///
    /// 1. Keyboard events go to `CGEventPostToPid`, never the HID tap. A HID-tap key
    ///    event reaches an Electron/CEF app's *native* layer only — it fires menu
    ///    shortcuts and navigates tabs, but not one character ever reaches the renderer.
    ///    (Mouse events are the exact opposite; see `Mouse`.)
    /// 2. The event source is `.privateState`, which starts with no inherited modifier
    ///    state, and every event is posted with an explicit flag mask — zero included.
    ///    Modifiers are additionally pressed and released with real `flagsChanged`
    ///    events so the sequence always ends on flags == 0. Masking a flag onto a key
    ///    event without ever releasing it latches the modifier inside the target app:
    ///    a later plain `w` arrives as Cmd+W and closes the window.
    static func keystroke(pid: pid_t, key: String, modifiers: [String], dryRun: Bool) throws -> JSONValue {
        let specs = try Keyboard.plan(key: key, modifiers: modifiers)
        let mode = specs.contains { $0.unicode != nil } ? "unicode" : "keycode"
        let plan: JSONValue = .object([
            "key": .string(key),
            "mode": .string(mode),
            "target": .string("postToPid(\(pid))"),
            "sourceState": .string("private"),
            "events": .array(specs.map { $0.json })
        ])
        guard !dryRun else { return .object(["ok": .bool(true), "dryRun": .bool(true), "plan": plan]) }

        guard let source = CGEventSource(stateID: .privateState) else {
            throw BridgeError(code: "CG_ERROR", message: "could not create a CGEventSource")
        }
        for spec in specs { try post(spec, source: source, pid: pid) }
        return .object(["ok": .bool(true), "mode": .string(mode), "plan": plan])
    }

    private static func post(_ spec: KeyEventSpec, source: CGEventSource, pid: pid_t) throws {
        try Keyboard.makeEvent(spec, source: source).postToPid(pid)
    }
}
