import ApplicationServices
import CoreGraphics
import Foundation

/// Proving the caret actually landed on the element before a single key is sent.
///
/// Every mechanism for focusing an element reports success by returning `.success` from
/// the call that requested it, and that is not the same statement. The central measurement
/// of this project is that `AXValue`, `AXFocused`, `AXSelectedTextRange`, `AXSelectedText`,
/// `AXPress` and `AXConfirm` all return `success` on a web `contenteditable` and do
/// nothing whatsoever — the page reports no `beforeinput`, no `input`, and its own state
/// never changes. A focus call is exactly the same kind of claim.
///
/// Typing on an unverified claim is not a wasted keystroke, it is a destructive one:
/// Chromium treats keys arriving at an unfocused window as global shortcuts, so `w` closes
/// a tab and the text goes wherever the real focus was. So the read-back below is not a
/// nicety — it is the only thing standing between "focus said yes" and typing into
/// somebody's open conversation.
///
/// **Identity cannot be compared with `CFEqual`.** Chromium hands out a fresh
/// `AXUIElement` for `AXFocusedUIElement` on every read, so pointer equality is false even
/// when it is unquestionably the same DOM node. Comparison is therefore by stable
/// attributes, and by walking the focused element's ancestors — focus landing on a text
/// node inside the composer is focus on the composer.
enum FocusVerifier {
    /// Attributes that identify an element well enough to bet a keystroke on.
    ///
    /// `AXDOMIdentifier` covers web content that sets an id, `AXIdentifier` covers native
    /// controls, and the frame covers whatever exposes neither — which is the common case,
    /// not the exotic one. Measured on a real CEF composer (a Draft.js
    /// `public-DraftEditor-content`): **no `AXDOMIdentifier` and no `AXIdentifier` at
    /// all**, only a class list and a frame. So the frame is doing the work there and is a
    /// first-class key, not a fallback.
    private static let strongKeys = ["AXDOMIdentifier", "AXIdentifier"]

    /// Must not contradict, but cannot prove identity on its own.
    ///
    /// A class list is the one distinctive thing a CEF composer reliably has, and it is
    /// deliberately not sufficient: every row in a message list carries identical classes,
    /// so accepting it alone would let focus on a sibling pass as focus on the target —
    /// which is the exact harm this whole check exists to prevent. It can only veto.
    private static let consistencyKey = "AXDOMClassList"

    private static let settleAttempts = 6
    private static let settleMicroseconds: UInt32 = 40_000
    private static let ancestorLimit = 12

    struct Result {
        let matchedBy: String
        let focusedRole: String

        var json: JSONValue {
            .object(["verified": .bool(true), "matchedBy": .string(matchedBy),
                     "focusedRole": .string(focusedRole)])
        }
    }

    /// Polls `AXFocusedUIElement` until it identifies `target` or the attempts run out.
    /// Focus is asynchronous, so a single immediate read would report a stale answer.
    static func verify(target: AXElement, pid: pid_t) -> Result? {
        let app = AXElement.application(pid: pid)
        for attempt in 0..<settleAttempts {
            if attempt > 0 { usleep(settleMicroseconds) }
            guard let raw = app.copy(kAXFocusedUIElementAttribute),
                  CFGetTypeID(raw) == AXUIElementGetTypeID() else { continue }
            var node = AXElement(raw as! AXUIElement)
            // Focus inside a composer lands on a descendant. Walking up means the caret
            // being in a text run of the target still counts as the target.
            for depth in 0..<ancestorLimit {
                if CFEqual(node.ref, target.ref) {
                    return Result(matchedBy: depth == 0 ? "identity" : "identity/ancestor\(depth)",
                                  focusedRole: node.string(kAXRoleAttribute) ?? "")
                }
                if let key = signatureMatch(node, target) {
                    return Result(matchedBy: depth == 0 ? key : "\(key)/ancestor\(depth)",
                                  focusedRole: node.string(kAXRoleAttribute) ?? "")
                }
                guard let parent = node.copy(kAXParentAttribute),
                      CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
                let next = AXElement(parent as! AXUIElement)
                if CFEqual(next.ref, node.ref) { break }
                node = next
            }
        }
        return nil
    }

    /// Which stable attribute proves these are the same element, if any.
    ///
    /// Two rules, both deliberately strict. Any strong key present on **both** sides must
    /// agree — a differing `AXDOMIdentifier` is proof they are different elements, not a
    /// missing signal. And at least one strong key must be present on both and agree,
    /// because role and title alone match every sibling in a list.
    static func signatureMatch(_ candidate: AXElement, _ target: AXElement) -> String? {
        let candidateRole = candidate.string(kAXRoleAttribute) ?? ""
        let targetRole = target.string(kAXRoleAttribute) ?? ""
        guard candidateRole == targetRole else { return nil }

        guard classesConsistent(candidate, target) else { return nil }

        var agreed: String?
        for key in strongKeys {
            let a = candidate.string(key) ?? ""
            let b = target.string(key) ?? ""
            guard !a.isEmpty, !b.isEmpty else { continue }
            guard a == b else { return nil }
            agreed = agreed ?? key
        }
        if let frameKey = frameAgreement(candidate, target) {
            if frameKey == "conflict" { return nil }
            agreed = agreed ?? frameKey
        }
        return agreed
    }

    /// Veto only: differing class lists prove these are different elements, matching ones
    /// prove nothing because siblings share them.
    private static func classesConsistent(_ candidate: AXElement, _ target: AXElement) -> Bool {
        guard let a = NodeBuilder.classList(candidate.copy(consistencyKey)),
              let b = NodeBuilder.classList(target.copy(consistencyKey)),
              !a.isEmpty, !b.isEmpty else { return true }
        return a == b
    }

    /// A frame is a strong key when both sides have one: two different elements do not
    /// occupy the same rectangle.
    private static func frameAgreement(_ candidate: AXElement, _ target: AXElement) -> String? {
        guard let a = WindowResolver.frame(of: candidate), let b = WindowResolver.frame(of: target),
              a.width > 0, b.width > 0 else { return nil }
        let close = abs(a.minX - b.minX) <= 1 && abs(a.minY - b.minY) <= 1
            && abs(a.width - b.width) <= 1 && abs(a.height - b.height) <= 1
        return close ? "frame" : "conflict"
    }

    /// What the focus actually landed on, for an error a human can act on.
    static func describeFocus(pid: pid_t) -> JSONValue {
        let app = AXElement.application(pid: pid)
        guard let raw = app.copy(kAXFocusedUIElementAttribute),
              CFGetTypeID(raw) == AXUIElementGetTypeID() else {
            return .object(["focused": .null])
        }
        let node = AXElement(raw as! AXUIElement)
        var out: [String: JSONValue] = ["role": .string(node.string(kAXRoleAttribute) ?? "")]
        for key in ["AXDOMIdentifier", "AXIdentifier", kAXTitleAttribute] where !(node.string(key) ?? "").isEmpty {
            out[key] = .string(node.string(key) ?? "")
        }
        return .object(out)
    }
}
