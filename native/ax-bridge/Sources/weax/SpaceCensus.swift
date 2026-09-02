import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// Whether the Space being looked at belongs to a full-screen application.
///
/// This is a machine state with the same shape as a locked screen, and it was measured
/// rather than assumed. With Chrome full-screen on a single display:
///
/// ```
///   Chrome frontmost   飞书 AXWindows = 0, CGWindows 6, none on screen
///   飞书 activated      飞书 AXWindows = 1, addressable, 1397x937 at (125,105)
///   Chrome frontmost    飞书 AXWindows = 0 again
/// ```
///
/// macOS does not composite windows belonging to another Space, and for this application
/// accessibility follows the compositor rather than the window list — so an agent can
/// neither read nor drive any other application while a full-screen app owns the active
/// Space. Retrying does not help and there is nothing wrong with the machine.
///
/// It is emphatically not "the desktop is not compositing": the desktop is compositing one
/// application perfectly well, at full size. That wording is what `desktopOwnersOnScreen
/// <= 1` used to produce here, and a full-screen app is *exactly* one owner on screen —
/// the same shape of mistake as naming a screen saver from the presence of its host
/// process.
enum SpaceCensus {
    struct Reading {
        /// The answer callers branch on.
        let fullScreen: Bool
        /// Which signals said so, so a diagnosis can explain itself rather than assert.
        let evidence: [String]
        /// Present when the private Space list could be read. `nil` means it was not
        /// available, which is not the same as "one Space": absence must never read as a
        /// negative.
        let spaces: Int?
        let currentSpaceType: Int?
        let frontmostApp: String?

        var json: JSONValue {
            var out: [String: JSONValue] = [
                "fullScreen": .bool(fullScreen),
                "evidence": .array(evidence.map { .string($0) })
            ]
            if let spaces { out["spaces"] = .int(spaces) }
            if let currentSpaceType { out["currentSpaceType"] = .int(currentSpaceType) }
            if let frontmostApp { out["frontmostApp"] = .string(frontmostApp) }
            return .object(out)
        }
    }

    /// Two independent signals, because either one alone has a hole.
    ///
    /// `AXFullScreen` on the frontmost application's windows is public API and needs no
    /// SPI, but it only sees the frontmost app — a full-screen Space whose application is
    /// not frontmost reads false. The Space list is authoritative about which Space is
    /// current but is private, and a macOS that stops vending it has to degrade to the
    /// public signal rather than to a wrong answer. Either one saying yes is taken as yes,
    /// and both are reported.
    static func read() -> Reading {
        var evidence: [String] = []
        let front = NSWorkspace.shared.frontmostApplication

        if frontmostWindowIsFullScreen(front) { evidence.append("AXFullScreen") }

        let spaces = managedSpaces()
        if let type = spaces?.currentType, type != normalDesktopSpaceType {
            evidence.append("currentSpaceType=\(type)")
        }

        return Reading(
            fullScreen: !evidence.isEmpty,
            evidence: evidence,
            spaces: spaces?.count,
            currentSpaceType: spaces?.currentType,
            frontmostApp: front?.localizedName
        )
    }

    // MARK: - Public signal

    /// Read through `AXElement.application`, not a bare `AXUIElementCreateApplication`,
    /// because that is what carries the messaging timeout. This runs inside `diagnoseEmpty`,
    /// which a poll reaches every few seconds, and it asks *the frontmost application* —
    /// so a hung foreground app would otherwise block every diagnosis behind it, including
    /// the ones about a different process entirely.
    private static func frontmostWindowIsFullScreen(_ app: NSRunningApplication?) -> Bool {
        guard let pid = app?.processIdentifier else { return false }
        guard let windows = AXElement.application(pid: pid).copy(kAXWindowsAttribute as String) as? [AXUIElement]
        else { return false }
        return windows.contains { window in
            var flag: CFTypeRef?
            guard AXUIElementCopyAttributeValue(window, "AXFullScreen" as CFString, &flag) == .success
            else { return false }
            return (flag as? Bool) == true || (flag as? Int) == 1
        }
    }

    // MARK: - Private signal

    /// A Space the person put windows on themselves. Full-screen and tiled Spaces carry
    /// other values; anything that is not this is a Space other applications are not drawn
    /// on, which is the property that matters here.
    private static let normalDesktopSpaceType = 0

    private typealias ConnectionFn = @convention(c) () -> Int32
    private typealias CopySpacesFn = @convention(c) (Int32) -> CFArray?

    /// Resolved once. `diagnoseEmpty` runs on a poll, and looking the symbols up every time
    /// would take a handle reference per call for an answer that cannot change while the
    /// process lives. `nil` here means this macOS does not vend them, which is a permanent
    /// fact about the machine and is why it is safe to cache.
    private static let symbols: (connection: ConnectionFn, copy: CopySpacesFn)? = {
        guard let handle = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW),
              let connectionSymbol = dlsym(handle, "_CGSDefaultConnection"),
              let copySymbol = dlsym(handle, "CGSCopyManagedDisplaySpaces") else { return nil }
        return (unsafeBitCast(connectionSymbol, to: ConnectionFn.self),
                unsafeBitCast(copySymbol, to: CopySpacesFn.self))
    }()

    private static func managedSpaces() -> (count: Int, currentType: Int?)? {
        guard let symbols else { return nil }
        let connection = symbols.connection()
        guard let displays = symbols.copy(connection) as? [[String: Any]] else { return nil }

        var total = 0
        var currentType: Int?
        for display in displays {
            let spaces = display["Spaces"] as? [[String: Any]] ?? []
            total += spaces.count
            // The current Space is named by id and its type lives in the list, so the two
            // have to be joined — the "Current Space" entry alone does not carry the type
            // on every macOS that vends this.
            guard let currentId = (display["Current Space"] as? [String: Any])?["ManagedSpaceID"] as? Int
            else { continue }
            if let match = spaces.first(where: { ($0["ManagedSpaceID"] as? Int) == currentId }) {
                currentType = match["type"] as? Int
            }
        }
        return (total, currentType)
    }
}
