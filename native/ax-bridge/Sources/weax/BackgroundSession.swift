import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// Making a background window key without putting its application in front.
///
/// Two steps, and both are needed (measured):
///
/// 1. An `appKitDefined` event with subtype 1 posted to the pid. This gets the
///    application to `NSApp.isActive == true` and nothing further — every window stays
///    `isKeyWindow == false`.
/// 2. One real click inside the window. This is what makes that particular window key and
///    main. There is no substitute; sending only step 1 leaves key and main where they
///    were.
///
/// Subtype 2 is **not** a third step. It is the opposite: a way to hand focus back when
/// the session ends. Posting it as part of activation undoes the activation.
///
/// The result is a state that reads as a contradiction and is exactly what background
/// driving means: the target reports `isActive`, `isKeyWindow` and `isMainWindow` true
/// while the frontmost application it can see is somebody else's.
enum BackgroundActivation {
    private static let primerSettleMicroseconds: UInt32 = 20_000

    /// Step 1. Carries 51/58 and deliberately not 40 — this is the shape that was
    /// measured to work.
    @discardableResult
    static func postPrimer(pid: pid_t, windowNumber: Int, subtype: Int16) -> Bool {
        guard windowNumber != 0 else { return false }
        guard let event = NSEvent.otherEvent(with: .appKitDefined, location: .zero, modifierFlags: [],
                                             timestamp: ProcessInfo.processInfo.systemUptime,
                                             windowNumber: windowNumber, context: nil,
                                             subtype: subtype, data1: 0, data2: 0)?.cgEvent else { return false }
        event.applyPrivateWindowFields(windowNumber: windowNumber)
        event.postToPid(pid)
        usleep(primerSettleMicroseconds)
        return true
    }

    /// Steps 1 and 2.
    ///
    /// `point` is a screen point inside the window. When it is nil one is chosen by
    /// clearance from the window's own accessibility subtree, and a window with nowhere
    /// safe to click fails rather than pressing something.
    ///
    /// `element` is that subtree, and it is optional. Without it — a window reached by
    /// number while accessibility exposes nothing, which is what a locked screen or a
    /// running screen saver leaves — the caller has to say where to click, because there
    /// is no way to find out what is under a point and guessing would press whatever is
    /// there.
    static func activate(target: BackgroundTarget, element: AXElement?, point: CGPoint?,
                         fields: DispatchFields) throws -> JSONValue {
        guard target.windowNumber != 0 else {
            throw BridgeError(code: "NO_WINDOW",
                              message: "pid \(target.pid) window has no resolvable number, so it cannot be addressed")
        }
        let chosen = try choosePoint(target: target, element: element, point: point)
        let primed = postPrimer(pid: target.pid, windowNumber: target.windowNumber, subtype: 1)
        let addressing = try BackgroundInput.click(target: target, screenPoint: chosen.point,
                                                   button: BackgroundInput.buttons["left"]!,
                                                   clickCount: 1, flags: [], fields: fields)
        return .object([
            "windowNumber": .int(target.windowNumber),
            "primer": .object(["posted": .bool(primed), "subtype": .int(1)]),
            "safePoint": chosen.json,
            "addressing": addressing.json
        ])
    }

    private static func choosePoint(target: BackgroundTarget, element: AXElement?,
                                    point: CGPoint?) throws -> SafePoint.Choice {
        if let point = point {
            if let frame = target.frame, !Coords.contains(frame, point) {
                throw BridgeError.badRequest(
                    "safePoint (\(point.x), \(point.y)) is outside window \(target.windowNumber)")
            }
            return SafePoint.Choice(point: point, clearance: -1, region: "caller", obstacles: 0)
        }
        guard let element = element, let frame = target.frame else {
            throw BridgeError(
                code: "NO_SAFE_POINT",
                message: "window \(target.windowNumber) exposes no accessibility subtree to choose a safe point "
                    + "from, so activation needs an explicit 'safePoint'. A window addressed by number while "
                    + "accessibility is unavailable — a locked screen, or a screen saver with the session "
                    + "still unlocked — is always in this state",
                details: .object(["windowNumber": .int(target.windowNumber),
                                  "hasFrame": .bool(target.frame != nil),
                                  "hasElement": .bool(element != nil)]))
        }
        return try SafePoint.choose(window: element, frame: frame)
    }

    /// Hands focus back at the end of a session. Skipped when the target is frontmost —
    /// in that case the person is looking at it and taking focus away is the disruption.
    @discardableResult
    static func restore(pid: pid_t, windowNumber: Int) -> Bool {
        guard windowNumber != 0 else { return false }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier != pid else { return false }
        return postPrimer(pid: pid, windowNumber: windowNumber, subtype: 2)
    }
}

/// One background driving session: a resolved target, the options to reuse across ops,
/// and optionally the focus suppression layer.
///
/// A session is a convenience, not a requirement — every background op also accepts an
/// explicit `pid` and `windowNumber`. What it buys is not repeating the resolution, and
/// somewhere for the suppression layer and the restore to live.
final class BackgroundSession {
    let id: Int
    let pid: pid_t
    let windowNumber: Int
    let frame: CGRect?
    let fields: DispatchFields
    let previousPID: pid_t?
    let suppressor: FocusSuppressor?
    private(set) var activation: JSONValue?
    private(set) var released = false

    init(id: Int, pid: pid_t, windowNumber: Int, frame: CGRect?, fields: DispatchFields,
         previousPID: pid_t?, suppressor: FocusSuppressor?) {
        self.id = id
        self.pid = pid
        self.windowNumber = windowNumber
        self.frame = frame
        self.fields = fields
        self.previousPID = previousPID
        self.suppressor = suppressor
    }

    var target: BackgroundTarget { BackgroundTarget(pid: pid, windowNumber: windowNumber, frame: frame) }

    func recordActivation(_ report: JSONValue) { activation = report }

    func release(restoreFocus: Bool) -> JSONValue {
        let restored = restoreFocus && !released
            ? BackgroundActivation.restore(pid: pid, windowNumber: windowNumber)
            : false
        suppressor?.finish()
        released = true
        var out: [String: JSONValue] = [
            "session": .int(id),
            "released": .bool(true),
            "restored": .bool(restored)
        ]
        if let suppressor = suppressor { out["suppression"] = suppressor.stats }
        return .object(out)
    }

    var json: JSONValue {
        var out: [String: JSONValue] = [
            "session": .int(id),
            "pid": .int(Int(pid)),
            "windowNumber": .int(windowNumber),
            "suppression": suppressor?.stats ?? .null,
            "previousPID": previousPID.map { JSONValue.int(Int($0)) } ?? .null
        ]
        if let frame = frame {
            out["frame"] = .object(["x": .double(frame.minX), "y": .double(frame.minY),
                                    "w": .double(frame.width), "h": .double(frame.height)])
        }
        if let activation = activation { out["activation"] = activation }
        return .object(out)
    }
}

/// Main-thread confined, like `ElementRegistry` — every op is dispatched there, and one
/// registry belongs to one client (see `Connection`).
final class SessionRegistry {
    private var nextId = 1
    private var sessions: [Int: BackgroundSession] = [:]

    func allocate() -> Int {
        defer { nextId += 1 }
        return nextId
    }

    func store(_ session: BackgroundSession) { sessions[session.id] = session }

    func session(for id: Int) throws -> BackgroundSession {
        guard let session = sessions[id], !session.released else { throw BridgeError.noSuchSession(id) }
        return session
    }

    @discardableResult
    func remove(_ id: Int) -> BackgroundSession? { sessions.removeValue(forKey: id) }

    /// Called when a client goes away: a suppression tap outliving the connection that
    /// installed it would leave somebody else's application filtered.
    func releaseAll() {
        for session in sessions.values where !session.released {
            _ = session.release(restoreFocus: false)
        }
        sessions.removeAll()
    }

    var count: Int { sessions.count }
}
