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

        var json: JSONValue {
            .object(["method": .string(method), "attempted": .array(attempted.map { .string($0) })])
        }
    }

    /// Runs one strategy, or tries each in turn for `auto`.
    ///
    /// The order for `auto` is semantic first, physical last: an advertised action, then a
    /// settable attribute, then a synthetic click. The click is kept last because it is the
    /// only one that can have a side effect if the element's frame is wrong.
    static func focus(element: AXElement, action: String, strategy: FocusStrategy,
                      target: BackgroundTarget, fields: DispatchFields) throws -> Outcome {
        var attempted: [String] = []
        let order: [FocusStrategy] = strategy == .auto ? [.press, .focused, .click] : [strategy]

        for candidate in order {
            attempted.append(candidate.rawValue)
            do {
                if try apply(candidate, element: element, action: action, target: target, fields: fields) {
                    return Outcome(method: candidate.rawValue, attempted: attempted)
                }
            } catch let error as BridgeError {
                // An explicit strategy is the caller's decision and its failure is theirs
                // to see; under `auto` a strategy that does not apply is not an error.
                if strategy != .auto { throw error }
            }
        }
        throw BridgeError(
            code: "FOCUS_FAILED",
            message: "could not focus node \(element.nodeId): tried " + attempted.joined(separator: ", ")
                + ". The element advertises actions [" + element.actionNames().joined(separator: ", ")
                + "] and AXFocused is " + (element.isSettable(kAXFocusedAttribute) ? "settable" : "not settable"),
            details: .object(["attempted": .array(attempted.map { .string($0) }),
                              "actions": .array(element.actionNames().map { .string($0) })]))
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
