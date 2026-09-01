import ApplicationServices
import Foundation

/// Declarative, application-agnostic node selector. Every field is optional and all
/// supplied fields must match (AND).
struct Selector {
    var role: String?
    var subrole: String?
    var title: String?
    var titleContains: String?
    var identifier: String?
    var valueContains: String?
    var descriptionContains: String?
    var domId: String?
    var domClass: String?
    var maxResults: Int = 50

    static func parse(_ value: JSONValue) throws -> Selector {
        guard let obj = value.objectValue else { throw BridgeError.badRequest("'selector' must be an object") }
        var s = Selector()
        s.role = obj["role"]?.stringValue
        s.subrole = obj["subrole"]?.stringValue
        s.title = obj["title"]?.stringValue
        s.titleContains = obj["titleContains"]?.stringValue
        s.identifier = obj["identifier"]?.stringValue
        s.valueContains = obj["valueContains"]?.stringValue
        s.descriptionContains = obj["descriptionContains"]?.stringValue
        s.domId = obj["domId"]?.stringValue
        s.domClass = obj["domClass"]?.stringValue
        s.maxResults = max(1, obj["maxResults"]?.intValue ?? 50)
        if s.isEmpty { throw BridgeError.badRequest("'selector' must constrain at least one field") }
        return s
    }

    var isEmpty: Bool {
        role == nil && subrole == nil && title == nil && titleContains == nil
            && identifier == nil && valueContains == nil && descriptionContains == nil
            && domId == nil && domClass == nil
    }

    func matches(_ node: [String: JSONValue]) -> Bool {
        if let role = role, node["role"]?.stringValue != role { return false }
        if let subrole = subrole, node["subrole"]?.stringValue != subrole { return false }
        if let title = title, node["title"]?.stringValue != title { return false }
        if let identifier = identifier, node["identifier"]?.stringValue != identifier { return false }
        if let needle = titleContains, !contains(node["title"], needle) { return false }
        if let needle = descriptionContains, !contains(node["description"], needle) { return false }
        if let needle = valueContains, !contains(node["value"], needle) { return false }
        if let domId = domId, node["domId"]?.stringValue != domId { return false }
        if let domClass = domClass, !hasClass(node["domClasses"], domClass) { return false }
        return true
    }

    private func hasClass(_ value: JSONValue?, _ name: String) -> Bool {
        guard let list = value?.arrayValue else { return false }
        return list.contains { $0.stringValue == name }
    }

    private func contains(_ value: JSONValue?, _ needle: String) -> Bool {
        guard let text = value?.stringValue else { return false }
        return text.range(of: needle, options: .caseInsensitive) != nil
    }
}

/// Depth-first search with hard traversal budgets so a pathological tree cannot hang
/// the bridge. Matched nodes are returned flat (no children) plus their depth.
struct Finder {
    let selector: Selector
    let maxDepth: Int
    let maxVisits: Int

    init(selector: Selector, maxDepth: Int = 60, maxVisits: Int = 30_000) {
        self.selector = selector
        self.maxDepth = maxDepth
        self.maxVisits = maxVisits
    }

    func run(roots: [AXElement]) -> (matches: [JSONValue], visited: Int, truncated: Bool) {
        var results: [JSONValue] = []
        var visited = 0
        var truncated = false

        func walk(_ element: AXElement, _ depth: Int) {
            if results.count >= selector.maxResults || visited >= maxVisits { truncated = true; return }
            visited += 1
            var node = NodeBuilder.describe(element)
            if selector.matches(node) {
                node["depth"] = .int(depth)
                results.append(.object(node))
                if results.count >= selector.maxResults { return }
            }
            guard depth < maxDepth else { truncated = true; return }
            for child in element.children() {
                if results.count >= selector.maxResults || visited >= maxVisits { break }
                walk(child, depth + 1)
            }
        }

        for root in roots { walk(root, 0) }
        return (results, visited, truncated && results.count < selector.maxResults)
    }
}
