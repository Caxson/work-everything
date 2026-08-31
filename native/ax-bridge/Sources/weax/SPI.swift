import ApplicationServices
import CoreGraphics
import Foundation

/// The private surface the background path stands on, resolved at run time.
///
/// Every symbol here is looked up with `dlsym` and every lookup can fail, because a
/// system update is allowed to take any of them away. Failure is reported, never
/// swallowed: a caller that silently skips `windowNumber` addressing does not get a
/// click in the wrong window, it gets no click at all (measured — see README).
///
/// Portions derived from EYHN/kwwk-computer-use-core (MIT) and trycua/cua (MIT).
enum SPI {
    /// `RTLD_DEFAULT` — search every image already loaded into the process.
    private static let anyImage = UnsafeMutableRawPointer(bitPattern: -2)

    private static func symbol(_ name: String, in path: String) -> UnsafeMutableRawPointer? {
        _ = dlopen(path, RTLD_LAZY)
        return dlsym(anyImage, name)
    }

    private static let hiServices =
        "/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices"
    private static let skyLight = "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"

    // MARK: - CGEventSetWindowLocation (SkyLight)

    private typealias SetWindowLocationFn = @convention(c) (CGEvent, CGPoint) -> Void

    private static let setWindowLocationFn: SetWindowLocationFn? = {
        guard let sym = symbol("CGEventSetWindowLocation", in: skyLight) else { return nil }
        return unsafeBitCast(sym, to: SetWindowLocationFn.self)
    }()

    static var setWindowLocationAvailable: Bool { setWindowLocationFn != nil }

    /// Window-local fallback for the case the screen point does not land inside the
    /// target window (offscreen or occluded-and-displaced windows). Not required when
    /// the point and the window frame agree — measured, see README §"What is required".
    @discardableResult
    static func setWindowLocation(_ point: CGPoint, on event: CGEvent) -> Bool {
        guard let fn = setWindowLocationFn else { return false }
        fn(event, point)
        return true
    }

    // MARK: - _AXUIElementGetWindow (HIServices)

    private typealias GetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError

    private static let getWindowFn: GetWindowFn? = {
        guard let sym = symbol("_AXUIElementGetWindow", in: hiServices) else { return nil }
        return unsafeBitCast(sym, to: GetWindowFn.self)
    }()

    static var axGetWindowAvailable: Bool { getWindowFn != nil }

    /// Primary path from an AX window element to a CGWindowID. `WindowResolver` owns
    /// the degradation chain for when this returns nil.
    static func windowNumber(forAXWindow element: AXUIElement) -> Int? {
        guard let fn = getWindowFn else { return nil }
        var wid: CGWindowID = 0
        guard fn(element, &wid) == .success, wid != 0 else { return nil }
        return Int(wid)
    }

    // MARK: - _AXObserverAddNotificationAndCheckRemote (HIServices)

    private typealias AddNotifRemoteFn =
        @convention(c) (AXObserver, AXUIElement, CFString, UnsafeMutableRawPointer?, Bool) -> AXError

    private static let addNotifRemoteFn: AddNotifRemoteFn? = {
        guard let sym = symbol("_AXObserverAddNotificationAndCheckRemote", in: hiServices) else { return nil }
        return unsafeBitCast(sym, to: AddNotifRemoteFn.self)
    }()

    /// Absent on macOS 26.3 (measured). The public call is the working path, not a
    /// degraded one — registration succeeding has never meant the far side built a tree.
    static var axObserverRemoteAvailable: Bool { addNotifRemoteFn != nil }

    static func addNotification(_ observer: AXObserver, _ element: AXUIElement,
                                _ name: String, _ context: UnsafeMutableRawPointer?) -> AXError {
        if let fn = addNotifRemoteFn {
            return fn(observer, element, name as CFString, context, true)
        }
        return AXObserverAddNotification(observer, element, name as CFString, context)
    }

    static var report: JSONValue {
        .object([
            "setWindowLocation": .bool(setWindowLocationAvailable),
            "axGetWindow": .bool(axGetWindowAvailable),
            "axObserverRemote": .bool(axObserverRemoteAvailable)
        ])
    }
}

// MARK: - Event fields

/// 40 / 91 / 92 are public constants; 51 and 58 are not.
///
/// `CGEventField(rawValue:)` returns non-nil for *any* value — it is not a validity
/// check (measured: 40/51/58/88/91/92/99/200 all construct). The only way to know a
/// field still works is a behavioural probe.
enum EventField {
    static let targetPID = CGEventField.eventTargetUnixProcessID                                     // 40
    static let windowUnderPointer = CGEventField.mouseEventWindowUnderMousePointer                   // 91
    static let windowThatCanHandle =
        CGEventField.mouseEventWindowUnderMousePointerThatCanHandleThisEvent                         // 92
    static let privateTargetWindow = CGEventField(rawValue: 51)                                      // private
    static let privateWindowRouting = CGEventField(rawValue: 58)                                     // private
}

extension CGEvent {
    /// The two fields the mouse path cannot do without. Reports what it actually set so
    /// `dryRun` plans and live results can be asserted against each other.
    @discardableResult
    func applyPrivateWindowFields(windowNumber: Int) -> (field51: Bool, field58: Bool) {
        var ok51 = false
        var ok58 = false
        if let field = EventField.privateTargetWindow {
            setIntegerValueField(field, value: Int64(windowNumber))
            ok51 = true
        }
        if let field = EventField.privateWindowRouting {
            setIntegerValueField(field, value: 1)
            ok58 = true
        }
        return (ok51, ok58)
    }
}
