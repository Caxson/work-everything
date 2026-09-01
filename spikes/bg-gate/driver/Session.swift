// 后台激活会话：专用 runloop 线程 + per-pid event tap（含 tapDisabled 自愈）+ 两步激活 + 复位
import AppKit
import CoreGraphics
import Foundation

// MARK: - 专用 runloop 线程（tap 回调绝不能挂主 runloop）

final class TapRunLoopThread {
    static let shared = TapRunLoopThread()
    private var runLoop: CFRunLoop?
    private let ready = DispatchSemaphore(value: 0)

    private init() {
        let t = Thread { [self] in
            let timer = Timer(timeInterval: 3600, repeats: true) { _ in }
            RunLoop.current.add(timer, forMode: .common)
            runLoop = CFRunLoopGetCurrent()
            ready.signal()
            RunLoop.current.run()
        }
        t.name = "bggate.tap"
        t.qualityOfService = .userInteractive
        t.start()
        ready.wait()
    }

    func addSource(_ source: CFRunLoopSource, mode: CFRunLoopMode) {
        guard let rl = runLoop else { return }
        CFRunLoopAddSource(rl, source, mode)
        CFRunLoopWakeUp(rl)
    }
}

// MARK: - 统计

final class TapStats: @unchecked Sendable {
    private var lock = os_unfair_lock_s()
    private(set) var seen: [String: [UInt32: Int]] = [:]      // kind -> rawType -> count
    private(set) var dropped: [String: [UInt32: Int]] = [:]
    private(set) var reEnables = 0
    private(set) var disabledByTimeout = 0
    private(set) var disabledByUserInput = 0

    func note(kind: String, type: UInt32, dropped isDropped: Bool) {
        os_unfair_lock_lock(&lock)
        seen[kind, default: [:]][type, default: 0] += 1
        if isDropped { dropped[kind, default: [:]][type, default: 0] += 1 }
        os_unfair_lock_unlock(&lock)
    }

    func noteDisabled(timeout: Bool) {
        os_unfair_lock_lock(&lock)
        if timeout { disabledByTimeout += 1 } else { disabledByUserInput += 1 }
        reEnables += 1
        os_unfair_lock_unlock(&lock)
    }

    func snapshot() -> [String: Any] {
        os_unfair_lock_lock(&lock); defer { os_unfair_lock_unlock(&lock) }
        func flat(_ d: [String: [UInt32: Int]]) -> [String: [String: Int]] {
            d.mapValues { inner in Dictionary(uniqueKeysWithValues: inner.map { (String($0.key), $0.value) }) }
        }
        return ["seen": flat(seen), "dropped": flat(dropped),
                "reEnables": reEnables, "disabledByTimeout": disabledByTimeout,
                "disabledByUserInput": disabledByUserInput]
    }
}

// MARK: - 会话

final class BackgroundActivationSession: @unchecked Sendable {
    enum TapKind: String { case previous, target }

    final class TapContext {
        let session: BackgroundActivationSession
        let kind: TapKind
        var tap: CFMachPort?
        init(session: BackgroundActivationSession, kind: TapKind) { self.session = session; self.kind = kind }
    }

    let targetPID: pid_t
    let previousPID: pid_t?
    let dropTypes: Set<UInt32>
    let eventMask: CGEventMask
    let stats = TapStats()

    // dropTypes 是不可变的小集合，先做 contains 过滤，绝大多数事件在取锁前就返回（kwwk 每个事件一次 NSLock）
    private var phaseLock = os_unfair_lock_s()
    private var phaseFinished = false
    private var taps: [CFMachPort] = []
    private var contexts: [TapContext] = []
    private var finished = false
    private(set) var installedKinds: [String] = []

    init(targetPID: pid_t, previousPID: pid_t?, dropTypes: Set<UInt32>, eventMask: CGEventMask) {
        self.targetPID = targetPID
        self.previousPID = previousPID
        self.dropTypes = dropTypes
        self.eventMask = eventMask
    }

    func installTaps() throws {
        guard let prev = previousPID, prev != targetPID else { return }
        try installTap(kind: .previous, pid: prev)
        try installTap(kind: .target, pid: targetPID)
    }

    private func installTap(kind: TapKind, pid: pid_t) throws {
        let ctx = TapContext(session: self, kind: kind)
        let ptr = Unmanaged.passUnretained(ctx).toOpaque()
        guard let tap = CGEvent.tapCreateForPid(pid: pid, place: .headInsertEventTap, options: .defaultTap,
                                                eventsOfInterest: eventMask,
                                                callback: bgTapCallback, userInfo: ptr) else {
            throw NSError(domain: "bggate", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "TAP_FAILED pid=\(pid) kind=\(kind.rawValue)"])
        }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap)
            throw NSError(domain: "bggate", code: 2, userInfo: [NSLocalizedDescriptionKey: "RUNLOOP_SOURCE_FAILED pid=\(pid)"])
        }
        ctx.tap = tap
        TapRunLoopThread.shared.addSource(source, mode: .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        contexts.append(ctx)
        taps.append(tap)
        installedKinds.append("\(kind.rawValue):\(pid)")
    }

    func shouldDrop(kind: TapKind, type: CGEventType) -> Bool {
        guard kind == .previous, dropTypes.contains(type.rawValue) else { return false }
        os_unfair_lock_lock(&phaseLock); defer { os_unfair_lock_unlock(&phaseLock) }
        return !phaseFinished
    }

    // MARK: 激活

    /// 步骤① appKitDefined subtype=1（NSEventSubtypeApplicationActivated）
    @discardableResult
    static func postAppKitPrimer(targetPID: pid_t, windowNumber: Int, subtype: Int16) -> Bool {
        guard windowNumber != 0 else { return false }
        guard let event = NSEvent.otherEvent(with: .appKitDefined, location: .zero, modifierFlags: [],
                                             timestamp: 0, windowNumber: windowNumber, context: nil,
                                             subtype: subtype, data1: 0, data2: 0)?.cgEvent else { return false }
        _ = event.applyPrivateWindowFields(windowNumber: windowNumber)   // 只有 51/58，没有 40
        event.postToPid(targetPID)
        usleep(20_000)
        return true
    }

    /// 步骤② center primer：一次真点击。point 传 nil 用窗口正中心。
    @discardableResult
    static func postCenterPrimer(targetPID: pid_t, windowNumber: Int, windowFrame: CGRect,
                                 point: CGPoint?, options: DispatchOptions) -> AddressingReport
    {
        let p = point ?? CGPoint(x: windowFrame.midX, y: windowFrame.midY)
        return BackgroundDispatcher.leftClick(pid: targetPID, windowNumber: windowNumber,
                                              windowFrame: windowFrame, screenPoint: p, options: options)
    }

    /// 会话结束归还焦点：subtype=2，目标已是前台就跳过（这是独立方法，不是激活第二步）
    func restoreIfNeeded(windowNumber: Int) -> Bool {
        guard windowNumber != 0 else { return false }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier != targetPID else { return false }
        return Self.postAppKitPrimer(targetPID: targetPID, windowNumber: windowNumber, subtype: 2)
    }

    func finish() {
        guard !finished else { return }
        finished = true
        os_unfair_lock_lock(&phaseLock); phaseFinished = true; os_unfair_lock_unlock(&phaseLock)
        for t in taps { CGEvent.tapEnable(tap: t, enable: false); CFMachPortInvalidate(t) }
        taps.removeAll()
        contexts.removeAll()
    }

    fileprivate func handleDisabled(ctx: TapContext, timeout: Bool) {
        stats.noteDisabled(timeout: timeout)
        if let t = ctx.tap { CGEvent.tapEnable(tap: t, enable: true) }   // kwwk 缺失的自愈
    }
}

private let bgTapCallback: CGEventTapCallBack = { _, type, event, raw in
    guard let raw else { return Unmanaged.passUnretained(event) }
    let ctx = Unmanaged<BackgroundActivationSession.TapContext>.fromOpaque(raw).takeUnretainedValue()

    if type == .tapDisabledByTimeout {
        ctx.session.handleDisabled(ctx: ctx, timeout: true)
        return nil
    }
    if type == .tapDisabledByUserInput {
        ctx.session.handleDisabled(ctx: ctx, timeout: false)
        return nil
    }

    let drop = ctx.session.shouldDrop(kind: ctx.kind, type: type)
    ctx.session.stats.note(kind: ctx.kind.rawValue, type: type.rawValue, dropped: drop)
    return drop ? nil : Unmanaged.passUnretained(event)
}
