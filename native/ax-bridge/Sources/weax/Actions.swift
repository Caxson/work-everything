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
        let element = AXElement(try ElementRegistry.shared.element(for: nodeId))
        let err = element.setAttribute(kAXValueAttribute, try JSONCoercion.toCF(value))
        guard err == .success else { throw BridgeError.ax(err, "setValue on node \(nodeId)") }
        return .object(["nodeId": .int(nodeId), "ok": .bool(true)])
    }

    static func press(nodeId: Int, action: String) throws -> JSONValue {
        let element = AXElement(try ElementRegistry.shared.element(for: nodeId))
        let err = element.perform(action)
        guard err == .success else { throw BridgeError.ax(err, "perform \(action) on node \(nodeId)") }
        return .object(["nodeId": .int(nodeId), "action": .string(action), "ok": .bool(true)])
    }

    static func focus(nodeId: Int) throws -> JSONValue {
        let element = AXElement(try ElementRegistry.shared.element(for: nodeId))
        let err = element.setAttribute(kAXFocusedAttribute, kCFBooleanTrue)
        guard err == .success else { throw BridgeError.ax(err, "focus node \(nodeId)") }
        return .object(["nodeId": .int(nodeId), "ok": .bool(true)])
    }

    static func keystroke(pid: pid_t, key: String, modifiers: [String]) throws -> JSONValue {
        let flags = try Keyboard.flags(from: modifiers)
        guard let source = CGEventSource(stateID: .privateState) else {
            throw BridgeError(code: "CG_ERROR", message: "could not create a CGEventSource")
        }
        if let code = Keyboard.keyCode(for: key) {
            let shifted = flags.union(needsShift(key) ? .maskShift : [])
            try post(source: source, code: code, flags: shifted, unicode: nil, pid: pid)
            return .object(["ok": .bool(true), "mode": .string("keycode"), "keyCode": .int(Int(code))])
        }
        guard key.count >= 1, modifiers.isEmpty else {
            throw BridgeError.badRequest("key '\(key)' has no keycode on the US layout; modifiers cannot be applied")
        }
        try post(source: source, code: 0, flags: flags, unicode: key, pid: pid)
        return .object(["ok": .bool(true), "mode": .string("unicode")])
    }

    private static func needsShift(_ key: String) -> Bool {
        key.count == 1 && key.first!.isUppercase
    }

    private static func post(source: CGEventSource, code: CGKeyCode, flags: CGEventFlags,
                             unicode: String?, pid: pid_t) throws {
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else {
            throw BridgeError(code: "CG_ERROR", message: "could not create key events")
        }
        down.flags = flags
        up.flags = flags
        if let unicode = unicode {
            let utf16 = Array(unicode.utf16)
            down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        }
        down.postToPid(pid)
        up.postToPid(pid)
    }
}
