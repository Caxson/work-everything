import ApplicationServices
import Foundation

/// Attributes fetched in a single round trip for every visited node.
enum NodeAttributes {
    static let batch = [
        kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXValueAttribute,
        kAXDescriptionAttribute, "AXIdentifier", kAXPositionAttribute, kAXSizeAttribute,
        // Chromium/WebKit web content: the DOM class list and id are by far the most
        // stable selectors inside an Electron app, so they are first-class here.
        "AXDOMClassList", "AXDOMIdentifier"
    ]
}

/// Builds the flat JSON description of a single element (no children).
enum NodeBuilder {
    static func describe(_ element: AXElement) -> [String: JSONValue] {
        let values = element.copyMultiple(NodeAttributes.batch)
        var node: [String: JSONValue] = ["nodeId": .int(element.nodeId)]
        node["role"] = string(values[kAXRoleAttribute]) ?? .string("AXUnknown")
        put(&node, "subrole", string(values[kAXSubroleAttribute]))
        put(&node, "title", string(values[kAXTitleAttribute]))
        put(&node, "description", string(values[kAXDescriptionAttribute]))
        put(&node, "identifier", string(values["AXIdentifier"]))
        if let raw = values[kAXValueAttribute] {
            let coerced = JSONCoercion.toJSON(raw)
            if case .null = coerced {} else { node["value"] = coerced }
        }
        if let frame = frame(position: values[kAXPositionAttribute], size: values[kAXSizeAttribute]) {
            node["frame"] = frame
        }
        put(&node, "domId", string(values["AXDOMIdentifier"]))
        if let classes = classList(values["AXDOMClassList"]), !classes.isEmpty {
            node["domClasses"] = .array(classes.map { .string($0) })
        }
        return node
    }

    private static func put(_ node: inout [String: JSONValue], _ key: String, _ value: JSONValue?) {
        guard let value = value, case .string(let s) = value, !s.isEmpty else { return }
        node[key] = value
    }

    private static func string(_ value: CFTypeRef?) -> JSONValue? {
        guard let value = value, CFGetTypeID(value) == CFStringGetTypeID() else { return nil }
        return JSONCoercion.toJSON(value)
    }

    static func classList(_ value: CFTypeRef?) -> [String]? {
        guard let value = value, CFGetTypeID(value) == CFArrayGetTypeID() else { return nil }
        return (value as! CFArray as [AnyObject]).compactMap { $0 as? String }
    }

    private static func frame(position: CFTypeRef?, size: CFTypeRef?) -> JSONValue? {
        guard let position = position, let size = size,
              case .object(let p) = JSONCoercion.toJSON(position),
              case .object(let s) = JSONCoercion.toJSON(size),
              let x = p["x"]?.doubleValue, let y = p["y"]?.doubleValue,
              let w = s["w"]?.doubleValue, let h = s["h"]?.doubleValue else { return nil }
        return .object(["x": .double(x), "y": .double(y), "w": .double(w), "h": .double(h)])
    }
}

/// Depth- and node-budgeted recursive dump. Budgets are mandatory: an Electron app
/// can expose tens of thousands of nodes and an unbounded walk never returns.
struct TreeDumper {
    let maxDepth: Int
    let maxNodes: Int
    private(set) var visited = 0
    private(set) var truncated = false

    init(maxDepth: Int, maxNodes: Int) {
        self.maxDepth = max(0, maxDepth)
        self.maxNodes = max(1, maxNodes)
    }

    mutating func dump(_ element: AXElement, depth: Int = 0) -> JSONValue {
        visited += 1
        var node = NodeBuilder.describe(element)
        let kids = element.children()
        var children: [JSONValue] = []
        if depth < maxDepth {
            for child in kids {
                if visited >= maxNodes { truncated = true; break }
                children.append(dump(child, depth: depth + 1))
            }
        } else if !kids.isEmpty {
            truncated = true
        }
        node["children"] = .array(children)
        return .object(node)
    }

    /// Roots to walk: the whole app, or one window when `windowIndex` is given.
    static func roots(app: AXElement, windowIndex: Int?) throws -> [AXElement] {
        guard let windowIndex = windowIndex else { return [app] }
        let windows = windowList(app: app)
        guard windowIndex >= 0, windowIndex < windows.count else {
            throw BridgeError.badRequest("windowIndex \(windowIndex) out of range (app has \(windows.count) windows)")
        }
        return [windows[windowIndex]]
    }

    static func windowList(app: AXElement) -> [AXElement] {
        app.elementList(app.copy(kAXWindowsAttribute))
    }
}
