import AppKit
import ApplicationServices
import Foundation

/// Thin, non-throwing-by-default wrapper around AXUIElement. Kept deliberately
/// generic: no per-application knowledge lives here.
struct AXElement {
    let ref: AXUIElement

    init(_ ref: AXUIElement) { self.ref = ref }

    /// Messaging timeout guards against a hung target app blocking the bridge forever.
    /// Set on an application element it applies to every element of that app.
    static func application(pid: pid_t, timeout: Float = 2.0) -> AXElement {
        let element = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(element, timeout)
        return AXElement(element)
    }

    static func systemWide() -> AXElement { AXElement(AXUIElementCreateSystemWide()) }

    var nodeId: Int { ElementRegistry.shared.handle(for: ref) }

    var pid: pid_t? {
        var pid: pid_t = 0
        return AXUIElementGetPid(ref, &pid) == .success ? pid : nil
    }

    /// Returns nil for any failure — callers that need the AXError use `copyChecked`.
    func copy(_ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(ref, attribute as CFString, &value) == .success else { return nil }
        return value
    }

    func copyChecked(_ attribute: String) throws -> CFTypeRef? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(ref, attribute as CFString, &value)
        switch err {
        case .success: return value
        case .noValue, .attributeUnsupported: return nil
        default: throw BridgeError.ax(err, "copy attribute '\(attribute)'")
        }
    }

    /// One IPC round trip for many attributes — the difference between a 200 ms and a
    /// 20 s tree dump on Electron apps.
    func copyMultiple(_ attributes: [String]) -> [String: CFTypeRef] {
        var raw: CFArray?
        let err = AXUIElementCopyMultipleAttributeValues(
            ref, attributes as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &raw
        )
        guard err == .success, let values = raw as? [AnyObject], values.count == attributes.count else { return [:] }
        var out: [String: CFTypeRef] = [:]
        for (index, name) in attributes.enumerated() {
            let value = values[index] as CFTypeRef
            if JSONCoercion.isErrorPlaceholder(value) { continue }
            if CFGetTypeID(value) == CFNullGetTypeID() { continue }
            out[name] = value
        }
        return out
    }

    func string(_ attribute: String) -> String? {
        guard let value = copy(attribute), CFGetTypeID(value) == CFStringGetTypeID() else { return nil }
        return (value as! CFString) as String
    }

    func children() -> [AXElement] {
        elementList(copy(kAXChildrenAttribute))
    }

    /// Extracts AXUIElements from an attribute value, dropping anything that is not an
    /// element and anything equal to the receiver.
    ///
    /// The self-equal filter is load-bearing. When an application has no AX-materialized
    /// window, the accessibility server does not return an empty list — it returns an
    /// *application-typed placeholder* (`<AXUIElement Application …> {pid=N}`, CFEqual to
    /// the app element) in the window's slot. `AXWindows`, `AXChildren` and `AXMainWindow`
    /// all do this. Passing one through would report the application as its own child,
    /// collapse it onto the root's nodeId, and hand callers a frame-less "window".
    func elementList(_ value: CFTypeRef?) -> [AXElement] {
        guard let value = value, CFGetTypeID(value) == CFArrayGetTypeID() else { return [] }
        let array = value as! CFArray as [AnyObject]
        return array.compactMap { item in
            let candidate = item as CFTypeRef
            guard CFGetTypeID(candidate) == AXUIElementGetTypeID() else { return nil }
            let element = candidate as! AXUIElement
            guard !CFEqual(element, ref) else { return nil }
            return AXElement(element)
        }
    }

    func setAttribute(_ attribute: String, _ value: CFTypeRef) -> AXError {
        AXUIElementSetAttributeValue(ref, attribute as CFString, value)
    }

    func perform(_ action: String) -> AXError {
        AXUIElementPerformAction(ref, action as CFString)
    }
}

// MARK: - Process lookup

enum Processes {
    static func running() -> [NSRunningApplication] {
        NSWorkspace.shared.runningApplications
    }

    /// GUI apps only: `.regular` shows in the Dock, `.accessory` is a menu-bar agent.
    static func guiApps() -> [NSRunningApplication] {
        running().filter { $0.activationPolicy == .regular || $0.activationPolicy == .accessory }
    }

    static func exists(pid: Int) -> Bool {
        NSRunningApplication(processIdentifier: pid_t(pid)) != nil
    }

    static func requirePid(_ pid: Int) throws -> pid_t {
        guard exists(pid: pid) else { throw BridgeError.noSuchPid(pid) }
        return pid_t(pid)
    }
}
