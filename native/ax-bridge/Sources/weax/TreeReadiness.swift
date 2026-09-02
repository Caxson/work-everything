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
        /// Web areas with something under them.
        ///
        /// A web area can exist and be empty, and that is not a rare shape: measured with
        /// 飞书's window on a Space nobody was looking at, its window subtree held two
        /// `AXWebArea` nodes inside sixty-four nodes of shell — no conversation, no
        /// composer, no messages — while the same application on the active Space exposes
        /// the lot. `webAreas > 0` called that ready, which is the same class of mistake as
        /// judging by node count: a signal that is present without the thing it stands for.
        var populatedWebAreas = 0
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
            let isWebArea = element.string(kAXRoleAttribute) == webAreaRole
            if isWebArea { census.webAreas += 1 }
            guard depth < maxDepth else {
                census.truncated = true
                return
            }
            // Read once: `children()` is a round trip to the target process, and the
            // populated check and the walk both want the same answer.
            let children = element.children()
            if isWebArea, !children.isEmpty { census.populatedWebAreas += 1 }
            for child in children { walk(child, depth + 1) }
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
            if last.populatedWebAreas > 0 {
                return report(last, polls: polls, since: started, ready: true)
            }
            if Date() >= deadline { break }
            usleep(UInt32(max(1, pollMs) * 1000))
        } while Date() < deadline

        // The two failures are told apart because they mean different things to a caller:
        // no web area at all is a tree that has not been built, while an empty one is a
        // tree that has been built around content the application is not exposing.
        let detail = last.webAreas == 0
            ? "no \(webAreaRole) appeared"
            : "\(last.webAreas) \(webAreaRole)(s) appeared and every one of them is empty"
        throw BridgeError(
            code: "TREE_NOT_READY",
            message: "\(detail) within \(timeoutMs)ms after \(polls) traversal(s); the last saw "
                + "\(last.nodes) node(s). A count in the hundreds with no web area is the menu bar "
                + "alone; a web area with nothing under it is the window's shell without its "
                + "content, which is what an application whose window is on another Space exposes",
            details: report(last, polls: polls, since: started, ready: false))
    }

    private static func report(_ census: Census, polls: Int, since: Date, ready: Bool) -> JSONValue {
        .object([
            "ready": .bool(ready),
            "nodes": .int(census.nodes),
            "webAreas": .int(census.webAreas),
            "populatedWebAreas": .int(census.populatedWebAreas),
            "truncated": .bool(census.truncated),
            "polls": .int(polls),
            "elapsedMs": .int(Int(Date().timeIntervalSince(since) * 1000))
        ])
    }
}
