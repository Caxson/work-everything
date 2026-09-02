import ApplicationServices
import Foundation

/// CFEqual/CFHash-based box so AXUIElement can be a dictionary key.
private struct ElementKey: Hashable {
    let ref: AXUIElement
    static func == (a: ElementKey, b: ElementKey) -> Bool { CFEqual(a.ref, b.ref) }
    func hash(into hasher: inout Hasher) { hasher.combine(CFHash(ref)) }
}

/// Maps opaque, connection-local integer handles to live AXUIElement references.
/// Confined to the main thread (every op is dispatched there), so no locking.
///
/// One registry per client, not per process — see `Connection`. A handle is only ever
/// meaningful to the connection that minted it, and two clients numbering from 1 in
/// parallel must never resolve each other's elements.
final class ElementRegistry {
    private var nextId = 1
    private var byId: [Int: AXUIElement] = [:]
    private var idByElement: [ElementKey: Int] = [:]

    /// Stable: the same AXUIElement always gets the same nodeId within one connection.
    @discardableResult
    func handle(for element: AXUIElement) -> Int {
        let key = ElementKey(ref: element)
        if let existing = idByElement[key] { return existing }
        let id = nextId
        nextId += 1
        byId[id] = element
        idByElement[key] = id
        return id
    }

    func element(for id: Int) throws -> AXUIElement {
        guard let e = byId[id] else { throw BridgeError.noSuchNode(id) }
        return e
    }

    var count: Int { byId.count }
}
