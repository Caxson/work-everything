// 私有 SPI 解析 + CGEvent 窗口寻址字段。
// Portions derived from EYHN/kwwk-computer-use-core (MIT) and trycua/cua cua-driver (MIT).
import ApplicationServices
import CoreGraphics
import Foundation

enum SPI {
    // MARK: CGEventSetWindowLocation (SkyLight)
    private typealias SetWindowLocationFn = @convention(c) (CGEvent, CGPoint) -> Void

    static let setWindowLocationAvailable: Bool = setWindowLocationFn != nil

    private static let setWindowLocationFn: SetWindowLocationFn? = {
        _ = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventSetWindowLocation") else { return nil }
        return unsafeBitCast(sym, to: SetWindowLocationFn.self)
    }()

    /// 返回值必须冒泡：kwwk 静默忽略，新系统上符号消失会表现为「点击静默无效」。
    @discardableResult
    static func setWindowLocation(_ point: CGPoint, on event: CGEvent) -> Bool {
        guard let fn = setWindowLocationFn else { return false }
        fn(event, point)
        return true
    }

    // MARK: _AXUIElementGetWindow (HIServices)
    private typealias GetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError

    static let axGetWindowAvailable: Bool = axGetWindowFn != nil

    private static let axGetWindowFn: GetWindowFn? = {
        _ = dlopen("/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices", RTLD_LAZY)
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else { return nil }
        return unsafeBitCast(sym, to: GetWindowFn.self)
    }()

    static func cgWindowID(forAXWindow element: AXUIElement) -> CGWindowID? {
        guard let fn = axGetWindowFn else { return nil }
        var wid: CGWindowID = 0
        guard fn(element, &wid) == .success, wid != 0 else { return nil }
        return wid
    }

    // MARK: _AXObserverAddNotificationAndCheckRemote (HIServices)
    private typealias AddNotifRemoteFn = @convention(c) (AXObserver, AXUIElement, CFString, UnsafeMutableRawPointer?, Bool) -> AXError

    static let axObserverRemoteAvailable: Bool = addNotifRemoteFn != nil

    private static let addNotifRemoteFn: AddNotifRemoteFn? = {
        _ = dlopen("/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices", RTLD_LAZY)
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXObserverAddNotificationAndCheckRemote") else { return nil }
        return unsafeBitCast(sym, to: AddNotifRemoteFn.self)
    }()

    @discardableResult
    static func addNotification(_ observer: AXObserver, _ element: AXUIElement, _ name: String, _ ctx: UnsafeMutableRawPointer?) -> AXError {
        if let fn = addNotifRemoteFn {
            return fn(observer, element, name as CFString, ctx, true)
        }
        return AXObserverAddNotification(observer, element, name as CFString, ctx)
    }
}

// MARK: - 窗口寻址字段

/// 40 / 91 / 92 是公有常量；51 / 58 是私有字段号。
enum EventField {
    static let targetPID = CGEventField.eventTargetUnixProcessID                                    // 40
    static let windowUnderPointer = CGEventField.mouseEventWindowUnderMousePointer                  // 91
    static let windowThatCanHandle = CGEventField.mouseEventWindowUnderMousePointerThatCanHandleThisEvent // 92
    static let privateTargetWindowNumber = CGEventField(rawValue: 51)                               // 私有
    static let privateWindowRouting = CGEventField(rawValue: 58)                                    // 私有
}

struct AddressingReport: Codable {
    var field40: Bool = false
    var field91: Bool = false
    var field92: Bool = false
    var field51: Bool = false
    var field58: Bool = false
    var windowLocationApplied: Bool = false
    var quartzWindowPoint: [Double] = []
}

extension CGEvent {
    /// 私有字段 51/58。构造器可失败 → 必须能上报，不能像 kwwk 那样静默跳过。
    @discardableResult
    func applyPrivateWindowFields(windowNumber: Int) -> (f51: Bool, f58: Bool) {
        var ok51 = false, ok58 = false
        if let f = EventField.privateTargetWindowNumber {
            setIntegerValueField(f, value: Int64(windowNumber)); ok51 = true
        }
        if let f = EventField.privateWindowRouting {
            setIntegerValueField(f, value: 1); ok58 = true
        }
        return (ok51, ok58)
    }
}
