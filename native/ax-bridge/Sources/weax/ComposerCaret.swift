import ApplicationServices
import Foundation

/// The caret reset a web composer performs the first time it stops being empty.
///
/// Measured against Feishu's composer, typing `we ping` one unicode key pair per character
/// at six intervals, three attempts each:
///
/// ```
///    4ms  ["pingww", "pingwww", "e pingw"]
///   12ms  ["e pingw", "e pingw", "e pingw"]
///   25ms  40ms  60ms  90ms      all three attempts "e pingw"
/// ```
///
/// Everything from 12ms up is stable and **stably wrong**, which is the finding. A race
/// produces different wreckage every run; this produces the same string every run, so it is
/// not a race and no interval fixes it. Widening the gap only stops the 4ms case where two
/// characters land inside one render.
///
/// The mechanism reproduces `e pingw` exactly:
///
/// ```
///   type w  -> "w"        caret 1
///   the composer re-renders as it goes from empty to non-empty and the caret returns to 0
///   type e  -> "ew"       caret 1
///   type ␣  -> "e w"      caret 2
///   type p  -> "e pw"     caret 3
///   type i  -> "e piw"  ; n -> "e pinw" ; g -> "e pingw"
/// ```
///
/// So the fix is a caret move, not a delay: after the first character has actually landed,
/// put the caret back at the end and type the rest. The wait is a poll on the element's own
/// text rather than a sleep, because "the render finished" is a thing that can be observed
/// and a duration is a thing that can only be guessed at.
///
/// The reset happens on the empty-to-non-empty transition only, so this is a first-character
/// boundary and not something every character pays for.
enum ComposerCaret {
    static let staticTextRole = "AXStaticText"

    /// One way of asking for "caret to the end of the line".
    struct Mechanism {
        let name: String
        let key: String
        let modifiers: [String]

        var json: JSONValue {
            .object([
                "name": .string(name),
                "key": .string(key),
                "modifiers": .array(modifiers.map { .string($0) }),
                "keyCode": .int(Int(Keyboard.keyCode(for: key) ?? 0))
            ])
        }
    }

    /// Tried in this order, and each one checked before it is believed.
    ///
    /// There is no single key for this — the same shape of problem `FocusStrategy` solves
    /// for focus. Measured against a probe that reproduces the reset, typing one character
    /// and then one more:
    ///
    /// | mechanism | selection after | what the next character did |
    /// |---|---|---|
    /// | nothing | 0 | `"Xw"` — in front |
    /// | `end` (119) | 0 | `"Xw"` — still in front |
    /// | `cmd`+`right` | 1 | `"wX"` — appended |
    ///
    /// In the Cocoa text system `End` is `scrollToEndOfDocument:`: it scrolls the view and
    /// leaves the insertion point exactly where it was. Chromium is the other way round and
    /// honours `End` as a caret move — which is why it is still tried first. It has no side
    /// effect in either engine, while `Cmd`+`Right` is browser navigation whenever focus is
    /// *not* in a text field, so it is the fallback rather than the default.
    static let mechanisms: [Mechanism] = [
        Mechanism(name: "end", key: "end", modifiers: []),
        Mechanism(name: "cmdRight", key: "right", modifiers: ["cmd"])
    ]
    /// A composer's text lives near its own element; this is not a tree dump.
    private static let textDepth = 10
    private static let textNodes = 400

    struct Budget {
        let timeoutMs: Int
        let pollMs: Int

        static let `default` = Budget(timeoutMs: 1_500, pollMs: 20)

        /// How long to wait for a caret move to show up, per mechanism.
        ///
        /// Much shorter than the first-character wait, and deliberately so: waiting for a
        /// character is waiting for a render, while this is one key event's round trip
        /// through the target's run loop. Capped so a mechanism that does nothing — `End`
        /// in the Cocoa text system does nothing to the caret — costs a quarter of a second
        /// rather than the whole budget before the next one is tried.
        static let caretSettleCeilingMs = 250

        var caretSettleMs: Int { min(timeoutMs, Budget.caretSettleCeilingMs) }

        var json: JSONValue {
            .object(["timeoutMs": .int(timeoutMs), "pollMs": .int(pollMs),
                     "caretSettleMs": .int(caretSettleMs)])
        }
    }

    /// What will be done about the reset, decided from the element **before** a key is sent
    /// so a dry run can report it.
    enum Plan {
        /// Type straight through, as this bridge always did.
        case straightThrough(reason: String)
        /// Type the first character, wait for it to appear, move the caret to the end, and
        /// type the rest.
        case recoverAfterFirstCharacter(element: AXElement, budget: Budget)

        var json: JSONValue {
            switch self {
            case .straightThrough(let reason):
                return .object([
                    "recovery": .string("none"),
                    "reason": .string(reason),
                    // The contract holds either way: the first character is never followed
                    // blindly by the second. Here there is simply nothing to recover from.
                    "watchesFirstCharacter": .bool(false)
                ])
            case .recoverAfterFirstCharacter(_, let budget):
                return .object([
                    "recovery": .string("caretToEnd"),
                    "reason": .string("the composer is empty, so the first character makes it re-render"),
                    "watchesFirstCharacter": .bool(true),
                    "afterCharacters": .int(1),
                    "mechanisms": .array(mechanisms.map { $0.json }),
                    // The caret move is read back from AXSelectedTextRange before the rest
                    // is typed, the same way focus is read back before anything is.
                    "verifiesCaret": .bool(true),
                    "budget": budget.json
                ])
            }
        }
    }

    // MARK: - Deciding

    /// Chooses the plan for one element and one piece of text.
    ///
    /// Three outcomes, and the two negative ones are different on purpose:
    ///
    /// * **No readable text.** The element exposes neither a value nor any text leaf, so
    ///   nothing can be watched and claiming otherwise would turn every write into a
    ///   timeout. Types straight through, exactly as before, and says why.
    /// * **Already has text.** The reset is the empty-to-non-empty transition, and appending
    ///   to a composer that already has something in it does not trigger it, so there is
    ///   nothing here to recover from. Where focus leaves the caret in a composer that
    ///   already has text is a *different* question, which this op has never answered:
    ///   measured against the probe, typing `tail` into `seed ` produces `tailseed `. That
    ///   is untouched on purpose — it is not the reset, and the send path only ever writes
    ///   into an empty composer.
    /// * **Empty and readable.** The case the measurement is about.
    ///
    /// One character is also nothing to recover from: the reset happens after it and there
    /// is nothing left to insert in the wrong place, so the caret move would be two key
    /// events and a wait spent on an already-correct result.
    static func decide(element: AXElement, text: String, budget: Budget) -> Plan {
        guard !text.isEmpty else { return .straightThrough(reason: "nothing to type") }
        guard text.count > 1 else {
            return .straightThrough(reason: "a single character cannot be scrambled by the "
                + "re-render that follows it")
        }
        guard let current = readable(element) else {
            return .straightThrough(reason: "the element exposes no text this bridge can read, "
                + "so the first character landing cannot be observed")
        }
        guard current.isEmpty else {
            return .straightThrough(reason: "the composer already has text, and the re-render "
                + "that moves the caret only happens on the empty-to-non-empty transition")
        }
        return .recoverAfterFirstCharacter(element: element, budget: budget)
    }

    // MARK: - Waiting

    /// Polls until `cluster` shows up in the element's text.
    ///
    /// Throws rather than carrying on. One character has been sent by this point, so the
    /// composer is not as the caller left it — reporting that honestly is the only useful
    /// thing left to do, and typing the rest into a caret that is somewhere unknown would
    /// produce the scrambled string this whole file exists to prevent.
    static func awaitFirstCharacter(element: AXElement, cluster: String, budget: Budget) throws -> JSONValue {
        let started = Date()
        let deadline = started.addingTimeInterval(Double(budget.timeoutMs) / 1000)
        var polls = 0
        var seen = ""

        repeat {
            seen = readable(element) ?? ""
            polls += 1
            if seen.contains(cluster) {
                return .object([
                    "landed": .bool(true),
                    "polls": .int(polls),
                    "elapsedMs": .int(elapsedMs(since: started))
                ])
            }
            if Date() >= deadline { break }
            usleep(UInt32(max(1, budget.pollMs) * 1000))
        } while Date() < deadline

        throw BridgeError(
            code: "CARET_NOT_SETTLED",
            message: "the first character '\(cluster)' never appeared in the element within "
                + "\(budget.timeoutMs)ms after \(polls) read(s), so the caret cannot be put back at the "
                + "end and the rest was not typed. One character was sent and is still there",
            details: .object([
                "landed": .bool(false),
                "charactersSent": .int(1),
                "polls": .int(polls),
                "elapsedMs": .int(elapsedMs(since: started)),
                "observed": .string(String(seen.prefix(200)))
            ]))
    }

    // MARK: - Moving the caret back

    /// Puts the caret at the end and proves it went there, or refuses.
    ///
    /// `characters` is how many UTF-16 units the composer should now hold: it was empty and
    /// exactly one grapheme cluster was typed, so this is known rather than measured.
    ///
    /// Three outcomes, and the difference between the last two is the whole point. A
    /// mechanism whose effect can be read back and is wrong is a proven failure, and typing
    /// the rest into it would produce exactly the scramble this exists to prevent — so it
    /// throws. An element that reports no selection at all is *unknown*, not wrong; every
    /// mechanism is sent, the run continues, and the report says it could not be checked.
    /// Refusing there would break every element that has always worked.
    static func moveToEnd(element: AXElement, characters: Int, target: BackgroundTarget,
                          fields: DispatchFields, budget: Budget) throws -> JSONValue {
        var attempted: [String] = []
        for mechanism in mechanisms {
            attempted.append(mechanism.name)
            _ = try BackgroundInput.send(try Keyboard.plan(key: mechanism.key, modifiers: mechanism.modifiers),
                                         target: target, fields: fields)
            // A key event is handled on the target's own run loop, so an immediate read
            // reports the state before it arrived — the same reason `FocusVerifier` polls
            // rather than reading once. Measured: reading straight back said the caret had
            // not moved when 200ms later it plainly had.
            guard let settled = settledAtEnd(element, characters: characters, budget: budget) else { continue }
            guard settled else { continue }
            return report(movedBy: mechanism.name, attempted: attempted, offset: caretOffset(element),
                          characters: characters, verified: true, note: nil)
        }
        guard let offset = caretOffset(element) else {
            return report(movedBy: attempted.joined(separator: "+"), attempted: attempted, offset: nil,
                          characters: characters, verified: false,
                          note: "the element reports no AXSelectedTextRange, so where the caret ended up "
                              + "cannot be read; every mechanism was sent")
        }
        throw BridgeError(
            code: "CARET_NOT_AT_END",
            message: "the composer reset its caret after the first character and none of ["
                + attempted.joined(separator: ", ") + "] moved it back — it is at \(offset) of "
                + "\(characters). The rest was not typed, because inserting it there is what produces "
                + "a scrambled message. One character was sent and is still there",
            details: report(movedBy: "", attempted: attempted, offset: offset,
                            characters: characters, verified: false, note: nil))
    }

    /// True once the caret is at or past `characters`, false when it never gets there, and
    /// nil when the element reports no selection at all — which is unknown, not wrong.
    private static func settledAtEnd(_ element: AXElement, characters: Int, budget: Budget) -> Bool? {
        let deadline = Date().addingTimeInterval(Double(budget.caretSettleMs) / 1000)
        repeat {
            guard let offset = caretOffset(element) else { return nil }
            if offset >= characters { return true }
            if Date() >= deadline { break }
            usleep(UInt32(max(1, budget.pollMs) * 1000))
        } while Date() < deadline
        return false
    }

    private static func report(movedBy: String, attempted: [String], offset: Int?, characters: Int,
                               verified: Bool, note: String?) -> JSONValue {
        var out: [String: JSONValue] = [
            "movedBy": .string(movedBy),
            "verified": .bool(verified),
            "attempted": .array(attempted.map { .string($0) }),
            "offset": offset.map { JSONValue.int($0) } ?? .null,
            "characters": .int(characters)
        ]
        if let note = note { out["note"] = .string(note) }
        return .object(out)
    }

    /// Where the caret is, or nil when the element does not report one.
    static func caretOffset(_ element: AXElement) -> Int? {
        guard let raw = element.copy(kAXSelectedTextRangeAttribute),
              CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        var range = CFRange(location: 0, length: 0)
        guard AXValueGetValue(raw as! AXValue, .cfRange, &range) else { return nil }
        return range.location + range.length
    }

    // MARK: - Reading an element's text

    /// The element's text, or nil when it has no text representation at all.
    ///
    /// Two sources, both needed. A native field and a plain `<input>` answer `AXValue`. Web
    /// content does not put the words a human reads on the container — they live in
    /// `AXStaticText` leaves, which is why the Feishu reader flattens a subtree rather than
    /// reading a value. Taking the union means whichever one moves is seen; nothing here
    /// interprets the string beyond looking for the character that was just typed.
    ///
    /// Returning nil rather than "" for an element with no text representation is the
    /// distinction the whole decision rests on: an empty composer and an unwatchable one
    /// both read as empty, and they call for opposite behaviour.
    static func readable(_ element: AXElement) -> String? {
        let advertised = element.attributeNames()
        let value = element.string(kAXValueAttribute)
        let leaves = staticText(under: element)
        guard advertised.contains(kAXValueAttribute) || value != nil || leaves != nil else { return nil }
        return (value ?? "") + (leaves ?? "")
    }

    /// Concatenated `AXStaticText` values under an element, or nil when there are no text
    /// leaves at all. Bounded, and deduplicated by element identity — a self-referential
    /// node otherwise walks forever.
    private static func staticText(under element: AXElement) -> String? {
        var found = false
        var out = ""
        var visited = 0
        var seen = Set<ElementIdentity>()

        func walk(_ node: AXElement, _ depth: Int) {
            guard visited < textNodes, depth <= textDepth else { return }
            guard seen.insert(ElementIdentity(node.ref)).inserted else { return }
            visited += 1
            if node.string(kAXRoleAttribute) == staticTextRole {
                found = true
                out += node.string(kAXValueAttribute) ?? ""
            }
            for child in node.children() { walk(child, depth + 1) }
        }

        walk(element, 0)
        return found ? out : nil
    }

    private static func elapsedMs(since started: Date) -> Int {
        Int(Date().timeIntervalSince(started) * 1000)
    }
}

/// `CFEqual`/`CFHash` box so an AXUIElement can go in a Set.
struct ElementIdentity: Hashable {
    let ref: AXUIElement

    init(_ ref: AXUIElement) { self.ref = ref }

    static func == (a: ElementIdentity, b: ElementIdentity) -> Bool { CFEqual(a.ref, b.ref) }
    func hash(into hasher: inout Hasher) { hasher.combine(CFHash(ref)) }
}
