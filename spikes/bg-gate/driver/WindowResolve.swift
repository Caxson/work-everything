// AX 窗口枚举 + windowNumber 解析（主路径 SPI + CGWindowList 降级链）
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

struct WindowInfo: Codable {
    var index: Int
    var title: String
    var frame: [Double]        // AX screen space: x, y(top-left origin, y down), w, h
    var windowNumber: Int
    var resolvedBy: String     // axSPI | frameMatch | titleMatch | fallbackLayer0 | none
    var isMain: Bool
    var isFocused: Bool
    var layer: Int
    var cgTitle: String
}

struct CGWindowEntry {
    var number: Int
    var name: String
    var layer: Int
    var bounds: CGRect
    var alpha: Double
}

enum WindowResolver {
    static func axFrame(_ element: AXUIElement) -> CGRect? {
        var posRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success
        else { return nil }
        var origin = CGPoint.zero
        var size = CGSize.zero
        guard let p = posRef, CFGetTypeID(p) == AXValueGetTypeID(),
              AXValueGetValue(p as! AXValue, .cgPoint, &origin) else { return nil }
        guard let s = sizeRef, CFGetTypeID(s) == AXValueGetTypeID(),
              AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: origin, size: size)
    }

    static func stringAttr(_ element: AXUIElement, _ attr: String) -> String {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr as CFString, &ref) == .success else { return "" }
        return (ref as? String) ?? ""
    }

    static func boolAttr(_ element: AXUIElement, _ attr: String) -> Bool {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr as CFString, &ref) == .success else { return false }
        return (ref as? Bool) ?? false
    }

    static func cgWindows(pid: pid_t) -> [CGWindowEntry] {
        guard let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else { return [] }
        return list.compactMap { d in
            guard let owner = d[kCGWindowOwnerPID as String] as? pid_t, owner == pid,
                  let num = d[kCGWindowNumber as String] as? Int else { return nil }
            var bounds = CGRect.zero
            if let b = d[kCGWindowBounds as String] as? [String: Any] {
                bounds = CGRect(x: b["X"] as? Double ?? 0, y: b["Y"] as? Double ?? 0,
                                width: b["Width"] as? Double ?? 0, height: b["Height"] as? Double ?? 0)
            }
            return CGWindowEntry(number: num,
                                 name: d[kCGWindowName as String] as? String ?? "",
                                 layer: d[kCGWindowLayer as String] as? Int ?? 0,
                                 bounds: bounds,
                                 alpha: d[kCGWindowAlpha as String] as? Double ?? 1)
        }
    }

    private static func nearlyEqual(_ a: CGRect, _ b: CGRect, tol: CGFloat = 2) -> Bool {
        abs(a.minX - b.minX) <= tol && abs(a.minY - b.minY) <= tol
            && abs(a.width - b.width) <= tol && abs(a.height - b.height) <= tol
    }

    /// 五级降级链，照 §4.1。
    static func resolveWindowNumber(axWindow: AXUIElement, pid: pid_t, axRect: CGRect?, title: String)
        -> (number: Int, by: String, cgTitle: String, layer: Int)
    {
        let cgList = cgWindows(pid: pid)
        if let wid = SPI.cgWindowID(forAXWindow: axWindow) {
            if let hit = cgList.first(where: { $0.number == Int(wid) }) {
                return (Int(wid), "axSPI", hit.name, hit.layer)
            }
            return (Int(wid), "axSPI(notInList)", "", 0)
        }
        if let rect = axRect {
            if let hit = cgList.first(where: { nearlyEqual($0.bounds, rect, tol: 4) }) {
                return (hit.number, "frameMatch", hit.name, hit.layer)
            }
        }
        if !title.isEmpty {
            if let hit = cgList.first(where: { $0.name == title && (axRect == nil || nearlyEqual($0.bounds, axRect!, tol: 4)) }) {
                return (hit.number, "titleMatch", hit.name, hit.layer)
            }
            if let hit = cgList.first(where: { $0.name == title }) {
                return (hit.number, "titleMatchLoose", hit.name, hit.layer)
            }
        }
        if let hit = cgList.first(where: { $0.layer == 0 }) {
            return (hit.number, "fallbackLayer0", hit.name, hit.layer)
        }
        return (0, "none", "", 0)
    }

    static func windows(pid: pid_t) -> [WindowInfo] {
        let app = AXUIElementCreateApplication(pid)
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &ref) == .success,
              let arr = ref as? [AXUIElement] else { return [] }
        var mainWindowNumber = -1
        var mainRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, kAXMainWindowAttribute as CFString, &mainRef) == .success,
           let mw = mainRef, CFGetTypeID(mw) == AXUIElementGetTypeID() {
            if let wid = SPI.cgWindowID(forAXWindow: mw as! AXUIElement) { mainWindowNumber = Int(wid) }
        }
        return arr.enumerated().map { (i, w) in
            let rect = axFrame(w)
            let title = stringAttr(w, kAXTitleAttribute as String)
            let r = resolveWindowNumber(axWindow: w, pid: pid, axRect: rect, title: title)
            return WindowInfo(index: i,
                              title: title,
                              frame: rect.map { [$0.minX, $0.minY, $0.width, $0.height] } ?? [],
                              windowNumber: r.number,
                              resolvedBy: r.by,
                              isMain: boolAttr(w, kAXMainAttribute as String) || (mainWindowNumber != -1 && mainWindowNumber == r.number),
                              isFocused: boolAttr(w, kAXFocusedAttribute as String),
                              layer: r.layer,
                              cgTitle: r.cgTitle)
        }
    }

    static func axWindow(pid: pid_t, index: Int) -> AXUIElement? {
        let app = AXUIElementCreateApplication(pid)
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &ref) == .success,
              let arr = ref as? [AXUIElement], index >= 0, index < arr.count else { return nil }
        return arr[index]
    }
}

// MARK: - 坐标空间

enum Coords {
    /// AX 屏幕坐标(左上原点,y向下) → 窗口内左下原点
    static func windowLocal(fromAXScreen p: CGPoint, frame: CGRect) -> CGPoint {
        CGPoint(x: p.x - frame.minX, y: frame.height - (p.y - frame.minY))
    }
    /// 窗口内左下原点 → Quartz 窗口内左上原点（CGEventSetWindowLocation 的入参）
    static func quartz(fromWindowLocal p: CGPoint, windowHeight: CGFloat) -> CGPoint {
        CGPoint(x: p.x, y: windowHeight - p.y)
    }
    static func quartz(fromAXScreen p: CGPoint, frame: CGRect) -> CGPoint {
        quartz(fromWindowLocal: windowLocal(fromAXScreen: p, frame: frame), windowHeight: frame.height)
    }
}
