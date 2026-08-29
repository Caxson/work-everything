import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// Routes one request to one handler. Runs entirely on the main thread so the element
/// registry, observer registry and AX run loop sources need no locking.
enum Dispatcher {
    /// Ops that touch the Accessibility API and therefore need TCC approval.
    private static let trustRequired: Set<String> = [
        "enableAX", "tree", "find", "attr", "setValue", "press", "focus",
        "keystroke", "click", "observe", "unobserve", "windows"
    ]

    static func handle(_ request: Request) {
        do {
            if trustRequired.contains(request.op), !AXIsProcessTrusted() {
                throw BridgeError.notTrusted()
            }
            let result = try run(request)
            Output.shared.success(id: request.id, result: result)
        } catch let error as BridgeError {
            Output.shared.failure(id: request.id, error: error)
        } catch {
            Output.shared.failure(id: request.id,
                                  error: BridgeError(code: "INTERNAL", message: String(describing: error)))
        }
    }

    private static func run(_ request: Request) throws -> JSONValue {
        switch request.op {
        case "trusted": return trusted(request)
        case "apps": return apps()
        case "enableAX": return Actions.enableAX(pid: try Processes.requirePid(request.requireInt("pid")))
        case "windows": return try windows(request)
        case "tree": return try tree(request)
        case "find": return try find(request)
        case "attr": return try attr(request)
        case "setValue": return try Actions.setValue(nodeId: request.requireInt("nodeId"),
                                                     value: request.require("value"))
        case "press": return try Actions.press(nodeId: request.requireInt("nodeId"),
                                               action: request.string("action") ?? kAXPressAction)
        case "focus": return try Actions.focus(nodeId: request.requireInt("nodeId"))
        case "keystroke": return try keystroke(request)
        case "click": return try click(request)
        case "observe": return try observe(request)
        case "unobserve": return try ObserverRegistry.shared.unobserve(id: request.requireInt("subscription"))
        case "shutdown": return shutdown(request)
        default: throw BridgeError.unknownOp(request.op)
        }
    }

    // MARK: - Handlers

    private static func trusted(_ request: Request) -> JSONValue {
        let prompt = request.bool("prompt", default: false)
        let value: Bool
        if prompt {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            value = AXIsProcessTrustedWithOptions(options)
        } else {
            value = AXIsProcessTrusted()
        }
        return .object([
            "trusted": .bool(value),
            "executable": .string(Bundle.main.executablePath ?? ProcessInfo.processInfo.arguments.first ?? "")
        ])
    }

    private static func apps() -> JSONValue {
        let list = Processes.guiApps().map { app -> JSONValue in
            .object([
                "pid": .int(Int(app.processIdentifier)),
                "name": .string(app.localizedName ?? ""),
                "bundleId": app.bundleIdentifier.map { JSONValue.string($0) } ?? .null,
                "activationPolicy": .string(app.activationPolicy == .regular ? "regular" : "accessory")
            ])
        }
        return .array(list)
    }

    private static func windows(_ request: Request) throws -> JSONValue {
        let app = AXElement.application(pid: try Processes.requirePid(request.requireInt("pid")))
        let list = TreeDumper.windowList(app: app).enumerated().map { index, window -> JSONValue in
            var node = NodeBuilder.describe(window)
            node["index"] = .int(index)
            return .object(node)
        }
        return .array(list)
    }

    private static func tree(_ request: Request) throws -> JSONValue {
        let app = AXElement.application(pid: try Processes.requirePid(request.requireInt("pid")))
        let roots = try TreeDumper.roots(app: app, windowIndex: request.params["windowIndex"]?.intValue)
        var dumper = TreeDumper(maxDepth: request.int("maxDepth", default: 12),
                                maxNodes: request.int("maxNodes", default: 5_000))
        let started = Date()
        let nodes = roots.map { dumper.dump($0) }
        // Protocol default: the result IS the node array. `meta: true` opts into an
        // envelope with traversal statistics for diagnostics.
        guard request.bool("meta", default: false) else { return .array(nodes) }
        return .object([
            "nodes": .array(nodes),
            "nodeCount": .int(dumper.visited),
            "truncated": .bool(dumper.truncated),
            "elapsedMs": .int(Int(Date().timeIntervalSince(started) * 1000))
        ])
    }

    private static func find(_ request: Request) throws -> JSONValue {
        let app = AXElement.application(pid: try Processes.requirePid(request.requireInt("pid")))
        let roots = try TreeDumper.roots(app: app, windowIndex: request.params["windowIndex"]?.intValue)
        let selector = try Selector.parse(request.require("selector"))
        let finder = Finder(selector: selector,
                            maxDepth: request.int("maxDepth", default: 60),
                            maxVisits: request.int("maxNodes", default: 30_000))
        let started = Date()
        let outcome = finder.run(roots: roots)
        guard request.bool("meta", default: false) else { return .array(outcome.matches) }
        return .object([
            "nodes": .array(outcome.matches),
            "visited": .int(outcome.visited),
            "truncated": .bool(outcome.truncated),
            "elapsedMs": .int(Int(Date().timeIntervalSince(started) * 1000))
        ])
    }

    private static func attr(_ request: Request) throws -> JSONValue {
        let element = AXElement(try ElementRegistry.shared.element(for: request.requireInt("nodeId")))
        let name = try request.requireString("name")
        // Pseudo-attribute: enumerate what this element actually exposes.
        if name == "AXAttributeNames" { return attributeNames(element) }
        let raw = try element.copyChecked(name)
        return JSONCoercion.toJSON(raw, truncate: false)
    }

    private static func attributeNames(_ element: AXElement) -> JSONValue {
        var names: CFArray?
        AXUIElementCopyAttributeNames(element.ref, &names)
        let list = (names as? [String]) ?? []
        return .array(list.map { .string($0) })
    }

    private static func keystroke(_ request: Request) throws -> JSONValue {
        let pid = try Processes.requirePid(request.requireInt("pid"))
        return try Actions.keystroke(pid: pid,
                                     key: try request.requireString("key"),
                                     modifiers: modifierList(request),
                                     dryRun: request.bool("dryRun", default: false))
    }

    /// Click target: an explicit screen point, or the centre of a node's frame.
    private static func click(_ request: Request) throws -> JSONValue {
        let point: CGPoint
        if let nodeId = request.params["nodeId"]?.intValue {
            point = try Mouse.center(of: AXElement(try ElementRegistry.shared.element(for: nodeId)))
        } else if let x = request.params["x"]?.doubleValue, let y = request.params["y"]?.doubleValue {
            point = CGPoint(x: x, y: y)
        } else {
            throw BridgeError.badRequest("click needs either 'nodeId' or both 'x' and 'y'")
        }
        return try Mouse.click(at: point,
                               button: request.string("button") ?? "left",
                               clickCount: request.int("clickCount", default: 1),
                               modifiers: modifierList(request),
                               dryRun: request.bool("dryRun", default: false))
    }

    private static func modifierList(_ request: Request) -> [String] {
        (request.params["modifiers"]?.arrayValue ?? []).compactMap { $0.stringValue }
    }

    private static func observe(_ request: Request) throws -> JSONValue {
        let pid = try Processes.requirePid(request.requireInt("pid"))
        let element: AXUIElement
        if let nodeId = request.params["nodeId"]?.intValue {
            element = try ElementRegistry.shared.element(for: nodeId)
        } else {
            element = AXElement.application(pid: pid).ref
        }
        guard let names = try request.require("notifications").arrayValue?.compactMap({ $0.stringValue }) else {
            throw BridgeError.badRequest("'notifications' must be an array of strings")
        }
        return try ObserverRegistry.shared.observe(pid: pid, element: element, notifications: names)
    }

    private static func shutdown(_ request: Request) -> JSONValue {
        Output.shared.success(id: request.id, result: .object(["ok": .bool(true)]))
        ObserverRegistry.shared.teardownAll()
        exit(0)
    }
}
