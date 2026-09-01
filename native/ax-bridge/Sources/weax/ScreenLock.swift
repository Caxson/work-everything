import ApplicationServices
import CoreGraphics
import Foundation

/// A locked screen does not make accessibility fail — it makes it lie.
///
/// Measured on macOS 26.3: while the Mac is locked, `AXWindows` still returns the right
/// *count*, but every entry is the application element itself. Titles become the app
/// name, `AXPosition`/`AXSize` fail, `_AXUIElementGetWindow` fails, and walking a
/// "window" arrives in the menu bar. Nothing reports an error at any point.
///
/// The consequence for a caller is worse than a failure: a locked Mac reads exactly like
/// "this app has no window", so it retries forever against a state that cannot recover
/// on its own. Every op that resolves a window or an element through accessibility
/// therefore checks this first and answers `SCREEN_LOCKED`.
///
/// The event channel itself is unaffected — `postToPid` keeps landing while locked — so
/// dispatch that was *given* a window number is deliberately not gated. That is the one
/// capability a lock leaves intact and taking it away would buy nothing.
enum ScreenLock {
    /// The session dictionary's own answer. Present only while locked, so absence of the
    /// key means unlocked, not unknown.
    static var isLocked: Bool {
        guard let raw = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        if let locked = raw["CGSSessionScreenIsLocked"] as? Bool { return locked }
        if let locked = raw["CGSSessionScreenIsLocked"] as? Int { return locked != 0 }
        return false
    }

    /// Time the screen locked, when the session reports one. Diagnostics only.
    static var lockedSince: String? {
        guard let raw = CGSessionCopyCurrentDictionary() as? [String: Any] else { return nil }
        return raw["CGSSessionScreenLockedTime"].map { String(describing: $0) }
    }

    static func requireUnlocked() throws {
        guard isLocked else { return }
        throw BridgeError.screenLocked(detectedBy: "session")
    }

    /// The structural signature of the substitution, read off an unfiltered census.
    ///
    /// Belt and braces: the session dictionary is the cheap check, this one is the truthful
    /// one. It has to run on the census rather than on a filtered window list, because the
    /// filter that makes a tree safe to walk removes exactly the placeholders this looks
    /// for — filter first and a locked screen arrives downstream as a harmless empty array.
    static func windowsAreSubstituted(census: AXElement.ElementCensus) -> Bool {
        census.fullySubstituted
    }

    /// Checks both signatures for one application, taking the census once.
    static func requireAddressable(app: AXElement) throws {
        try requireUnlocked()
        guard !windowsAreSubstituted(census: app.windowCensus()) else {
            throw BridgeError.screenLocked(detectedBy: "windowSubstitution")
        }
    }

    static var report: JSONValue {
        var out: [String: JSONValue] = ["locked": .bool(isLocked)]
        if let since = lockedSince { out["lockedSince"] = .string(since) }
        return .object(out)
    }
}
