import ApplicationServices
import CoreGraphics
import Foundation

/// Writing into a web composer.
///
/// This exists because every public way of doing it reports success and does nothing.
/// Measured against a `contenteditable` that reported its own DOM events: `AXValue`,
/// `AXFocused`, `AXSelectedTextRange`, `AXSelectedText`, `AXPress` and `AXConfirm` all
/// returned `success`, and not one produced a `beforeinput` or an `input`. The value read
/// back as changed and the page never knew — which for a controlled editor means the
/// application's own state never updated and the message that looks typed is not typed.
/// A plain `<input>` accepts `AXValue` normally, so this is what a `contenteditable` is,
/// not a mistake in how it was addressed.
///
/// What worked, and the only thing that worked: **press the element to focus it, then
/// send keys to the process.** The page reported the whole sequence — `keydown`,
/// `keypress`, `beforeinput`, `textInput`, `input` — with the frontmost application
/// unchanged and the cursor unmoved.
///
/// So this is a hybrid by necessity: public accessibility to aim, private dispatch to
/// write. An executor that quietly falls back to `setValue` here reports success and
/// sends nothing.
enum HybridInput {
    private static let focusSettleMicroseconds: UInt32 = 60_000

    struct Plan {
        let nodeId: Int
        let focusAction: String
        let strategy: FocusStrategy
        let text: String
        let target: BackgroundTarget
        let perCharacterMicroseconds: UInt32
        let advertised: [String]

        var json: JSONValue {
            .object([
                "nodeId": .int(nodeId),
                "focusVia": .string(strategy.rawValue),
                "focusAction": .string(focusAction),
                "advertisedActions": .array(advertised.map { .string($0) }),
                "characters": .int(text.count),
                "target": target.json,
                "route": .string("focus + postToPid(\(target.pid))"),
                "perCharacterMs": .int(Int(perCharacterMicroseconds) / 1000)
            ])
        }
    }

    /// Focus, then type. The two halves report separately so a failure says which one it
    /// was — a focus that never took and a typing run that went nowhere look identical
    /// from the outside otherwise.
    static func focusAndType(element: AXElement, nodeId: Int, text: String, target: BackgroundTarget,
                             focusAction: String, strategy: FocusStrategy, fields: DispatchFields,
                             perCharacterMicroseconds: UInt32, dryRun: Bool) throws -> JSONValue {
        let plan = Plan(nodeId: nodeId, focusAction: focusAction, strategy: strategy, text: text,
                        target: target, perCharacterMicroseconds: perCharacterMicroseconds,
                        advertised: element.actionNames())
        guard !dryRun else {
            return .object(["ok": .bool(true), "dryRun": .bool(true), "plan": plan.json])
        }

        let focused = try Focuser.focus(element: element, action: focusAction, strategy: strategy,
                                        target: target, fields: fields)
        usleep(focusSettleMicroseconds)

        let addressing = try BackgroundInput.type(text, target: target, fields: fields,
                                                  perCharacterMicroseconds: perCharacterMicroseconds)
        return .object([
            "ok": .bool(true),
            "focused": focused.json,
            "typed": .object(["characters": .int(text.count), "addressing": addressing.json]),
            "plan": plan.json
        ])
    }
}
