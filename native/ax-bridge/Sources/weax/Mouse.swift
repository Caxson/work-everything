import ApplicationServices
import CoreGraphics
import Foundation

/// Synthetic mouse input.
///
/// Routing asymmetry that matters (and is the opposite of keyboard input): mouse events
/// MUST go to the global HID tap, because the window server routes them by screen
/// coordinate. Posting them to a pid instead makes clicks land nowhere and focus fail
/// silently. Keyboard events are the reverse — see `Actions.keystroke`.
enum Mouse {
    private struct ButtonSpec {
        let down: CGEventType
        let up: CGEventType
        let button: CGMouseButton
        let downName: String
        let upName: String
    }

    private static let buttons: [String: ButtonSpec] = [
        "left": ButtonSpec(down: .leftMouseDown, up: .leftMouseUp, button: .left,
                           downName: "leftMouseDown", upName: "leftMouseUp"),
        "right": ButtonSpec(down: .rightMouseDown, up: .rightMouseUp, button: .right,
                            downName: "rightMouseDown", upName: "rightMouseUp"),
        "center": ButtonSpec(down: .otherMouseDown, up: .otherMouseUp, button: .center,
                             downName: "otherMouseDown", upName: "otherMouseUp")
    ]

    /// Screen point at the centre of a node's frame, in the top-left origin space that
    /// both AXPosition and CGEvent use.
    static func center(of element: AXElement) throws -> CGPoint {
        let values = element.copyMultiple([kAXPositionAttribute, kAXSizeAttribute])
        var origin = CGPoint.zero
        var size = CGSize.zero
        guard let rawPosition = values[kAXPositionAttribute], let rawSize = values[kAXSizeAttribute],
              CFGetTypeID(rawPosition) == AXValueGetTypeID(), CFGetTypeID(rawSize) == AXValueGetTypeID(),
              AXValueGetValue(rawPosition as! AXValue, .cgPoint, &origin),
              AXValueGetValue(rawSize as! AXValue, .cgSize, &size) else {
            throw BridgeError(code: "NO_FRAME", message: "element exposes no AXPosition/AXSize to click")
        }
        guard size.width > 0, size.height > 0 else {
            throw BridgeError(code: "NO_FRAME", message: "element has a zero-sized frame")
        }
        return CGPoint(x: origin.x + size.width / 2, y: origin.y + size.height / 2)
    }

    static func click(at point: CGPoint, button: String, clickCount: Int,
                      modifiers: [String], dryRun: Bool) throws -> JSONValue {
        guard let spec = buttons[button.lowercased()] else {
            throw BridgeError.badRequest("unknown mouse button '\(button)' (left|right|center)")
        }
        guard clickCount >= 1, clickCount <= 3 else {
            throw BridgeError.badRequest("'clickCount' must be 1...3")
        }
        let flags = try flagMask(modifiers)
        let plan: JSONValue = .object([
            "x": .double(point.x), "y": .double(point.y),
            "button": .string(button.lowercased()), "clickCount": .int(clickCount),
            "flags": .int(Int(flags.rawValue)),
            "tap": .string("cghidEventTap"),
            "route": .string("foreground"),
            "events": .array([.string("mouseMoved"), .string(spec.downName), .string(spec.upName)])
        ])
        guard !dryRun else { return .object(["ok": .bool(true), "dryRun": .bool(true), "plan": plan]) }

        guard let source = CGEventSource(stateID: .privateState) else {
            throw BridgeError(code: "CG_ERROR", message: "could not create a CGEventSource")
        }
        try post(source: source, point: point, spec: spec, clickCount: clickCount, flags: flags)
        return .object(["ok": .bool(true), "plan": plan])
    }

    static func flagMask(_ modifiers: [String]) throws -> CGEventFlags {
        var flags: CGEventFlags = []
        for raw in modifiers {
            switch try Keyboard.canonical(raw) {
            case "cmd": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "alt": flags.insert(.maskAlternate)
            case "ctrl": flags.insert(.maskControl)
            default: flags.insert(.maskSecondaryFn)
            }
        }
        return flags
    }

    /// Foreground scroll. Like `click`, it moves the pointer first, because the HID tap
    /// routes a scroll to whatever is under the cursor. Use the background route to scroll
    /// a window without taking the pointer away from the person using the machine.
    static func scroll(at point: CGPoint, deltaX: Int, deltaY: Int, unit: CGScrollEventUnit,
                       flags: CGEventFlags, dryRun: Bool) throws -> JSONValue {
        let plan: JSONValue = .object([
            "x": .double(point.x), "y": .double(point.y),
            "deltaX": .int(deltaX), "deltaY": .int(deltaY),
            "unit": .string(unit == .pixel ? "pixel" : "line"),
            "flags": .int(Int(flags.rawValue)),
            "tap": .string("cghidEventTap"),
            "route": .string("foreground"),
            "events": .array([.string("mouseMoved"), .string("scrollWheel")])
        ])
        guard !dryRun else { return .object(["ok": .bool(true), "dryRun": .bool(true), "plan": plan]) }

        guard let source = CGEventSource(stateID: .privateState) else {
            throw BridgeError(code: "CG_ERROR", message: "could not create a CGEventSource")
        }
        guard let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
                                 mouseCursorPosition: point, mouseButton: .left),
              let wheel = CGEvent(scrollWheelEvent2Source: source, units: unit, wheelCount: 2,
                                  wheel1: Int32(deltaY), wheel2: Int32(deltaX), wheel3: 0) else {
            throw BridgeError(code: "CG_ERROR", message: "could not create scroll events")
        }
        move.flags = flags
        move.post(tap: .cghidEventTap)
        wheel.flags = flags
        wheel.location = point
        wheel.post(tap: .cghidEventTap)
        return .object(["ok": .bool(true), "plan": plan])
    }

    private static func post(source: CGEventSource, point: CGPoint, spec: ButtonSpec,
                             clickCount: Int, flags: CGEventFlags) throws {
        guard let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
                                 mouseCursorPosition: point, mouseButton: spec.button) else {
            throw BridgeError(code: "CG_ERROR", message: "could not create mouse events")
        }
        move.flags = flags
        move.post(tap: .cghidEventTap)

        for click in 1...clickCount {
            guard let down = CGEvent(mouseEventSource: source, mouseType: spec.down,
                                     mouseCursorPosition: point, mouseButton: spec.button),
                  let up = CGEvent(mouseEventSource: source, mouseType: spec.up,
                                   mouseCursorPosition: point, mouseButton: spec.button) else {
                throw BridgeError(code: "CG_ERROR", message: "could not create mouse events")
            }
            for event in [down, up] {
                event.flags = flags
                event.setIntegerValueField(.mouseEventClickState, value: Int64(click))
                event.post(tap: .cghidEventTap)
            }
        }
    }
}
