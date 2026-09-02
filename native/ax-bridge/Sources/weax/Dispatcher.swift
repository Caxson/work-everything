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
        "keystroke", "click", "scroll", "observe", "unobserve", "windows",
        "windowInfo", "awaitTree", "activate", "bgSession", "bgRelease", "focusAndType"
    ]

    /// Ops that cannot produce a correct answer while the screen is locked, because
    /// accessibility substitutes the application element for every window and reports
    /// success the whole way down.
    ///
    /// Dispatch that was *given* a window number is deliberately absent from this set. The
    /// event channel survives a lock — a click posted to a pid with fields 51/58 still
    /// lands — and that is the only capability a locked screen leaves standing. Refusing
    /// it here would cost the one thing that still works and protect nobody. What is
    /// gated is everything that has to *find* a window or an element first.
    private static let lockSensitive: Set<String> = [
        "windows", "windowInfo", "tree", "find", "awaitTree",
        "activate", "bgSession", "focusAndType",
        "attr", "setValue", "press", "focus"
    ]

    /// The one op that ends a client rather than answering for it.
    static let shutdownOp = "shutdown"

    static func handle(_ request: Request) {
        do {
            if trustRequired.contains(request.op), !AXIsProcessTrusted() {
                throw BridgeError.notTrusted()
            }
            if lockSensitive.contains(request.op) { try ScreenLock.requireUnlocked() }
            let result = try run(request)
            Output.current.success(id: request.id, result: result)
        } catch let error as BridgeError {
            Output.current.failure(id: request.id, error: error)
        } catch {
            Output.current.failure(id: request.id,
                                  error: BridgeError(code: "INTERNAL", message: String(describing: error)))
        }
        // `shutdown` releases the client *after* its acknowledgement is on the wire; closing
        // first would drop the reply the caller is waiting on. On stdio that ends the
        // process, as it always has. On a socket it ends one client and leaves the service
        // running for everybody else — a resident bridge that any single caller could stop
        // would be a resident bridge in name only.
        if request.op == shutdownOp { Connection.current.close() }
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
        case "keystroke": return try InputOps.keystroke(request)
        case "click": return try InputOps.click(request)
        case "scroll": return try InputOps.scroll(request)
        case "observe": return try observe(request)
        case "unobserve": return try ObserverRegistry.current.unobserve(id: request.requireInt("subscription"))
        case "windowInfo": return try BackgroundOps.windowInfo(request)
        case "awaitTree": return try BackgroundOps.awaitTree(request)
        case "activate": return try BackgroundOps.activate(request)
        case "bgSession": return try BackgroundOps.bgSession(request)
        case "bgRelease": return try BackgroundOps.bgRelease(request)
        case "focusAndType": return try BackgroundOps.focusAndType(request)
        case "env": return env()
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

    /// Resolves an application element and refuses the two states that answer plausibly
    /// and wrongly: a locked screen, and a window list that has been substituted.
    private static func app(_ request: Request) throws -> AXElement {
        let app = AXElement.application(pid: try Processes.requirePid(request.requireInt("pid")))
        try ScreenLock.requireAddressable(app: app)
        return app
    }

    private static func env() -> JSONValue {
        let now = Invariants.snapshot()
        return .object([
            "trusted": .bool(AXIsProcessTrusted()),
            // The pointer's current position, so a caller can measure how much it drifts
            // on its own and judge an op's `cursorDelta` against that rather than against
            // zero. Somebody using the machine moves the mouse; we never do.
            "cursor": .object(["x": .double(now.cursor.x), "y": .double(now.cursor.y)]),
            "frontmost": .string(now.frontmostName),
            "spi": SPI.report,
            "screen": ScreenLock.report,
            "sessions": .int(SessionRegistry.current.count),
            "nodes": .int(ElementRegistry.current.count),
            // Which client is being answered, and over what. Both counts above are that
            // client's own: on a socket the bridge serves several at once, and a caller
            // reading a total it did not create would be reading somebody else's work.
            "connection": .int(Connection.current.id),
            "transport": .string(Connection.current.transport)
        ])
    }

    /// Windows, with the reason attached when there are none.
    ///
    /// The bare-array form throws instead of answering `[]`, because an empty array is the
    /// one answer that reads the same in all three failing states and sends a caller into
    /// a retry loop against two of them it cannot fix. `meta: true` returns the envelope
    /// with the classification in it instead of throwing, for a caller that would rather
    /// branch than catch. Neither form can return an unexplained empty list.
    private static func windows(_ request: Request) throws -> JSONValue {
        let pid = try Processes.requirePid(request.requireInt("pid"))
        guard request.bool("meta", default: false) else {
            return .array(try WindowResolver.windows(pid: pid).map { node(for: $0) })
        }
        do {
            let resolved = try WindowResolver.windows(pid: pid)
            return .object([
                "windows": .array(resolved.map { node(for: $0) }),
                "diagnosis": .object(["code": .string("OK"), "addressable":
                    .int(resolved.filter { $0.addressable }.count)])
            ])
        } catch let error as BridgeError {
            var diagnosis: [String: JSONValue] = ["code": .string(error.code), "message": .string(error.message)]
            if let details = error.details { diagnosis["details"] = details }
            return .object(["windows": .array([]), "diagnosis": .object(diagnosis)])
        }
    }

    /// The historical node shape, plus the addressing facts a background caller needs.
    private static func node(for window: ResolvedWindow) -> JSONValue {
        var node = NodeBuilder.describe(window.element)
        node["index"] = .int(window.index)
        node["windowNumber"] = .int(window.windowNumber)
        node["resolvedBy"] = .string(window.resolvedBy)
        // Not decoration: anything other than `AXWindows` means that attribute was empty
        // and this is the single window the singular attributes could still name, so a
        // caller wanting every window of the application did not get them.
        node["listedBy"] = .string(window.listedBy)
        node["addressable"] = .bool(window.addressable)
        return .object(node)
    }

    private static func tree(_ request: Request) throws -> JSONValue {
        let app = try app(request)
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
        let app = try app(request)
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
        let element = AXElement(try ElementRegistry.current.element(for: request.requireInt("nodeId")))
        let name = try request.requireString("name")
        // Pseudo-attribute: enumerate what this element actually exposes.
        if name == "AXAttributeNames" { return attributeNames(element) }
        let raw = try element.copyChecked(name)
        return JSONCoercion.toJSON(raw, truncate: false)
    }

    private static func attributeNames(_ element: AXElement) -> JSONValue {
        .array(element.attributeNames().map { .string($0) })
    }

    private static func observe(_ request: Request) throws -> JSONValue {
        let pid = try Processes.requirePid(request.requireInt("pid"))
        let element: AXUIElement
        if let nodeId = request.params["nodeId"]?.intValue {
            element = try ElementRegistry.current.element(for: nodeId)
        } else {
            element = AXElement.application(pid: pid).ref
        }
        guard let names = try request.require("notifications").arrayValue?.compactMap({ $0.stringValue }) else {
            throw BridgeError.badRequest("'notifications' must be an array of strings")
        }
        return try ObserverRegistry.current.observe(pid: pid, element: element, notifications: names)
    }

    /// Answers, and lets `handle` do the releasing once the answer has been written. The
    /// teardown itself lives in `Connection.close`, which every other way of losing a
    /// client also goes through — a dropped socket and a closed stdin must not release
    /// less than an explicit `shutdown` does.
    private static func shutdown(_ request: Request) -> JSONValue {
        .object(["ok": .bool(true)])
    }
}
