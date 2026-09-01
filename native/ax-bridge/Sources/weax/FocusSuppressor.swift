import CoreGraphics
import Foundation

/// A dedicated run loop for event taps.
///
/// A tap's callback must be serviced promptly or the system disables it. The bridge's
/// main run loop is where every op runs, and ops block it — a tree dump on an Electron
/// app for hundreds of milliseconds, a poll for a web area for seconds. Taps get their
/// own thread so that cannot starve them.
final class TapRunLoop {
    static let shared = TapRunLoop()

    private var runLoop: CFRunLoop?
    private let ready = DispatchSemaphore(value: 0)

    private init() {
        let thread = Thread { [self] in
            // A timer with no work keeps the run loop from returning immediately when it
            // has no sources yet.
            RunLoop.current.add(Timer(timeInterval: 3600, repeats: true) { _ in }, forMode: .common)
            runLoop = CFRunLoopGetCurrent()
            ready.signal()
            RunLoop.current.run()
        }
        thread.name = "we-ax.tap"
        thread.qualityOfService = .userInteractive
        thread.start()
        ready.wait()
    }

    func add(_ source: CFRunLoopSource) {
        guard let runLoop = runLoop else { return }
        CFRunLoopAddSource(runLoop, source, .commonModes)
        CFRunLoopWakeUp(runLoop)
    }
}

/// Optional layer that drops the focus-change messages an activation would otherwise send
/// to the application the person is using.
///
/// **Off by default, because measurement says it is not needed.** With no tap installed
/// at all, a background activation left the frontmost application unchanged — twice, once
/// against a real user application in the foreground. The layer is kept because it is
/// cheap to have and impossible to add later under pressure, and because the measurement
/// covers the applications that were measured, not every application.
///
/// Turning it on installs a per-pid tap on somebody else's process. That is a real cost:
/// a tap that stalls gets disabled by the system, and a tap on the wrong process would
/// interfere with the person's own typing. It is opt-in for that reason.
final class FocusSuppressor {
    enum Side: String { case previous, target }

    /// `appKitDefined` — the carrier for activation and deactivation messages. Measured as
    /// type 13; 19 and 20 appear in the reference implementation and were never observed
    /// here, so they are included in the mask and left out of the default drop set.
    static let appKitDefined: UInt32 = 13
    static let defaultDropTypes: Set<UInt32> = [appKitDefined]
    static let defaultMask: CGEventMask = (1 << 13) | (1 << 19) | (1 << 20)

    let targetPID: pid_t
    let previousPID: pid_t?
    let dropTypes: Set<UInt32>
    let mask: CGEventMask

    private let lock = NSLock()
    private var seen: [String: [UInt32: Int]] = [:]
    private var dropped: [String: [UInt32: Int]] = [:]
    private var reEnables = 0
    private var disabledByTimeout = 0
    private var disabledByUserInput = 0
    private var suppressing = true
    private var taps: [CFMachPort] = []
    private var contexts: [FocusSuppressorContext] = []
    private(set) var installed: [String] = []

    init(targetPID: pid_t, previousPID: pid_t?,
         dropTypes: Set<UInt32> = FocusSuppressor.defaultDropTypes,
         mask: CGEventMask = FocusSuppressor.defaultMask) {
        self.targetPID = targetPID
        self.previousPID = previousPID
        self.dropTypes = dropTypes
        self.mask = mask
    }

    /// Installs on the previous application (whose focus is being defended) and on the
    /// target (for diagnosis only — nothing is dropped there).
    func install() throws {
        guard let previous = previousPID, previous != targetPID else { return }
        try install(side: .previous, pid: previous)
        try install(side: .target, pid: targetPID)
    }

    private func install(side: Side, pid: pid_t) throws {
        let context = FocusSuppressorContext(suppressor: self, side: side)
        guard let tap = CGEvent.tapCreateForPid(
            pid: pid, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask,
            callback: focusTapCallback, userInfo: Unmanaged.passUnretained(context).toOpaque()
        ) else {
            throw BridgeError(code: "TAP_FAILED",
                              message: "could not create an event tap on pid \(pid) (\(side.rawValue))")
        }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap)
            throw BridgeError(code: "TAP_FAILED",
                              message: "could not create a run loop source for the tap on pid \(pid)")
        }
        context.tap = tap
        contexts.append(context)
        taps.append(tap)
        TapRunLoop.shared.add(source)
        CGEvent.tapEnable(tap: tap, enable: true)
        installed.append("\(side.rawValue):\(pid)")
    }

    fileprivate func shouldDrop(side: Side, type: CGEventType) -> Bool {
        guard side == .previous, dropTypes.contains(type.rawValue) else { return false }
        lock.lock()
        defer { lock.unlock() }
        return suppressing
    }

    fileprivate func note(side: Side, type: UInt32, dropped isDropped: Bool) {
        lock.lock()
        defer { lock.unlock() }
        seen[side.rawValue, default: [:]][type, default: 0] += 1
        if isDropped { dropped[side.rawValue, default: [:]][type, default: 0] += 1 }
    }

    /// The system disables a tap that took too long or that the user interrupted, and it
    /// stays disabled until something re-enables it. Silence here reads exactly like a
    /// tap that has nothing to do.
    fileprivate func reEnable(_ tap: CFMachPort?, timeout: Bool) {
        lock.lock()
        if timeout { disabledByTimeout += 1 } else { disabledByUserInput += 1 }
        reEnables += 1
        lock.unlock()
        if let tap = tap { CGEvent.tapEnable(tap: tap, enable: true) }
    }

    /// Stops dropping and tears the taps down. Safe to call twice.
    func finish() {
        lock.lock()
        suppressing = false
        lock.unlock()
        for tap in taps {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
        }
        taps.removeAll()
        contexts.removeAll()
    }

    var stats: JSONValue {
        lock.lock()
        defer { lock.unlock() }
        func flatten(_ table: [String: [UInt32: Int]]) -> JSONValue {
            .object(table.mapValues { inner in
                JSONValue.object(Dictionary(uniqueKeysWithValues: inner.map { (String($0.key), JSONValue.int($0.value)) }))
            })
        }
        return .object([
            "installed": .array(installed.map { .string($0) }),
            "dropTypes": .array(dropTypes.sorted().map { .int(Int($0)) }),
            "seen": flatten(seen),
            "dropped": flatten(dropped),
            "reEnables": .int(reEnables),
            "disabledByTimeout": .int(disabledByTimeout),
            "disabledByUserInput": .int(disabledByUserInput)
        ])
    }
}

/// What the C callback is handed: which suppressor, which side, and the tap itself so a
/// disabled tap can re-enable the port it arrived on.
fileprivate final class FocusSuppressorContext {
    let suppressor: FocusSuppressor
    let side: FocusSuppressor.Side
    var tap: CFMachPort?

    init(suppressor: FocusSuppressor, side: FocusSuppressor.Side) {
        self.suppressor = suppressor
        self.side = side
    }

    func handle(type: CGEventType) -> Bool {
        let drop = suppressor.shouldDrop(side: side, type: type)
        suppressor.note(side: side, type: type.rawValue, dropped: drop)
        return drop
    }

    func handleDisabled(timeout: Bool) {
        suppressor.reEnable(tap, timeout: timeout)
    }
}

/// Runs on the tap thread. Keeps to lock-guarded counters and one boolean — anything
/// heavier here is what gets a tap disabled for taking too long.
private let focusTapCallback: CGEventTapCallBack = { _, type, event, userInfo in
    guard let userInfo = userInfo else { return Unmanaged.passUnretained(event) }
    let context = Unmanaged<FocusSuppressorContext>.fromOpaque(userInfo).takeUnretainedValue()
    if type == .tapDisabledByTimeout {
        context.handleDisabled(timeout: true)
        return nil
    }
    if type == .tapDisabledByUserInput {
        context.handleDisabled(timeout: false)
        return nil
    }
    return context.handle(type: type) ? nil : Unmanaged.passUnretained(event)
}
