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
    struct Plan {
        let nodeId: Int
        let focusAction: String
        let strategy: FocusStrategy
        let text: String
        let target: BackgroundTarget
        let perCharacterMicroseconds: UInt32
        let advertised: [String]
        let caret: ComposerCaret.Plan

        var json: JSONValue {
            .object([
                "nodeId": .int(nodeId),
                "focusVia": .string(strategy.rawValue),
                "focusAction": .string(focusAction),
                "advertisedActions": .array(advertised.map { .string($0) }),
                "characters": .int(text.count),
                "target": target.json,
                "route": .string("focus + postToPid(\(target.pid))"),
                // Part of the contract, visible without running: focus is read back from
                // AXFocusedUIElement and must identify this element before a key is sent.
                "verifiesFocus": .bool(true),
                "perCharacterMs": .int(Int(perCharacterMicroseconds) / 1000),
                // The other half of the contract: what will be done about the caret reset an
                // empty composer performs on its first character, decided from this element
                // rather than assumed — so a dry run shows the decision, not the mechanism.
                "caret": caret.json
            ])
        }
    }

    /// Focus, then type. The two halves report separately so a failure says which one it
    /// was — a focus that never took and a typing run that went nowhere look identical
    /// from the outside otherwise.
    static func focusAndType(element: AXElement, nodeId: Int, text: String, target: BackgroundTarget,
                             focusAction: String, strategy: FocusStrategy, fields: DispatchFields,
                             perCharacterMicroseconds: UInt32, caretBudget: ComposerCaret.Budget,
                             recoverCaret: Bool, dryRun: Bool) throws -> JSONValue {
        // Read before anything is focused or typed: the decision is about the composer as
        // the caller left it, and focusing can change what it exposes.
        //
        // `recoverCaret: false` is the switch that makes the fix falsifiable — it types the
        // way this bridge did before, so the scramble can be reproduced against the same
        // element in the same run instead of being taken on trust. It exists for the same
        // reason the `fields` switches do, and for nothing else.
        let caret = recoverCaret
            ? ComposerCaret.decide(element: element, text: text, budget: caretBudget)
            : ComposerCaret.Plan.straightThrough(reason: "caretRecovery: false — the caller asked for "
                + "the behaviour this bridge had before the caret reset was handled")
        let plan = Plan(nodeId: nodeId, focusAction: focusAction, strategy: strategy, text: text,
                        target: target, perCharacterMicroseconds: perCharacterMicroseconds,
                        advertised: element.actionNames(), caret: caret)
        guard !dryRun else {
            return .object(["ok": .bool(true), "dryRun": .bool(true), "plan": plan.json])
        }

        // Throws FOCUS_FAILED without sending anything when the caret cannot be proven to
        // be in the element. The verifier polls for focus to settle, so there is no blind
        // sleep here to get wrong.
        let focused = try Focuser.focus(element: element, action: focusAction, strategy: strategy,
                                        target: target, fields: fields)

        let typed = try BackgroundInput.type(text, target: target, fields: fields,
                                             perCharacterMicroseconds: perCharacterMicroseconds,
                                             caret: caret)
        return .object([
            "ok": .bool(true),
            "focused": focused.json,
            "typed": .object(["characters": .int(text.count),
                              "addressing": typed.addressing.json,
                              "caret": typed.caret]),
            "plan": plan.json
        ])
    }
}
