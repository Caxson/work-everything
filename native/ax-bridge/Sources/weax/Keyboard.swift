import CoreGraphics
import Foundation

/// One synthetic keyboard event, fully specified. Nothing is left to inherited state:
/// every spec carries the exact flag set the event must be posted with.
struct KeyEventSpec {
    enum Kind: String {
        case flagsChanged, keyDown, keyUp
    }

    let kind: Kind
    let keyCode: CGKeyCode
    let flags: CGEventFlags
    let unicode: String?

    var json: JSONValue {
        var out: [String: JSONValue] = [
            "kind": .string(kind.rawValue),
            "keyCode": .int(Int(keyCode)),
            "flags": .int(Int(flags.rawValue)),
            "flagsHex": .string("0x" + String(flags.rawValue, radix: 16))
        ]
        if let unicode = unicode { out["unicode"] = .string(unicode) }
        return .object(out)
    }
}

/// US-ANSI virtual keycodes and the modifier press/release choreography.
enum Keyboard {
    /// Builds the CGEvent one spec describes. Shared by the foreground and background
    /// paths so a plan means the same thing on both; only the event source and how it is
    /// posted differ.
    static func makeEvent(_ spec: KeyEventSpec, source: CGEventSource?) throws -> CGEvent {
        let isDown = spec.kind != .keyUp
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: spec.keyCode, keyDown: isDown) else {
            throw BridgeError(code: "CG_ERROR", message: "could not create key event for \(spec.kind)")
        }
        if spec.kind == .flagsChanged { event.type = .flagsChanged }
        // Always explicit, including the empty mask — never inherit.
        event.flags = spec.flags
        if let unicode = spec.unicode {
            let utf16 = Array(unicode.utf16)
            event.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        }
        return event
    }

    static let named: [String: CGKeyCode] = [
        "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
        "escape": 53, "esc": 53, "forwarddelete": 117,
        "left": 123, "right": 124, "down": 125, "up": 126,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
        "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111
    ]

    static let characters: [Character: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
        "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
        "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
        "n": 45, "m": 46, ".": 47, "`": 50
    ]

    /// Modifier identity: canonical name -> (flag, left-hand virtual keycode).
    /// Applied in this fixed order so a plan is deterministic and reversible.
    private static let modifierOrder: [(name: String, flag: CGEventFlags, keyCode: CGKeyCode)] = [
        ("ctrl", .maskControl, 59),
        ("alt", .maskAlternate, 58),
        ("shift", .maskShift, 56),
        ("cmd", .maskCommand, 55),
        ("fn", .maskSecondaryFn, 63)
    ]

    static func canonical(_ raw: String) throws -> String {
        switch raw.lowercased() {
        case "cmd", "command", "meta": return "cmd"
        case "shift": return "shift"
        case "alt", "option", "opt": return "alt"
        case "ctrl", "control": return "ctrl"
        case "fn", "function": return "fn"
        default: throw BridgeError.badRequest("unknown modifier '\(raw)'")
        }
    }

    static func keyCode(for key: String) -> CGKeyCode? {
        if let code = named[key.lowercased()] { return code }
        let lowered = key.lowercased()
        guard lowered.count == 1, let ch = lowered.first else { return nil }
        return characters[ch]
    }

    /// Builds the full event sequence for one keystroke.
    ///
    /// Modifiers are pressed and released with explicit `flagsChanged` events and the
    /// sequence always ends on flags == 0. Setting a flag mask on a key event alone
    /// (without ever releasing it) is what leaves a modifier latched inside the target
    /// app, turning a later plain `w` into Cmd+W.
    static func plan(key: String, modifiers: [String]) throws -> [KeyEventSpec] {
        var names = Set(try modifiers.map(canonical))
        // An uppercase character is Shift + the lowercase key, not a bare keycode.
        if key.count == 1, let ch = key.first, ch.isUppercase { names.insert("shift") }

        let active = modifierOrder.filter { names.contains($0.name) }
        guard let code = keyCode(for: key) else { return try unicodePlan(key: key, active: active) }

        var specs: [KeyEventSpec] = []
        var flags: CGEventFlags = []
        for modifier in active {
            flags.insert(modifier.flag)
            specs.append(KeyEventSpec(kind: .flagsChanged, keyCode: modifier.keyCode, flags: flags, unicode: nil))
        }
        specs.append(KeyEventSpec(kind: .keyDown, keyCode: code, flags: flags, unicode: nil))
        specs.append(KeyEventSpec(kind: .keyUp, keyCode: code, flags: flags, unicode: nil))
        for modifier in active.reversed() {
            flags.remove(modifier.flag)
            specs.append(KeyEventSpec(kind: .flagsChanged, keyCode: modifier.keyCode, flags: flags, unicode: nil))
        }
        return specs
    }

    /// Characters with no US-layout keycode are typed as a unicode payload. That path
    /// cannot express modifiers, so it refuses them rather than dropping them silently.
    private static func unicodePlan(key: String,
                                    active: [(name: String, flag: CGEventFlags, keyCode: CGKeyCode)])
        throws -> [KeyEventSpec] {
        guard active.isEmpty else {
            throw BridgeError.badRequest(
                "key '\(key)' has no keycode on the US layout; modifiers cannot be applied to a unicode keystroke")
        }
        guard !key.isEmpty else { throw BridgeError.badRequest("'key' must not be empty") }
        return [
            KeyEventSpec(kind: .keyDown, keyCode: 0, flags: [], unicode: key),
            KeyEventSpec(kind: .keyUp, keyCode: 0, flags: [], unicode: key)
        ]
    }
}
