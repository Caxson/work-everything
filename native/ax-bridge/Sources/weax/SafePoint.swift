import ApplicationServices
import CoreGraphics
import Foundation

/// Finding somewhere inside a window that can be clicked without pressing anything.
///
/// Making a window key requires one real click inside it — an `appKitDefined` primer
/// alone gets the application to `isActive` and leaves every window not key (measured).
/// So the click has to happen, and the only question is where it lands. A click at the
/// window's centre is what the reference implementation does and it is not safe: measured
/// on a probe with a centred button, the primer pressed it.
///
/// The point is chosen by clearance rather than by rule: every interactive element in the
/// window contributes an exclusion rectangle, candidates are scored by their distance to
/// the nearest one, and the best is returned only if it clears the margin. When nothing
/// clears it, this reports `NO_SAFE_POINT` instead of clicking anyway — a primer that
/// presses a button is worse than a primer that did not happen.
enum SafePoint {
    /// Roles that do something when clicked. Deliberately broad: a false positive costs a
    /// candidate point, a false negative costs the user a misfired control.
    static let interactiveRoles: Set<String> = [
        "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton",
        "AXMenuItem", "AXMenuBarItem", "AXLink", "AXTextField", "AXTextArea",
        "AXComboBox", "AXSlider", "AXIncrementor", "AXStepper", "AXDisclosureTriangle",
        "AXCell", "AXRow", "AXTabGroup", "AXRadioGroup", "AXSwitch", "AXToggle",
        "AXColorWell", "AXSearchField", "AXImage"
    ]

    /// The traffic lights sit here and pressing one closes, minimises or zooms the user's
    /// window. They are usually in the tree and would be excluded by clearance anyway;
    /// this strip is hard-excluded because "usually" is not good enough for that outcome.
    static let trafficLightWidth: CGFloat = 120

    struct Choice {
        let point: CGPoint
        let clearance: CGFloat
        let region: String
        let obstacles: Int

        var json: JSONValue {
            .object([
                "x": .double(point.x), "y": .double(point.y),
                "clearance": .double(Double(clearance)),
                "region": .string(region),
                "obstacles": .int(obstacles)
            ])
        }
    }

    // MARK: - Obstacles

    /// Frames of everything clickable inside the window, from a budgeted walk.
    static func obstacles(in window: AXElement, frame: CGRect,
                          maxNodes: Int = 4_000, maxDepth: Int = 30) -> [CGRect] {
        var found: [CGRect] = []
        var visited = 0

        func walk(_ element: AXElement, _ depth: Int) {
            guard visited < maxNodes else { return }
            visited += 1
            let values = element.copyMultiple([kAXRoleAttribute, kAXPositionAttribute, kAXSizeAttribute])
            if let role = values[kAXRoleAttribute] as? String, interactiveRoles.contains(role),
               let rect = WindowResolver.frame(of: element), rect.width > 0, rect.height > 0,
               rect.intersects(frame) {
                found.append(rect)
            }
            guard depth < maxDepth else { return }
            for child in element.children() { walk(child, depth + 1) }
        }

        walk(window, 0)
        return found
    }

    // MARK: - Scoring

    /// Zero when the point is inside the rectangle, otherwise the distance to its edge.
    private static func distance(from point: CGPoint, to rect: CGRect) -> CGFloat {
        let dx = max(rect.minX - point.x, 0, point.x - rect.maxX)
        let dy = max(rect.minY - point.y, 0, point.y - rect.maxY)
        return (dx * dx + dy * dy).squareRoot()
    }

    private static func clearance(of point: CGPoint, against rects: [CGRect]) -> CGFloat {
        rects.reduce(CGFloat.greatestFiniteMagnitude) { min($0, distance(from: point, to: $1)) }
    }

    // MARK: - Candidates

    private static func titleBarCandidates(frame: CGRect, titleBarHeight: CGFloat) -> [CGPoint] {
        let left = frame.minX + trafficLightWidth
        let right = frame.maxX - 12
        guard right > left, titleBarHeight >= 8 else { return [] }
        let y = frame.minY + titleBarHeight / 2
        let steps = 12
        return (0...steps).map { CGPoint(x: left + (right - left) * CGFloat($0) / CGFloat(steps), y: y) }
    }

    private static func bodyCandidates(frame: CGRect, titleBarHeight: CGFloat) -> [CGPoint] {
        let inset: CGFloat = 12
        let top = frame.minY + max(titleBarHeight, inset)
        let bottom = frame.maxY - inset
        let left = frame.minX + inset
        let right = frame.maxX - inset
        guard bottom > top, right > left else { return [] }
        let columns = 9, rows = 7
        var points: [CGPoint] = []
        for row in 0...rows {
            for column in 0...columns {
                points.append(CGPoint(x: left + (right - left) * CGFloat(column) / CGFloat(columns),
                                      y: top + (bottom - top) * CGFloat(row) / CGFloat(rows)))
            }
        }
        return points
    }

    // MARK: - Choice

    /// Best candidate in the title bar, else best in the body. The title bar is preferred
    /// because clicking it makes a window key and is the one region designed to have
    /// nothing behind it.
    static func choose(window: AXElement, frame: CGRect, titleBarHeight: CGFloat = 28,
                       minClearance: CGFloat = 6) throws -> Choice {
        guard frame.width > 0, frame.height > 0 else {
            throw BridgeError(code: "NO_FRAME", message: "window has a zero-sized frame; no point can be chosen")
        }
        let rects = obstacles(in: window, frame: frame)

        for (region, candidates) in [("titleBar", titleBarCandidates(frame: frame, titleBarHeight: titleBarHeight)),
                                     ("body", bodyCandidates(frame: frame, titleBarHeight: titleBarHeight))] {
            guard let best = candidates.max(by: { clearance(of: $0, against: rects) < clearance(of: $1, against: rects) })
            else { continue }
            let score = clearance(of: best, against: rects)
            guard score >= minClearance else { continue }
            return Choice(point: best, clearance: min(score, 1e6), region: region, obstacles: rects.count)
        }

        throw BridgeError(
            code: "NO_SAFE_POINT",
            message: "every candidate point in this window is within \(Int(minClearance))pt of something clickable "
                + "(\(rects.count) interactive elements); pass an explicit safePoint to activate it",
            details: .object(["obstacles": .int(rects.count),
                              "frame": .object(["x": .double(frame.minX), "y": .double(frame.minY),
                                                "w": .double(frame.width), "h": .double(frame.height)])]))
    }
}
