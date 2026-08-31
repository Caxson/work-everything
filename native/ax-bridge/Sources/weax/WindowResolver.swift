import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// One addressable window: its accessibility identity joined to its window-server number.
struct ResolvedWindow {
    let index: Int
    let element: AXElement
    let title: String
    let frame: CGRect?
    let windowNumber: Int
    let resolvedBy: String
    let isMain: Bool
    let isFocused: Bool
    let isMinimized: Bool
    let layer: Int
    let cgTitle: String

    /// Background dispatch needs a window number; `windowLocation` additionally needs a
    /// frame. A window without a number cannot be addressed at all.
    var addressable: Bool { windowNumber != 0 }

    var json: JSONValue {
        var out: [String: JSONValue] = [
            "index": .int(index),
            "nodeId": .int(element.nodeId),
            "title": .string(title),
            "windowNumber": .int(windowNumber),
            "resolvedBy": .string(resolvedBy),
            "addressable": .bool(addressable),
            "isMain": .bool(isMain),
            "isFocused": .bool(isFocused),
            "isMinimized": .bool(isMinimized),
            "layer": .int(layer)
        ]
        if let frame = frame {
            out["frame"] = .object([
                "x": .double(frame.minX), "y": .double(frame.minY),
                "w": .double(frame.width), "h": .double(frame.height)
            ])
        }
        if !cgTitle.isEmpty, cgTitle != title { out["cgTitle"] = .string(cgTitle) }
        return .object(out)
    }
}

/// A window as the window server sees it. Survives a screen lock, which is the only
/// reason the degradation chain below is worth having.
struct CGWindowEntry {
    let number: Int
    let name: String
    let layer: Int
    let bounds: CGRect
    let onScreen: Bool
}

enum WindowResolver {
    // MARK: - Window server

    static func cgWindows(pid: pid_t, onScreenOnly: Bool = false) -> [CGWindowEntry] {
        let options: CGWindowListOption = onScreenOnly ? [.optionOnScreenOnly] : [.optionAll]
        guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return [] }
        return list.compactMap { entry in
            guard let owner = entry[kCGWindowOwnerPID as String] as? pid_t, owner == pid,
                  let number = entry[kCGWindowNumber as String] as? Int else { return nil }
            var bounds = CGRect.zero
            if let raw = entry[kCGWindowBounds as String] as? [String: Any] {
                bounds = CGRect(x: raw["X"] as? Double ?? 0, y: raw["Y"] as? Double ?? 0,
                                width: raw["Width"] as? Double ?? 0, height: raw["Height"] as? Double ?? 0)
            }
            return CGWindowEntry(number: number,
                                 name: entry[kCGWindowName as String] as? String ?? "",
                                 layer: entry[kCGWindowLayer as String] as? Int ?? 0,
                                 bounds: bounds,
                                 onScreen: entry[kCGWindowIsOnscreen as String] as? Bool ?? false)
        }
    }

    // MARK: - Number resolution

    private static func nearlyEqual(_ a: CGRect, _ b: CGRect, tolerance: CGFloat = 4) -> Bool {
        abs(a.minX - b.minX) <= tolerance && abs(a.minY - b.minY) <= tolerance
            && abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
    }

    /// Private SPI first, then progressively weaker joins against the window server.
    /// Which link answered is reported as `resolvedBy` — a caller that cares about
    /// precision can refuse anything below `axSPI`.
    private static func number(for window: AXElement, among candidates: [CGWindowEntry],
                               frame: CGRect?, title: String) -> (number: Int, by: String, entry: CGWindowEntry?) {
        if let wid = SPI.windowNumber(forAXWindow: window.ref) {
            return (wid, "axSPI", candidates.first { $0.number == wid })
        }
        if let frame = frame, let hit = candidates.first(where: { nearlyEqual($0.bounds, frame) }) {
            return (hit.number, "frameMatch", hit)
        }
        if !title.isEmpty {
            if let hit = candidates.first(where: {
                $0.name == title && (frame == nil || nearlyEqual($0.bounds, frame!))
            }) {
                return (hit.number, "titleMatch", hit)
            }
            if let hit = candidates.first(where: { $0.name == title }) {
                return (hit.number, "titleMatchLoose", hit)
            }
        }
        if let hit = candidates.first(where: { $0.layer == 0 }) {
            return (hit.number, "fallbackLayer0", hit)
        }
        return (0, "none", nil)
    }

    // MARK: - Enumeration

    /// Every AX window of `pid`, joined to its window number.
    ///
    /// An empty answer is never returned as an empty answer. There are three ways a window
    /// list comes back with nothing usable in it, they are told apart here, and each one
    /// leaves as its own error:
    ///
    /// * `SCREEN_LOCKED` — the count is right and every entry is the application element.
    ///   Nothing but a person unlocking the machine changes this, so a caller that retries
    ///   is burning cycles against a wall.
    /// * `AX_SEES_NO_WINDOWS_BUT_CG_DOES` — accessibility returns success with nothing,
    ///   while the window server has windows for this process and none of them on screen.
    ///   The window never reached the screen; ordering it front does not fix it.
    /// * `NO_WINDOW` — there genuinely is no window. A menu-bar agent, or an application
    ///   closed to the tray.
    ///
    /// The classification runs on the **unfiltered** census. Filtering first would remove
    /// the placeholders that are the entire evidence for the first case, and a locked Mac
    /// would arrive here as a harmless empty array.
    static func windows(pid: pid_t) throws -> [ResolvedWindow] {
        let app = AXElement.application(pid: pid)
        try ScreenLock.requireUnlocked()
        let census = app.windowCensus()
        if ScreenLock.windowsAreSubstituted(census: census) {
            throw BridgeError.screenLocked(detectedBy: "windowSubstitution")
        }
        let elements = census.real
        guard !elements.isEmpty else { throw diagnoseEmpty(pid: pid, census: census) }
        let candidates = cgWindows(pid: pid)
        let mainNumber = elements.isEmpty ? 0 : mainWindowNumber(app: app)
        return elements.enumerated().map { index, window in
            let frame = self.frame(of: window)
            let title = window.string(kAXTitleAttribute) ?? ""
            let resolved = number(for: window, among: candidates, frame: frame, title: title)
            return ResolvedWindow(
                index: index,
                element: window,
                title: title,
                frame: frame,
                windowNumber: resolved.number,
                resolvedBy: resolved.by,
                isMain: window.bool(kAXMainAttribute) || (resolved.number != 0 && resolved.number == mainNumber),
                isFocused: window.bool(kAXFocusedAttribute),
                isMinimized: window.bool(kAXMinimizedAttribute),
                layer: resolved.entry?.layer ?? 0,
                cgTitle: resolved.entry?.name ?? ""
            )
        }
    }

    private static func mainWindowNumber(app: AXElement) -> Int {
        guard let raw = app.copy(kAXMainWindowAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID(),
              !CFEqual(raw as! AXUIElement, app.ref) else { return 0 }
        return SPI.windowNumber(forAXWindow: raw as! AXUIElement) ?? 0
    }

    static func frame(of element: AXElement) -> CGRect? {
        let values = element.copyMultiple([kAXPositionAttribute, kAXSizeAttribute])
        var origin = CGPoint.zero
        var size = CGSize.zero
        guard let position = values[kAXPositionAttribute].flatMap(axValue),
              let sizeValue = values[kAXSizeAttribute].flatMap(axValue),
              AXValueGetValue(position, .cgPoint, &origin),
              AXValueGetValue(sizeValue, .cgSize, &size) else { return nil }
        return CGRect(origin: origin, size: size)
    }

    private static func axValue(_ raw: CFTypeRef) -> AXValue? {
        guard CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        return (raw as! AXValue)
    }

    // MARK: - Selection

    /// Picks the window an op should act on: an explicit number, else an explicit index,
    /// else the main window, else the first addressable one.
    static func select(pid: pid_t, windowNumber: Int?, windowIndex: Int?) throws -> ResolvedWindow {
        let all = try windows(pid: pid)
        if let number = windowNumber {
            guard let hit = all.first(where: { $0.windowNumber == number }) else {
                throw BridgeError(code: "NO_WINDOW",
                                  message: "pid \(pid) has no window numbered \(number)")
            }
            return hit
        }
        if let index = windowIndex {
            guard index >= 0, index < all.count else {
                throw BridgeError.badRequest("windowIndex \(index) out of range (app has \(all.count) windows)")
            }
            return all[index]
        }
        if let main = all.first(where: { $0.isMain && $0.addressable }) { return main }
        guard let first = all.first(where: { $0.addressable }) else {
            throw BridgeError(code: "NO_WINDOW",
                              message: "pid \(pid) exposes \(all.count) window(s), none with a resolvable window number")
        }
        return first
    }

    /// An empty `AXWindows` has several causes with different remedies, and telling a
    /// caller only "no windows" makes it retry forever against the ones it cannot fix.
    ///
    /// The distinguishing evidence is whether *anything else on the machine* is on screen.
    /// When the desktop is compositing normally, one application with no on-screen window
    /// is that application's problem. When nothing is on screen but the frontmost app, the
    /// desktop itself is not drawing — measured with a screen saver running while the
    /// session was still unlocked, which takes accessibility windows away from every
    /// application exactly the way a lock does while reporting nothing at all.
    static func diagnoseEmpty(pid: pid_t, census: AXElement.ElementCensus?) -> BridgeError {
        if ScreenLock.isLocked { return BridgeError.screenLocked(detectedBy: "session") }
        let all = cgWindows(pid: pid)
        let onScreen = all.filter { $0.onScreen }
        let desktop = desktopCensus()
        var details: [String: JSONValue] = [
            "cgWindows": .int(all.count),
            "onScreen": .int(onScreen.count),
            "desktopOnScreen": .int(desktop.windows),
            "desktopOwnersOnScreen": .int(desktop.owners)
        ]
        if let census = census { details["axWindows"] = census.json }
        guard !all.isEmpty, onScreen.isEmpty else {
            return BridgeError(code: "NO_WINDOW",
                               message: "pid \(pid) genuinely exposes no window "
                                   + "(window server reports \(all.count), \(onScreen.count) on screen). "
                                   + "An application closed to the tray, or a menu-bar agent, reads exactly "
                                   + "like this and it is not an error state to recover from",
                               details: .object(details))
        }
        details["scope"] = .string(desktop.owners <= 1 ? "desktop" : "application")
        let cause = desktop.owners <= 1
            ? "nothing on this machine is on screen except the frontmost application, so the desktop is not "
                + "compositing — a running screen saver does this with the session still unlocked, and it "
                + "takes accessibility windows away from every application at once. Only real user activity "
                + "clears it, and CGSSessionScreenIsLocked stays false throughout"
            : "this application's windows are on another space or otherwise not being drawn"
        return BridgeError(
            code: "AX_SEES_NO_WINDOWS_BUT_CG_DOES",
            message: "accessibility returns success with no window for pid \(pid), while the window server "
                + "has \(all.count) and none on screen. Ordering a window front does not fix it: " + cause,
            details: .object(details))
    }

    /// How much of the desktop is being drawn at all, across every process.
    ///
    /// Counted at layer 0 — ordinary application windows. The menu bar and the Dock live
    /// at other layers and are on screen even when nothing else is, so counting every
    /// layer makes a desktop that is drawing nothing look busy.
    static func desktopCensus() -> (windows: Int, owners: Int) {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]
        else { return (0, 0) }
        let ordinary = list.filter { ($0[kCGWindowLayer as String] as? Int ?? 0) == 0 }
        let owners = Set(ordinary.compactMap { $0[kCGWindowOwnerPID as String] as? pid_t })
        return (ordinary.count, owners.count)
    }
}

// MARK: - Coordinate spaces

/// AX screen space (top-left origin, y down) is what `AXPosition` reports and what
/// `CGEvent` takes as a cursor position — they are the same space, so a screen point
/// needs no conversion.
///
/// `CGEventSetWindowLocation` wants the point relative to the window's own top-left,
/// which is the plain difference. AppKit converts to its bottom-left `locationInWindow`
/// itself; doing that here as well double-flips the y axis.
enum Coords {
    static func windowLocal(screenPoint: CGPoint, frame: CGRect) -> CGPoint {
        CGPoint(x: screenPoint.x - frame.minX, y: screenPoint.y - frame.minY)
    }

    static func contains(_ frame: CGRect, _ point: CGPoint) -> Bool {
        frame.contains(point)
    }
}
