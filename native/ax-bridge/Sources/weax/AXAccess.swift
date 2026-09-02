import AppKit
import ApplicationServices
import Foundation

/// Thin, non-throwing-by-default wrapper around AXUIElement. Kept deliberately
/// generic: no per-application knowledge lives here.
struct AXElement {
    let ref: AXUIElement
    /// Set when this element came out of a census and was equal to the element it was read
    /// from — an accessibility placeholder, not a real child or window.
    let isSelfEqual: Bool

    init(_ ref: AXUIElement, isSelfEqual: Bool = false) {
        self.ref = ref
        self.isSelfEqual = isSelfEqual
    }

    /// Messaging timeout guards against a hung target app blocking the bridge forever.
    /// Set on an application element it applies to every element of that app.
    static func application(pid: pid_t, timeout: Float = 2.0) -> AXElement {
        let element = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(element, timeout)
        return AXElement(element)
    }

    func windowCensus() -> ElementCensus { elementCensus(kAXWindowsAttribute) }

    static func systemWide() -> AXElement { AXElement(AXUIElementCreateSystemWide()) }

    var nodeId: Int { ElementRegistry.current.handle(for: ref) }

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

    func bool(_ attribute: String) -> Bool {
        guard let value = copy(attribute), CFGetTypeID(value) == CFBooleanGetTypeID() else { return false }
        return CFBooleanGetValue((value as! CFBoolean))
    }

    func children() -> [AXElement] {
        elementList(copy(kAXChildrenAttribute))
    }

    /// What an element-valued attribute actually contained, before anything was dropped.
    ///
    /// The self-equal entries are the whole point of keeping this. When an application has
    /// no AX-materialized window the accessibility server does not return an empty list —
    /// it returns an *application-typed placeholder* (`<AXUIElement Application …>
    /// {pid=N}`, CFEqual to the app element) in the window's slot. `AXWindows`,
    /// `AXChildren` and `AXMainWindow` all do this, and a locked screen replaces **every**
    /// entry that way while keeping the count correct.
    ///
    /// That means the filter and the diagnosis want opposite things from the same data:
    /// traversal must drop the placeholders or it walks the application as its own child
    /// forever, and the diagnosis must see them or a locked screen is indistinguishable
    /// from an application with no windows. So the census is taken first and filtering is
    /// something a caller does to it afterwards — never the other way round.
    struct ElementCensus {
        /// Every entry that was an AXUIElement, placeholders included.
        let all: [AXElement]
        /// Entries equal to the receiver — the substitution signature.
        let selfEqual: Int
        /// Entries that were not elements at all.
        let nonElement: Int

        /// Safe to traverse: the census minus the placeholders.
        var real: [AXElement] { all.filter { !$0.isSelfEqual } }
        var rawCount: Int { all.count + nonElement }
        /// Every single entry was a placeholder, and there was at least one.
        var fullySubstituted: Bool { selfEqual > 0 && selfEqual == rawCount }

        var json: JSONValue {
            .object(["entries": .int(rawCount), "selfEqual": .int(selfEqual),
                     "nonElement": .int(nonElement), "real": .int(real.count)])
        }
    }

    /// Reads an element-valued attribute and counts what came back, dropping nothing.
    func elementCensus(_ attribute: String) -> ElementCensus {
        census(copy(attribute))
    }

    func census(_ value: CFTypeRef?) -> ElementCensus {
        guard let value = value, CFGetTypeID(value) == CFArrayGetTypeID(),
              let array = value as? [AnyObject] else {
            return ElementCensus(all: [], selfEqual: 0, nonElement: 0)
        }
        var all: [AXElement] = []
        var selfEqual = 0
        var nonElement = 0
        for item in array {
            let candidate = item as CFTypeRef
            guard CFGetTypeID(candidate) == AXUIElementGetTypeID() else {
                nonElement += 1
                continue
            }
            let element = candidate as! AXUIElement
            let matchesSelf = CFEqual(element, ref)
            if matchesSelf { selfEqual += 1 }
            all.append(AXElement(element, isSelfEqual: matchesSelf))
        }
        return ElementCensus(all: all, selfEqual: selfEqual, nonElement: nonElement)
    }

    /// Traversal-safe view of an element-valued attribute: placeholders removed.
    ///
    /// Callers that need to tell "no windows" apart from "every window was replaced by the
    /// application" must use `elementCensus` and classify before reaching for this.
    func elementList(_ value: CFTypeRef?) -> [AXElement] {
        census(value).real
    }

    func setAttribute(_ attribute: String, _ value: CFTypeRef) -> AXError {
        AXUIElementSetAttributeValue(ref, attribute as CFString, value)
    }

    func perform(_ action: String) -> AXError {
        AXUIElementPerformAction(ref, action as CFString)
    }

    /// What this element says it can do.
    ///
    /// Worth asking before performing anything: an element that does not advertise an
    /// action answers `actionUnsupported` for it, and a real `AXScrollArea` advertises no
    /// actions at all — measured on the Finder desktop and on Chrome's content area — so
    /// scrolling one through an action was never going to work.
    func actionNames() -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(ref, &names) == .success else { return [] }
        return (names as? [String]) ?? []
    }

    /// What this element says it exposes.
    ///
    /// Worth asking for the same reason `actionNames` is: an attribute an element does not
    /// advertise reads back as absent, which is indistinguishable from one it advertises and
    /// has nothing in. A text field with an empty `AXValue` and an element with no value at
    /// all are exactly that pair, and they call for opposite behaviour — see `ComposerCaret`.
    func attributeNames() -> [String] {
        var names: CFArray?
        guard AXUIElementCopyAttributeNames(ref, &names) == .success else { return [] }
        return (names as? [String]) ?? []
    }

    func isSettable(_ attribute: String) -> Bool {
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(ref, attribute as CFString, &settable) == .success else { return false }
        return settable.boolValue
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
