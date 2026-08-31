import ApplicationServices
import Foundation

/// A Chromium/CEF accessibility tree is built by the act of reading it.
///
/// Measured on macOS 26.3: the first traversal of a Chrome window returned 38 nodes and
/// no web area; an immediate second traversal, with nothing done in between, returned 44
/// and one. The trigger is a client asking, not activation and not
/// `AXManualAccessibility` — both of which are refused on 26.3 while the tree arrives
/// regardless. Do not gate on them.
///
/// Two consequences that produce silently wrong answers if ignored:
///
/// * The waking is counted **per accessibility client and it decays**. A different
///   process's first traversal saw 311 nodes, all menu bar, and a second read 500ms later
///   had not woken it. So discarding the first result is not one-time setup — every
///   process pays it, every time it goes cold.
/// * Readiness must be judged by **web area count**, never by node count. A bare menu bar
///   is three hundred nodes and clears any plausible threshold.
struct TreeReadiness {
    struct Census {
        var nodes = 0
        var webAreas = 0
        var truncated = false
    }

    private struct Key: Hashable {
        let ref: AXUIElement
        static func == (a: Key, b: Key) -> Bool { CFEqual(a.ref, b.ref) }
        func hash(into hasher: inout Hasher) { hasher.combine(CFHash(ref)) }
    }

    static let webAreaRole = "AXWebArea"

    /// Counts nodes and web areas under `roots`.
    ///
    /// Deduplicates by element identity: without it a self-referential node produces an
    /// unbounded walk that looks like a forty-thousand-node tree of one role.
    static func census(roots: [AXElement], maxNodes: Int = 20_000, maxDepth: Int = 60) -> Census {
        var census = Census()
        var seen = Set<Key>()

        func walk(_ element: AXElement, _ depth: Int) {
            guard census.nodes < maxNodes else {
                census.truncated = true
                return
            }
            guard seen.insert(Key(ref: element.ref)).inserted else { return }
            census.nodes += 1
            if element.string(kAXRoleAttribute) == webAreaRole { census.webAreas += 1 }
            guard depth < maxDepth else {
                census.truncated = true
                return
            }
            for child in element.children() { walk(child, depth + 1) }
        }

        for root in roots { walk(root, 0) }
        return census
    }

    /// Polls until at least one web area appears, or the deadline passes.
    ///
    /// A fixed sleep is not a substitute: 500ms was measured to be enough sometimes and
    /// not others, and the failure mode is a caller acting confidently on a stub.
    static func poll(app: AXElement, windowIndex: Int?, timeoutMs: Int, pollMs: Int,
                      maxNodes: Int, maxDepth: Int) throws -> JSONValue {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        let started = Date()
        var polls = 0
        var last = Census()

        repeat {
            let roots = try TreeDumper.roots(app: app, windowIndex: windowIndex)
            last = census(roots: roots, maxNodes: maxNodes, maxDepth: maxDepth)
            polls += 1
            if last.webAreas > 0 {
                return report(last, polls: polls, since: started, ready: true)
            }
            if Date() >= deadline { break }
            usleep(UInt32(max(1, pollMs) * 1000))
        } while Date() < deadline

        throw BridgeError(
            code: "TREE_NOT_READY",
            message: "no \(webAreaRole) appeared within \(timeoutMs)ms after \(polls) traversal(s); "
                + "the last saw \(last.nodes) node(s). A count in the hundreds with no web area is the "
                + "menu bar alone — the window's web content has not been built",
            details: report(last, polls: polls, since: started, ready: false))
    }

    private static func report(_ census: Census, polls: Int, since: Date, ready: Bool) -> JSONValue {
        .object([
            "ready": .bool(ready),
            "nodes": .int(census.nodes),
            "webAreas": .int(census.webAreas),
            "truncated": .bool(census.truncated),
            "polls": .int(polls),
            "elapsedMs": .int(Int(Date().timeIntervalSince(since) * 1000))
        ])
    }
}
