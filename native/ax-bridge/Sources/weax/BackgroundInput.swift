import CoreGraphics
import Foundation

/// Which addressing fields to put on an event. All default on; the flags exist so a
/// caller can reproduce the field-by-field teardown that established what is required.
struct DispatchFields {
    var targetPID = true       // 40, public
    var mouseWindow = true     // 91 / 92, public
    var privateWindow = true   // 51 / 58, private — the mouse path has no substitute
    var windowLocation = true  // CGEventSetWindowLocation, private

    static func parse(_ value: JSONValue?) -> DispatchFields {
        var fields = DispatchFields()
        guard let object = value?.objectValue else { return fields }
        fields.targetPID = object["targetPID"]?.boolValue ?? fields.targetPID
        fields.mouseWindow = object["mouseWindow"]?.boolValue ?? fields.mouseWindow
        fields.privateWindow = object["privateWindow"]?.boolValue ?? fields.privateWindow
        fields.windowLocation = object["windowLocation"]?.boolValue ?? fields.windowLocation
        return fields
    }
}

/// What was actually set on the event — not what was asked for.
///
/// The distinction is the whole point: `CGEventField(rawValue:)` accepts any number, so
/// "the field number exists" proves nothing. A plan that reports 51 and 58 as set, on a
/// system where they no longer route, still reports them as set. Only the target's own
/// behaviour can tell you they worked, which is why this report is designed to be
/// asserted against a probe rather than trusted on its own.
struct AddressingReport {
    var field40 = false
    var field91 = false
    var field92 = false
    var field51 = false
    var field58 = false
    var windowLocationApplied = false
    var windowPoint: CGPoint?

    var json: JSONValue {
        var fields: [String: JSONValue] = [
            "40": .bool(field40), "51": .bool(field51), "58": .bool(field58)
        ]
        if field91 || field92 {
            fields["91"] = .bool(field91)
            fields["92"] = .bool(field92)
        }
        var out: [String: JSONValue] = [
            "fields": .object(fields),
            "windowLocationApplied": .bool(windowLocationApplied)
        ]
        if let point = windowPoint {
            out["windowPoint"] = .object(["x": .double(point.x), "y": .double(point.y)])
        }
        return .object(out)
    }
}

/// Where a background event is aimed. A window number is mandatory — without 51/58 the
/// event does not go to the wrong window, it disappears.
struct BackgroundTarget {
    let pid: pid_t
    let windowNumber: Int
    let frame: CGRect?

    var json: JSONValue {
        var out: [String: JSONValue] = [
            "pid": .int(Int(pid)),
            "windowNumber": .int(windowNumber)
        ]
        if let frame = frame {
            out["frame"] = .object([
                "x": .double(frame.minX), "y": .double(frame.minY),
                "w": .double(frame.width), "h": .double(frame.height)
            ])
        }
        return .object(out)
    }
}

/// Synthetic input that reaches a window without activating its application, moving the
/// cursor, or disturbing whatever the person is doing in front of it.
///
/// Everything here goes to `postToPid`. There is no `.cghidEventTap` path in this file
/// and there must not be one: the HID tap routes by screen coordinate, which means it
/// moves the real cursor and raises the window it lands on.
enum BackgroundInput {
    struct ButtonSpec {
        let down: CGEventType
        let up: CGEventType
        let button: CGMouseButton
        let downName: String
        let upName: String
    }

    static let buttons: [String: ButtonSpec] = [
        "left": ButtonSpec(down: .leftMouseDown, up: .leftMouseUp, button: .left,
                           downName: "leftMouseDown", upName: "leftMouseUp"),
        "right": ButtonSpec(down: .rightMouseDown, up: .rightMouseUp, button: .right,
                            downName: "rightMouseDown", upName: "rightMouseUp"),
        "center": ButtonSpec(down: .otherMouseDown, up: .otherMouseUp, button: .center,
                             downName: "otherMouseDown", upName: "otherMouseUp")
    ]

    /// Mouse events are built with a nil source and keyboard events with
    /// `.hidSystemState`. That asymmetry is measured, not stylistic — do not unify them.
    private static let keySource = CGEventSource(stateID: .hidSystemState)

    static let downUpGapMicroseconds: UInt32 = 30_000
    static let afterClickMicroseconds: UInt32 = 20_000

    // MARK: - Field application

    private static func address(_ event: CGEvent, target: BackgroundTarget,
                                fields: DispatchFields, screenPoint: CGPoint?) -> AddressingReport {
        var report = AddressingReport()
        if fields.targetPID {
            event.setIntegerValueField(EventField.targetPID, value: Int64(target.pid))
            report.field40 = true
        }
        if fields.privateWindow {
            let applied = event.applyPrivateWindowFields(windowNumber: target.windowNumber)
            report.field51 = applied.field51
            report.field58 = applied.field58
        }
        guard let screenPoint = screenPoint else { return report }
        if fields.mouseWindow {
            event.setIntegerValueField(EventField.windowUnderPointer, value: Int64(target.windowNumber))
            event.setIntegerValueField(EventField.windowThatCanHandle, value: Int64(target.windowNumber))
            report.field91 = true
            report.field92 = true
        }
        if fields.windowLocation, let frame = target.frame {
            let local = Coords.windowLocal(screenPoint: screenPoint, frame: frame)
            report.windowPoint = local
            report.windowLocationApplied = SPI.setWindowLocation(local, on: event)
        }
        return report
    }

    // MARK: - Dry run

    /// Builds the event a real call would build, applies the fields, and throws it away.
    ///
    /// A dry run that reports intent rather than effect is worth very little here — the
    /// question that matters is whether 51 and 58 could actually be set on this system.
    /// So the plan is produced by the same code path that would post, minus the posting.
    static func probe(target: BackgroundTarget, screenPoint: CGPoint?,
                      fields: DispatchFields) throws -> AddressingReport {
        let event: CGEvent?
        if let screenPoint = screenPoint {
            event = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                            mouseCursorPosition: screenPoint, mouseButton: .left)
        } else {
            event = CGEvent(keyboardEventSource: keySource, virtualKey: 0, keyDown: true)
        }
        guard let event = event else {
            throw BridgeError(code: "CG_ERROR", message: "could not create an event to plan against")
        }
        return address(event, target: target, fields: fields, screenPoint: screenPoint)
    }

    // MARK: - Mouse

    @discardableResult
    static func postMouse(_ type: CGEventType, target: BackgroundTarget, screenPoint: CGPoint,
                          button: CGMouseButton, clickState: Int64, pressure: Double,
                          flags: CGEventFlags, fields: DispatchFields) throws -> AddressingReport {
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type,
                                  mouseCursorPosition: screenPoint, mouseButton: button) else {
            throw BridgeError(code: "CG_ERROR", message: "could not create a \(type.rawValue) mouse event")
        }
        event.flags = flags
        event.setIntegerValueField(.mouseEventClickState, value: clickState)
        event.setDoubleValueField(.mouseEventPressure, value: pressure)
        let report = address(event, target: target, fields: fields, screenPoint: screenPoint)
        event.postToPid(target.pid)
        return report
    }

    /// One press-and-release, repeated `clickCount` times with an ascending click state.
    /// No `mouseMoved` is sent: moving the pointer is exactly what this path exists to
    /// avoid, and the window is addressed by number rather than by where a cursor is.
    @discardableResult
    static func click(target: BackgroundTarget, screenPoint: CGPoint, button: ButtonSpec,
                      clickCount: Int, flags: CGEventFlags, fields: DispatchFields) throws -> AddressingReport {
        var report = AddressingReport()
        for state in 1...max(1, clickCount) {
            report = try postMouse(button.down, target: target, screenPoint: screenPoint,
                                   button: button.button, clickState: Int64(state), pressure: 1,
                                   flags: flags, fields: fields)
            usleep(downUpGapMicroseconds)
            _ = try postMouse(button.up, target: target, screenPoint: screenPoint,
                              button: button.button, clickState: Int64(state), pressure: 0,
                              flags: flags, fields: fields)
            usleep(afterClickMicroseconds)
        }
        return report
    }

    // MARK: - Keyboard

    /// Posts one prepared key event.
    ///
    /// The window fields are applied for symmetry and diagnosis, but they do **not**
    /// steer a key event: measured, a key posted to a pid lands in that application's own
    /// key window whatever 51/58 say. Aiming keys at a specific window requires
    /// activating it first — see `BackgroundSession.activate`.
    @discardableResult
    static func postKey(_ event: CGEvent, target: BackgroundTarget,
                        fields: DispatchFields) -> AddressingReport {
        let report = address(event, target: target, fields: fields, screenPoint: nil)
        event.postToPid(target.pid)
        return report
    }

    /// Posts a prepared key plan — the same `KeyEventSpec` sequence the foreground path
    /// uses, so modifiers are pressed and released identically and the run still ends on
    /// `flags == 0`.
    @discardableResult
    static func send(_ specs: [KeyEventSpec], target: BackgroundTarget,
                     fields: DispatchFields) throws -> AddressingReport {
        var report = AddressingReport()
        for spec in specs {
            report = postKey(try Keyboard.makeEvent(spec, source: keySource), target: target, fields: fields)
        }
        return report
    }

    /// Types text as unicode payloads, one grapheme cluster per key pair.
    ///
    /// This is the only way measured to get text into a `contenteditable`: every public
    /// accessibility write reported success and produced no `beforeinput` or `input` at
    /// all, so the page — and therefore the app's own state — never saw the text.
    @discardableResult
    static func type(_ text: String, target: BackgroundTarget, fields: DispatchFields,
                     perCharacterMicroseconds: UInt32 = 4_000) throws -> AddressingReport {
        var report = AddressingReport()
        for cluster in text {
            let utf16 = Array(String(cluster).utf16)
            guard let down = CGEvent(keyboardEventSource: keySource, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: keySource, virtualKey: 0, keyDown: false) else {
                throw BridgeError(code: "CG_ERROR", message: "could not create a key event for '\(cluster)'")
            }
            down.flags = []
            up.flags = []
            down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            report = postKey(down, target: target, fields: fields)
            _ = postKey(up, target: target, fields: fields)
            usleep(perCharacterMicroseconds)
        }
        return report
    }

    // MARK: - Scroll

    @discardableResult
    static func scroll(target: BackgroundTarget, screenPoint: CGPoint, deltaX: Int, deltaY: Int,
                       unit: CGScrollEventUnit, flags: CGEventFlags,
                       fields: DispatchFields) throws -> AddressingReport {
        guard let event = CGEvent(scrollWheelEvent2Source: nil, units: unit, wheelCount: 2,
                                  wheel1: Int32(deltaY), wheel2: Int32(deltaX), wheel3: 0) else {
            throw BridgeError(code: "CG_ERROR", message: "could not create a scroll event")
        }
        event.flags = flags
        // A scroll event carries no cursor position of its own; the window fields need one
        // to agree with, so it is set explicitly rather than left at the origin.
        event.location = screenPoint
        let report = address(event, target: target, fields: fields, screenPoint: screenPoint)
        event.postToPid(target.pid)
        return report
    }
}
