import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// Handlers for the background-driving operations, and the target resolution every one of
/// them shares.
enum BackgroundOps {
    /// A resolved place to aim: which process, which window, with which fields.
    struct Aim {
        let session: BackgroundSession?
        let target: BackgroundTarget
        let fields: DispatchFields
        let window: ResolvedWindow?
    }

    // MARK: - Resolution

    /// Background dispatch is chosen when asked for explicitly, and by default whenever a
    /// session or a window number is supplied — those parameters have no meaning to the
    /// foreground path. `background: false` always wins, so a caller can pass a window
    /// number for the record and still use the cursor.
    static func wantsBackground(_ request: Request) -> Bool {
        if let explicit = request.params["background"]?.boolValue { return explicit }
        return request.params["session"] != nil || request.params["windowNumber"] != nil
    }

    /// Resolves the target from a session, an explicit window number, or the accessibility
    /// window list — in that order.
    ///
    /// An explicit window number deliberately does not require accessibility. That is the
    /// path that still works while the screen is locked, and refusing to use it there
    /// would give up the one capability a lock leaves standing.
    static func aim(_ request: Request) throws -> Aim {
        if let sessionId = request.params["session"]?.intValue {
            let session = try SessionRegistry.shared.session(for: sessionId)
            let fields = request.params["fields"].map { DispatchFields.parse($0) } ?? session.fields
            guard let override = request.params["windowNumber"]?.intValue, override != session.windowNumber else {
                return Aim(session: session, target: session.target, fields: fields, window: nil)
            }
            let target = BackgroundTarget(pid: session.pid, windowNumber: override,
                                          frame: frame(pid: session.pid, windowNumber: override))
            return Aim(session: session, target: target, fields: fields, window: nil)
        }

        let pid = try Processes.requirePid(request.requireInt("pid"))
        let fields = DispatchFields.parse(request.params["fields"])
        let resolved = try target(pid: pid, windowNumber: request.params["windowNumber"]?.intValue,
                                  windowIndex: request.params["windowIndex"]?.intValue)
        return Aim(session: nil, target: resolved.0, fields: fields, window: resolved.1)
    }

    /// Frame for an explicitly numbered window when accessibility could not supply one.
    ///
    /// Only used to place `CGEventSetWindowLocation`, which is optional — so a missing
    /// frame degrades the call rather than failing it, and a wrong one is worse than none.
    ///
    /// The window server's bounds are trusted only for a window that is actually on
    /// screen. Measured twice: while the screen is locked a 520×300 window is reported as
    /// 122×97, and while the desktop is not compositing at all — a running screen saver
    /// does this with the session still unlocked — every window's bounds drift the same
    /// way. An off-screen window's bounds are not evidence of anything.
    static func frame(pid: pid_t, windowNumber: Int) -> CGRect? {
        guard let entry = WindowResolver.cgWindows(pid: pid).first(where: { $0.number == windowNumber }),
              entry.onScreen, !entry.bounds.isEmpty else { return nil }
        return entry.bounds
    }

    /// Where to aim, and the accessibility window behind it when there is one.
    ///
    /// An explicit window number is always honoured, and accessibility is consulted for it
    /// on a best-effort basis: matching the AX window is what lets a safe point be chosen
    /// from the tree and makes the frame trustworthy, but failing to match it is never
    /// fatal. That is the whole value of an explicit number — it keeps working when a
    /// locked screen, or a screen saver that looks nothing like one, takes accessibility
    /// windows away from every application at once.
    static func target(pid: pid_t, windowNumber: Int?, windowIndex: Int?) throws -> (BackgroundTarget, ResolvedWindow?) {
        guard let number = windowNumber else {
            let window = try WindowResolver.select(pid: pid, windowNumber: nil, windowIndex: windowIndex)
            guard window.addressable else {
                throw BridgeError(code: "NO_WINDOW",
                                  message: "pid \(pid) window \(window.index) has no resolvable window number; "
                                      + "without one a background event has nowhere to go")
            }
            return (BackgroundTarget(pid: pid, windowNumber: window.windowNumber, frame: window.frame), window)
        }
        if let all = try? WindowResolver.windows(pid: pid),
           let hit = all.first(where: { $0.windowNumber == number }) {
            return (BackgroundTarget(pid: pid, windowNumber: number, frame: hit.frame), hit)
        }
        return (BackgroundTarget(pid: pid, windowNumber: number, frame: frame(pid: pid, windowNumber: number)), nil)
    }

    static func point(_ value: JSONValue?) -> CGPoint? {
        guard let object = value?.objectValue,
              let x = object["x"]?.doubleValue, let y = object["y"]?.doubleValue else { return nil }
        return CGPoint(x: x, y: y)
    }

    // MARK: - windowInfo

    /// The diagnostic op. It answers even when nothing else can, because the state it
    /// describes is exactly the state a caller is trying to understand — throwing here
    /// would withhold the evidence at the only moment anybody wants it. The classification
    /// that other ops raise as an error arrives as the `diagnosis` field instead.
    static func windowInfo(_ request: Request) throws -> JSONValue {
        let pid = try Processes.requirePid(request.requireInt("pid"))
        var windows: [ResolvedWindow] = []
        var diagnosis: JSONValue = .object(["code": .string("OK")])
        do {
            windows = try WindowResolver.windows(pid: pid)
            diagnosis = .object(["code": .string("OK")])
        } catch let error as BridgeError {
            var payload: [String: JSONValue] = ["code": .string(error.code), "message": .string(error.message)]
            if let details = error.details { payload["details"] = details }
            diagnosis = .object(payload)
        }
        let server = WindowResolver.cgWindows(pid: pid)
        let desktop = WindowResolver.desktopCensus()
        return .object([
            "pid": .int(Int(pid)),
            "windows": .array(windows.map { $0.json }),
            "diagnosis": diagnosis,
            "addressable": .int(windows.filter { $0.addressable }.count),
            "windowServer": .object([
                "total": .int(server.count),
                "onScreen": .int(server.filter { $0.onScreen }.count)
            ]),
            // Whole-machine drawing state. An app with no on-screen window when the
            // desktop is busy is that app's problem; the same reading when nothing else is
            // on screen either means the desktop is not compositing and no application can
            // be addressed until it is.
            "desktop": .object([
                "onScreenWindows": .int(desktop.windows),
                "onScreenOwners": .int(desktop.owners)
            ]),
            "spi": SPI.report,
            "screen": ScreenLock.report
        ])
    }

    // MARK: - awaitTree

    static func awaitTree(_ request: Request) throws -> JSONValue {
        let pid = try Processes.requirePid(request.requireInt("pid"))
        let app = AXElement.application(pid: pid)
        try ScreenLock.requireAddressable(app: app)
        return try TreeReadiness.poll(app: app,
                                      windowIndex: request.params["windowIndex"]?.intValue,
                                      timeoutMs: min(30_000, max(0, request.int("timeoutMs", default: 3_000))),
                                      pollMs: max(10, request.int("pollMs", default: 120)),
                                      maxNodes: request.int("maxNodes", default: 20_000),
                                      maxDepth: request.int("maxDepth", default: 60))
    }

    // MARK: - activate

    static func activate(_ request: Request) throws -> JSONValue {
        let pid = try Processes.requirePid(request.requireInt("pid"))
        let fields = DispatchFields.parse(request.params["fields"])
        let resolved = try target(pid: pid, windowNumber: request.params["windowNumber"]?.intValue,
                                  windowIndex: request.params["windowIndex"]?.intValue)
        return try Invariants.around {
            try BackgroundActivation.activate(target: resolved.0, element: resolved.1?.element,
                                              point: point(request.params["safePoint"]), fields: fields)
        }
    }

    // MARK: - bgSession / bgRelease

    static func bgSession(_ request: Request) throws -> JSONValue {
        let pid = try Processes.requirePid(request.requireInt("pid"))
        let resolved = try target(pid: pid, windowNumber: request.params["windowNumber"]?.intValue,
                                  windowIndex: request.params["windowIndex"]?.intValue)
        let previous = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let suppressor = try makeSuppressor(request, pid: pid, previous: previous)
        let session = BackgroundSession(id: SessionRegistry.shared.allocate(), pid: pid,
                                        windowNumber: resolved.0.windowNumber, frame: resolved.0.frame,
                                        fields: DispatchFields.parse(request.params["fields"]),
                                        previousPID: previous, suppressor: suppressor)
        SessionRegistry.shared.store(session)

        return try Invariants.around {
            if request.bool("activate", default: false) {
                session.recordActivation(
                    try BackgroundActivation.activate(target: resolved.0, element: resolved.1?.element,
                                                      point: point(request.params["safePoint"]),
                                                      fields: session.fields))
            }
            return session.json
        }
    }

    /// Off unless asked for. Measured: with no tap installed at all, activating a
    /// background window left the frontmost application unchanged — including with a real
    /// user application in front. Installing a tap on somebody else's process is not free,
    /// so it is not done on a hypothesis.
    private static func makeSuppressor(_ request: Request, pid: pid_t,
                                       previous: pid_t?) throws -> FocusSuppressor? {
        guard request.bool("suppressFocus", default: false) else { return nil }
        let types = request.params["dropTypes"]?.arrayValue?.compactMap { $0.intValue }.map { UInt32($0) }
        let suppressor = FocusSuppressor(targetPID: pid, previousPID: previous,
                                         dropTypes: types.map { Set($0) } ?? FocusSuppressor.defaultDropTypes)
        try suppressor.install()
        return suppressor
    }

    static func bgRelease(_ request: Request) throws -> JSONValue {
        let id = try request.requireInt("session")
        let session = try SessionRegistry.shared.session(for: id)
        let report = session.release(restoreFocus: request.bool("restore", default: true))
        SessionRegistry.shared.remove(id)
        return report
    }

    // MARK: - focusAndType

    static func focusAndType(_ request: Request) throws -> JSONValue {
        let nodeId = try request.requireInt("nodeId")
        let element = AXElement(try ElementRegistry.shared.element(for: nodeId))
        let text = try request.requireString("text")
        let aim = try aim(request)
        let dryRun = request.bool("dryRun", default: false)

        if !dryRun, request.bool("activate", default: false) {
            _ = try BackgroundActivation.activate(target: aim.target, element: aim.window?.element,
                                                  point: point(request.params["safePoint"]), fields: aim.fields)
        }

        let perCharacter = UInt32(max(0, request.int("perCharacterMs", default: 4)) * 1000)
        let strategy = try FocusStrategy.parse(request.string("focusVia"))
        let body = {
            try HybridInput.focusAndType(element: element, nodeId: nodeId, text: text, target: aim.target,
                                         focusAction: request.string("focusAction") ?? kAXPressAction,
                                         strategy: strategy, fields: aim.fields,
                                         perCharacterMicroseconds: perCharacter, dryRun: dryRun)
        }
        return dryRun ? try body() : try Invariants.around(body)
    }
}
