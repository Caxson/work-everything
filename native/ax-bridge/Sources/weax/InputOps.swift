import ApplicationServices
import CoreGraphics
import Foundation

/// Routing for the three input operations. Each has a foreground path and a background
/// path; which one runs is decided by `BackgroundOps.wantsBackground`.
///
/// The foreground path is the original behaviour and remains the default: it posts to the
/// global HID tap, which routes by screen coordinate, which means it moves the real cursor
/// and brings the window it lands on to the front. That is fine when a person asked for it
/// and wrong when an agent is working while somebody else uses the machine.
///
/// The background path posts to the process with the window addressed by number. Nothing
/// here reaches `.cghidEventTap`.
enum InputOps {
    // MARK: - click

    static func click(_ request: Request) throws -> JSONValue {
        let background = BackgroundOps.wantsBackground(request)
        let node = request.params["nodeId"]?.intValue
        let explicit = explicitPoint(request)
        guard node != nil || explicit != nil else {
            throw BridgeError.badRequest("click needs either 'nodeId' or both 'x' and 'y'")
        }
        guard background else {
            let point = try node.map { try Mouse.center(of: AXElement(try ElementRegistry.current.element(for: $0))) }
                ?? explicit!
            return try Mouse.click(at: point, button: request.string("button") ?? "left",
                                   clickCount: request.int("clickCount", default: 1),
                                   modifiers: modifiers(request), dryRun: request.bool("dryRun", default: false))
        }

        let aim = try BackgroundOps.aim(request)
        let point = try node.map { try Mouse.center(of: AXElement(try ElementRegistry.current.element(for: $0))) }
            ?? explicit!
        let spec = try button(request)
        let clickCount = request.int("clickCount", default: 1)
        guard clickCount >= 1, clickCount <= 3 else { throw BridgeError.badRequest("'clickCount' must be 1...3") }
        let flags = try Mouse.flagMask(modifiers(request))

        if request.bool("dryRun", default: false) {
            let report = try BackgroundInput.probe(target: aim.target, screenPoint: point, fields: aim.fields)
            return .object(["ok": .bool(true), "dryRun": .bool(true),
                            "plan": plan(aim: aim, point: point, flags: flags, addressing: report,
                                         events: [spec.downName, spec.upName], extra: ["clickCount": .int(clickCount)])])
        }
        return try Invariants.around {
            let report = try BackgroundInput.click(target: aim.target, screenPoint: point, button: spec,
                                                   clickCount: clickCount, flags: flags, fields: aim.fields)
            return .object(["ok": .bool(true),
                            "plan": plan(aim: aim, point: point, flags: flags, addressing: report,
                                         events: [spec.downName, spec.upName],
                                         extra: ["clickCount": .int(clickCount)])])
        }
    }

    // MARK: - keystroke

    static func keystroke(_ request: Request) throws -> JSONValue {
        let key = try request.requireString("key")
        let dryRun = request.bool("dryRun", default: false)
        guard BackgroundOps.wantsBackground(request) else {
            return try Actions.keystroke(pid: try Processes.requirePid(request.requireInt("pid")),
                                         key: key, modifiers: modifiers(request), dryRun: dryRun)
        }

        let aim = try BackgroundOps.aim(request)
        let specs = try Keyboard.plan(key: key, modifiers: modifiers(request))
        let mode = specs.contains { $0.unicode != nil } ? "unicode" : "keycode"

        func planJSON(_ report: AddressingReport) -> JSONValue {
            var out = plan(aim: aim, point: nil, flags: [], addressing: report,
                           events: specs.map { $0.kind.rawValue },
                           extra: ["key": .string(key), "mode": .string(mode),
                                   "sourceState": .string("hidSystemState"),
                                   "keyEvents": .array(specs.map { $0.json })])
            // Measured: a key event posted to a pid lands in that application's own key
            // window whatever 51/58 say. The fields are set, they simply do not steer it.
            if case .object(var object) = out {
                object["windowFieldsSteerKeys"] = .bool(false)
                out = .object(object)
            }
            return out
        }

        if dryRun {
            let report = try BackgroundInput.probe(target: aim.target, screenPoint: nil, fields: aim.fields)
            return .object(["ok": .bool(true), "dryRun": .bool(true), "plan": planJSON(report)])
        }
        return try Invariants.around {
            let report = try BackgroundInput.send(specs, target: aim.target, fields: aim.fields)
            return .object(["ok": .bool(true), "mode": .string(mode), "plan": planJSON(report)])
        }
    }

    // MARK: - scroll

    static func scroll(_ request: Request) throws -> JSONValue {
        let deltaX = request.int("deltaX", default: 0)
        let deltaY = request.int("deltaY", default: 0)
        let unit: CGScrollEventUnit = (request.string("unit") ?? "line") == "pixel" ? .pixel : .line
        let dryRun = request.bool("dryRun", default: false)
        let flags = try Mouse.flagMask(modifiers(request))
        guard deltaX != 0 || deltaY != 0 else {
            throw BridgeError.badRequest("scroll needs a non-zero 'deltaX' or 'deltaY'")
        }
        guard BackgroundOps.wantsBackground(request) else {
            return try Mouse.scroll(at: try point(request, aim: nil), deltaX: deltaX, deltaY: deltaY,
                                    unit: unit, flags: flags, dryRun: dryRun)
        }

        let aim = try BackgroundOps.aim(request)
        let target = try point(request, aim: aim)
        let extra: [String: JSONValue] = [
            "deltaX": .int(deltaX), "deltaY": .int(deltaY),
            "unit": .string(unit == .pixel ? "pixel" : "line")
        ]
        if dryRun {
            let report = try BackgroundInput.probe(target: aim.target, screenPoint: target, fields: aim.fields)
            return .object(["ok": .bool(true), "dryRun": .bool(true),
                            "plan": plan(aim: aim, point: target, flags: flags, addressing: report,
                                         events: ["scrollWheel"], extra: extra)])
        }
        return try Invariants.around {
            let report = try BackgroundInput.scroll(target: aim.target, screenPoint: target,
                                                    deltaX: deltaX, deltaY: deltaY, unit: unit,
                                                    flags: flags, fields: aim.fields)
            return .object(["ok": .bool(true),
                            "plan": plan(aim: aim, point: target, flags: flags, addressing: report,
                                         events: ["scrollWheel"], extra: extra)])
        }
    }

    // MARK: - Shared

    private static func explicitPoint(_ request: Request) -> CGPoint? {
        guard let x = request.params["x"]?.doubleValue, let y = request.params["y"]?.doubleValue else { return nil }
        return CGPoint(x: x, y: y)
    }

    /// A scroll needs somewhere to point: an element, an explicit point, or — for a
    /// background scroll, where the window is already known — the middle of the window.
    private static func point(_ request: Request, aim: Aim?) throws -> CGPoint {
        if let nodeId = request.params["nodeId"]?.intValue {
            return try Mouse.center(of: AXElement(try ElementRegistry.current.element(for: nodeId)))
        }
        if let explicit = explicitPoint(request) { return explicit }
        if let frame = aim?.target.frame { return CGPoint(x: frame.midX, y: frame.midY) }
        throw BridgeError.badRequest("scroll needs 'nodeId', or both 'x' and 'y', or a window whose frame is known")
    }

    private typealias Aim = BackgroundOps.Aim

    private static func button(_ request: Request) throws -> BackgroundInput.ButtonSpec {
        let name = (request.string("button") ?? "left").lowercased()
        guard let spec = BackgroundInput.buttons[name] else {
            throw BridgeError.badRequest("unknown mouse button '\(name)' (left|right|center)")
        }
        return spec
    }

    private static func modifiers(_ request: Request) -> [String] {
        (request.params["modifiers"]?.arrayValue ?? []).compactMap { $0.stringValue }
    }

    private static func plan(aim: Aim, point: CGPoint?, flags: CGEventFlags, addressing: AddressingReport,
                             events: [String], extra: [String: JSONValue]) -> JSONValue {
        var out: [String: JSONValue] = [
            "route": .string("background"),
            "target": .string("postToPid(\(aim.target.pid))"),
            "window": aim.target.json,
            "flags": .int(Int(flags.rawValue)),
            "addressing": addressing.json,
            "events": .array(events.map { .string($0) })
        ]
        if let point = point { out["x"] = .double(point.x); out["y"] = .double(point.y) }
        if let session = aim.session { out["session"] = .int(session.id) }
        for (key, value) in extra { out[key] = value }
        return .object(out)
    }
}
