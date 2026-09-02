import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// Is a symptom this process's, or the machine's?
///
/// One process is never evidence about the machine, and this file exists because
/// that mistake has now been made here twice. First when `desktopOwnersOnScreen <= 1`
/// stood in for "the desktop is not compositing", which is exactly the reading a single
/// full-screen application produces. Then when one application exposing no window on an
/// inactive Space was reported as "macOS does not composite windows on another Space, and
/// accessibility follows the compositor". Measured, with Chrome full-screen and everything
/// else on the Space behind it:
///
/// ```
///   Finder     AppKit       AXWindows 3    CGWindows 3, 0 on screen
///   系统设置    AppKit       AXWindows 1    CGWindows 1, 0
///   备忘录      AppKit       AXWindows 1    CGWindows 1, 0
///   Terminal   AppKit       AXWindows 2    CGWindows 2, 0
///   微信        AppKit/CEF   AXWindows 2    CGWindows 6, 0
///   飞书        CEF          AXWindows 0    CGWindows 6, 0
/// ```
///
/// Accessibility does **not** follow the compositor. Native applications on an inactive
/// Space expose their windows perfectly well, and 微信 — an IM with CEF components, six
/// windows and none of them on screen — exposes two. The one application that goes blind
/// is 飞书, whose CEF layer destroys the accessibility tree when the web contents are
/// hidden (`WebContents::WasHidden()`) and which refuses both force-build switches:
/// `AXEnhancedUserInterface` answers notImplemented and `AXManualAccessibility` answers
/// attributeUnsupported. Nothing is being hidden from the reader — the tree is not built,
/// which is why no read path for it can exist.
///
/// So a diagnosis attributes nothing to the machine until it has taken a control reading
/// from another application **in the same predicament**, and says which of the two it is.
/// The predicament is the parameter: a control on the active Space would prove nothing
/// about the inactive one, and a control with no windows of its own proves nothing at all.
///
/// The asymmetry is deliberate. A control that returns real windows is positive proof that
/// accessibility works there, so the search stops at the first one. A control that is blind
/// proves much less — it could be another CEF application — so being blind is reported as
/// what it is, evidence rather than proof, and the caller decides what to claim.
enum ControlProbe {
    /// One control application, censused.
    struct Reading {
        let pid: pid_t
        let name: String
        let cgWindows: Int
        let onScreen: Int
        let census: AXElement.ElementCensus

        /// Positive evidence: real, non-placeholder windows came back.
        var exposesWindows: Bool { !census.real.isEmpty }

        /// `conclusive` is the whole point of the reading and is true in one direction
        /// only: a control that exposes windows proves accessibility works here, while a
        /// control that is blind could be blind for its own reasons.
        func json(checked: Int, conclusive: Bool) -> JSONValue {
            .object([
                "pid": .int(Int(pid)),
                "name": .string(name),
                "cgWindows": .int(cgWindows),
                "onScreen": .int(onScreen),
                "axWindows": census.json,
                "exposesWindows": .bool(exposesWindows),
                "checked": .int(checked),
                "conclusive": .bool(conclusive)
            ])
        }
    }

    enum Outcome {
        /// Nothing on this machine was in the same state, so nothing was learned.
        case unavailable(checked: Int)
        /// A peer in the same state exposes its windows: accessibility works here.
        case exposesWindows(Reading)
        /// Every peer checked is blind too.
        case blind(Reading, checked: Int)

        var json: JSONValue {
            switch self {
            case .unavailable(let checked):
                return .object(["checked": .int(checked), "conclusive": .bool(false)])
            case .exposesWindows(let reading):
                return reading.json(checked: 1, conclusive: true)
            case .blind(let reading, let checked):
                return reading.json(checked: checked, conclusive: false)
            }
        }
    }

    /// How many controls are worth censusing. Each is one accessibility round trip on a
    /// path that has already failed, bounded by `controlTimeout`.
    private static let maxControls = 3

    /// Shorter than the ordinary two seconds: a control is diagnostic, and one that does
    /// not answer promptly is reported as no control rather than made to hold the answer up.
    private static let controlTimeout: Float = 0.5

    /// A control for "this application's windows are all off screen".
    ///
    /// The pool is every *other* regular application whose ordinary windows the window
    /// server knows about and composites none of — the same predicament, which is what
    /// makes the reading comparable. Ranked by window count, because an application with
    /// more windows is a stronger control than one with a single utility panel.
    static func offscreenPeer(excluding target: pid_t) -> Outcome {
        probe(candidates: offscreenOwners(excluding: target))
    }

    // MARK: - Internals

    private struct Candidate {
        let pid: pid_t
        let name: String
        let windows: Int
        let onScreen: Int
    }

    private static func probe(candidates: [Candidate]) -> Outcome {
        var blind: Reading?
        var checked = 0
        for candidate in candidates.prefix(maxControls) {
            let app = AXElement.application(pid: candidate.pid, timeout: controlTimeout)
            let reading = Reading(pid: candidate.pid,
                                  name: candidate.name,
                                  cgWindows: candidate.windows,
                                  onScreen: candidate.onScreen,
                                  census: app.windowCensus())
            checked += 1
            if reading.exposesWindows { return .exposesWindows(reading) }
            if blind == nil { blind = reading }
        }
        guard let blind else { return .unavailable(checked: checked) }
        return .blind(blind, checked: checked)
    }

    /// Regular applications with ordinary windows, none of them composited.
    ///
    /// Restricted to `.regular` because an agent's windows are not a comparable control:
    /// a menu-bar process legitimately exposes nothing, and reading that as "blind" would
    /// manufacture the machine-wide claim this whole file exists to prevent.
    private static func offscreenOwners(excluding target: pid_t) -> [Candidate] {
        guard let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]
        else { return [] }

        var total: [pid_t: Int] = [:]
        var onScreen: [pid_t: Int] = [:]
        for entry in list {
            guard (entry[kCGWindowLayer as String] as? Int ?? 0) == 0,
                  let owner = entry[kCGWindowOwnerPID as String] as? pid_t, owner != target else { continue }
            total[owner, default: 0] += 1
            if entry[kCGWindowIsOnscreen as String] as? Bool ?? false { onScreen[owner, default: 0] += 1 }
        }

        return total
            .filter { $0.value > 0 && (onScreen[$0.key] ?? 0) == 0 }
            .compactMap { pid, windows in
                guard let app = NSRunningApplication(processIdentifier: pid), app.activationPolicy == .regular
                else { return nil }
                return Candidate(pid: pid, name: app.localizedName ?? "", windows: windows, onScreen: 0)
            }
            // Deterministic: most windows first, then lowest pid, so two runs against an
            // unchanged machine name the same control.
            .sorted { $0.windows == $1.windows ? $0.pid < $1.pid : $0.windows > $1.windows }
    }
}
