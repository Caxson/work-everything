import ApplicationServices
import CoreGraphics
import Foundation

/// Getting the caret into an element, whatever kind of element it turns out to be.
///
/// There is no single way that works. Measured on this machine:
///
/// * A web `contenteditable` in a CEF app advertises `AXPress` and honours it, while
///   setting `AXFocused` on it does nothing at all.
/// * A native `AXTextField` is the other way round — `AXPress` comes back
///   `actionUnsupported` (-25206) and `AXFocused` is settable and works.
/// * Some composers honour neither and only move the caret for a real click.
///
/// So the strategy is chosen from what the element advertises rather than assumed, and the
/// result says which one was used. Asking first also avoids the failure mode that made
/// this necessary: performing an action an element never claimed to have returns an error
/// that reads like the element is broken.
enum FocusStrategy: String, CaseIterable {
    case auto, press, focused, click

    static func parse(_ raw: String?) throws -> FocusStrategy {
        guard let raw = raw else { return .auto }
        guard let strategy = FocusStrategy(rawValue: raw.lowercased()) else {
            throw BridgeError.badRequest(
                "unknown focusVia '\(raw)' (" + FocusStrategy.allCases.map { $0.rawValue }.joined(separator: "|") + ")")
        }
        return strategy
    }
}

enum Focuser {
    struct Outcome {
        let method: String
        let attempted: [String]
        let verification: FocusVerifier.Result

        var json: JSONValue {
            .object(["method": .string(method),
                     "attempted": .array(attempted.map { .string($0) }),
                     "verifiedBy": .string(verification.matchedBy),
                     "focusedRole": .string(verification.focusedRole)])
        }
    }

    /// Runs one strategy, or tries each in turn for `auto`, and **verifies the result of
    /// each before accepting it**.
    ///
    /// The order for `auto` is semantic first, physical last: an advertised action, then a
    /// settable attribute, then a synthetic click. The click is kept last because it is the
    /// only one that can have a side effect if the element's frame is wrong.
    ///
    /// A strategy that claims success and does not move the caret is treated as a strategy
    /// that failed, and the next one is tried. When none of them can be proven to have
    /// worked this throws `FOCUS_FAILED` and **not one key is sent** — the whole point,
    /// since keys arriving at an unfocused Chromium window are read as global shortcuts.
    static func focus(element: AXElement, action: String, strategy: FocusStrategy,
                      target: BackgroundTarget, fields: DispatchFields) throws -> Outcome {
        var attempted: [String] = []
        var claimed: [String] = []
        let order: [FocusStrategy] = strategy == .auto ? [.press, .focused, .click] : [strategy]

        for candidate in order {
            attempted.append(candidate.rawValue)
            do {
                guard try apply(candidate, element: element, action: action,
                                target: target, fields: fields) else { continue }
                // The call said yes. That is a claim, not a fact — read the focus back and
                // make it prove itself before anything is typed.
                claimed.append(candidate.rawValue)
                if let verification = FocusVerifier.verify(target: element, pid: target.pid) {
                    return Outcome(method: candidate.rawValue, attempted: attempted, verification: verification)
                }
            } catch let error as BridgeError {
                // An explicit strategy is the caller's decision and its failure is theirs
                // to see; under `auto` a strategy that does not apply is not an error.
                if strategy != .auto { throw error }
            }
        }
        throw focusFailed(element: element, pid: target.pid, attempted: attempted, claimed: claimed)
    }

    /// Nothing has been typed when this is thrown, and nothing will be.
    private static func focusFailed(element: AXElement, pid: pid_t,
                                    attempted: [String], claimed: [String]) -> BridgeError {
        let claimedNote = claimed.isEmpty
            ? "None of them applied to this element"
            : "\(claimed.joined(separator: ", ")) reported success and the focus did not land on the element "
                + "afterwards — the call returning success is not evidence that it did anything, which is "
                + "exactly how a contenteditable behaves"
        return BridgeError(
            code: "FOCUS_FAILED",
            message: "could not put the caret in node \(element.nodeId), so no keys were sent. Tried "
                + attempted.joined(separator: ", ") + ". " + claimedNote
                + ". The element advertises actions [" + element.actionNames().joined(separator: ", ")
                + "] and AXFocused is " + (element.isSettable(kAXFocusedAttribute) ? "settable" : "not settable"),
            details: .object(["attempted": .array(attempted.map { .string($0) }),
                              "claimedSuccess": .array(claimed.map { .string($0) }),
                              "keysSent": .int(0),
                              "actions": .array(element.actionNames().map { .string($0) }),
                              "focusActuallyOn": FocusVerifier.describeFocus(pid: pid)]))
    }

    /// Returns false when the strategy simply does not apply to this element, and throws
    /// when it applies and fails.
    private static func apply(_ strategy: FocusStrategy, element: AXElement, action: String,
                              target: BackgroundTarget, fields: DispatchFields) throws -> Bool {
        switch strategy {
        case .auto:
            return false
        case .press:
            guard element.actionNames().contains(action) else { return false }
            let error = element.perform(action)
            guard error == .success else { throw BridgeError.ax(error, "perform \(action) on node \(element.nodeId)") }
            return true
        case .focused:
            guard element.isSettable(kAXFocusedAttribute) else { return false }
            let error = element.setAttribute(kAXFocusedAttribute, kCFBooleanTrue)
            guard error == .success else { throw BridgeError.ax(error, "focus node \(element.nodeId)") }
            return true
        case .click:
            guard target.windowNumber != 0 else {
                throw BridgeError(code: "NO_WINDOW",
                                  message: "focusing by click needs a window number to address the event to")
            }
            let point = try Mouse.center(of: element)
            _ = try BackgroundInput.click(target: target, screenPoint: point,
                                          button: BackgroundInput.buttons["left"]!,
                                          clickCount: 1, flags: [], fields: fields)
            return true
        }
    }
}
