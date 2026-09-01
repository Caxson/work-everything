import AppKit
import CoreGraphics
import Foundation

/// The two things a background action must not disturb: which application is in front,
/// and where the pointer is.
///
/// Every background op can carry a before/after pair of these so the caller asserts the
/// promise rather than believing it. They are cheap enough to take on every call.
struct Invariants {
    let frontmostPID: pid_t
    let frontmostName: String
    let cursor: CGPoint

    let takenAt: Date

    static func snapshot() -> Invariants {
        let front = NSWorkspace.shared.frontmostApplication
        return Invariants(frontmostPID: front?.processIdentifier ?? 0,
                          frontmostName: front?.localizedName ?? "",
                          cursor: CGEvent(source: nil)?.location ?? .zero,
                          takenAt: Date())
    }

    /// `elapsedMs` is here so a caller can judge `cursorDelta` fairly. A person using the
    /// machine moves the pointer while an op runs, and a delta measured across 300ms of
    /// tree walking is not comparable to one measured across a call that posts and
    /// returns. Without the span, the only honest reading of a non-zero delta is "someone
    /// touched the mouse, probably".
    func delta(to other: Invariants) -> JSONValue {
        let dx = other.cursor.x - cursor.x
        let dy = other.cursor.y - cursor.y
        return .object([
            "frontmostUnchanged": .bool(frontmostPID == other.frontmostPID),
            "frontmostBefore": .string(frontmostName),
            "frontmostAfter": .string(other.frontmostName),
            "frontmostPIDBefore": .int(Int(frontmostPID)),
            "frontmostPIDAfter": .int(Int(other.frontmostPID)),
            "cursorDelta": .double((dx * dx + dy * dy).squareRoot()),
            "elapsedMs": .int(Int(other.takenAt.timeIntervalSince(takenAt) * 1000)),
            "cursorBefore": .object(["x": .double(cursor.x), "y": .double(cursor.y)]),
            "cursorAfter": .object(["x": .double(other.cursor.x), "y": .double(other.cursor.y)])
        ])
    }

    /// Wraps a body in a before/after pair and returns the result with the invariants
    /// attached under `invariants`.
    static func around(_ body: () throws -> JSONValue) rethrows -> JSONValue {
        let before = snapshot()
        var result = try body()
        let after = snapshot()
        guard case .object(var object) = result else {
            return .object(["result": result, "invariants": before.delta(to: after)])
        }
        object["invariants"] = before.delta(to: after)
        result = .object(object)
        return result
    }
}
