// bgdrive — 后台 computer use 可行性闸门 probe
// 硬约束：所有事件一律 postToPid；本文件中不存在任何 .cghidEventTap 投递路径。
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// MARK: - 参数

var args = Array(CommandLine.arguments.dropFirst())
let command = args.first ?? "env"
if !args.isEmpty { args.removeFirst() }

func flag(_ name: String) -> Bool { args.contains("--\(name)") }
func opt(_ name: String) -> String? {
    guard let i = args.firstIndex(of: "--\(name)"), i + 1 < args.count else { return nil }
    return args[i + 1]
}
func optAll(_ name: String) -> [String] {
    var out: [String] = []
    for (i, a) in args.enumerated() where a == "--\(name)" && i + 1 < args.count { out.append(args[i + 1]) }
    return out
}
func intOpt(_ name: String, _ def: Int) -> Int { Int(opt(name) ?? "") ?? def }
func pointOpt(_ name: String) -> CGPoint? {
    guard let s = opt(name) else { return nil }
    let p = s.split(separator: ",").compactMap { Double($0) }
    guard p.count == 2 else { return nil }
    return CGPoint(x: p[0], y: p[1])
}

func emit(_ obj: Any) {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    print(String(data: data, encoding: .utf8)!)
}

/// NSWorkspace 在刚启动的短命进程里读 frontmostApplication 会拿到 loginwindow，必须先转 runloop。
func settleWorkspace(_ seconds: TimeInterval = 0.25) {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02)) }
}

func frontmostSnapshot() -> [String: Any] {
    let ws = NSWorkspace.shared
    let f = ws.frontmostApplication
    let active = ws.runningApplications.first { $0.isActive }
    let cursor = CGEvent(source: nil)?.location ?? .zero
    return ["frontmost": f?.localizedName ?? "nil",
            "frontmostPID": Int(f?.processIdentifier ?? -1),
            "activeApp": active?.localizedName ?? "nil",
            "activePID": Int(active?.processIdentifier ?? -1),
            "cursor": [cursor.x, cursor.y]]
}

func cursorPoint() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }
func dist(_ a: CGPoint, _ b: CGPoint) -> Double { ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)).squareRoot() }

let spiReport: [String: Any] = ["setWindowLocation": SPI.setWindowLocationAvailable,
                                "axGetWindow": SPI.axGetWindowAvailable,
                                "axObserverRemote": SPI.axObserverRemoteAvailable]

// MARK: - AX 树遍历

let axNotifications = [
    kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification,
    kAXApplicationActivatedNotification, kAXApplicationDeactivatedNotification,
    kAXApplicationHiddenNotification, kAXApplicationShownNotification,
    kAXWindowCreatedNotification, kAXWindowMovedNotification, kAXWindowResizedNotification,
    kAXValueChangedNotification, kAXTitleChangedNotification,
    kAXSelectedChildrenChangedNotification, kAXLayoutChangedNotification,
].map { $0 as String }

struct TreeStats: Codable {
    var nodes = 0
    var maxDepth = 0
    var roles: [String: Int] = [:]
    var webAreas = 0
    var texts: [String] = []
    var truncated = false
}

/// AXUIElement 按 CFEqual/CFHash 去重，防止自引用导致无限下降
struct AXBox: Hashable {
    let el: AXUIElement
    static func == (a: AXBox, b: AXBox) -> Bool { CFEqual(a.el, b.el) }
    func hash(into h: inout Hasher) { h.combine(CFHash(el)) }
}
var visited = Set<AXBox>()
let maxWalkDepth = 80

func walk(_ element: AXUIElement, depth: Int, cap: Int, stats: inout TreeStats) {
    if stats.nodes >= cap { stats.truncated = true; return }
    if depth > maxWalkDepth { stats.truncated = true; return }
    guard visited.insert(AXBox(el: element)).inserted else { return }
    stats.nodes += 1
    stats.maxDepth = max(stats.maxDepth, depth)
    let role = WindowResolver.stringAttr(element, kAXRoleAttribute as String)
    if !role.isEmpty { stats.roles[role, default: 0] += 1 }
    if role == "AXWebArea" { stats.webAreas += 1 }
    if role == "AXTextField" || role == "AXTextArea" || role == "AXStaticText" {
        let v = WindowResolver.stringAttr(element, kAXValueAttribute as String)
        if !v.isEmpty && stats.texts.count < 60 { stats.texts.append("\(role):\(v.prefix(120))") }
    }
    var ref: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &ref) == .success,
       let kids = ref as? [AXUIElement] {
        for k in kids { walk(k, depth: depth + 1, cap: cap, stats: &stats) }
    }
}

func statsDict(_ s: TreeStats) -> [String: Any] {
    ["nodes": s.nodes, "maxDepth": s.maxDepth, "roles": s.roles,
     "webAreas": s.webAreas, "texts": s.texts, "truncated": s.truncated]
}

// MARK: - 命令

switch command {

case "env":
    settleWorkspace()
    var out = frontmostSnapshot()
    out["axTrusted"] = AXIsProcessTrusted()
    out["spi"] = spiReport
    out["pid"] = Int(ProcessInfo.processInfo.processIdentifier)
    emit(out)

case "launch":
    // configuration.activates = false —— 启动 app 但不抢前台
    guard let path = opt("path") else { emit(["error": "need --path"]); exit(2) }
    settleWorkspace()
    let before = frontmostSnapshot()
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.activates = false
    cfg.addsToRecentItems = false
    cfg.createsNewApplicationInstance = flag("new-instance")
    let extra = optAll("arg")
    if !extra.isEmpty { cfg.arguments = extra }
    var env = ProcessInfo.processInfo.environment
    if let logDir = opt("log-dir") { env["BGGATE_LOG_DIR"] = logDir }
    cfg.environment = env

    let sem = DispatchSemaphore(value: 0)
    var launchedPID: Int32 = -1
    var errText = ""
    NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: cfg) { app, err in
        launchedPID = app?.processIdentifier ?? -1
        if let err { errText = "\(err)" }
        sem.signal()
    }
    let deadline = Date().addingTimeInterval(20)
    while sem.wait(timeout: .now() + 0.02) == .timedOut, Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
    }
    settleWorkspace(0.6)
    emit(["launchedPID": Int(launchedPID), "error": errText,
          "before": before, "after": frontmostSnapshot()])

case "windows":
    settleWorkspace()
    let pid = pid_t(intOpt("pid", 0))
    let wins = WindowResolver.windows(pid: pid)
    let cg = WindowResolver.cgWindows(pid: pid).map {
        ["number": $0.number, "name": $0.name, "layer": $0.layer, "alpha": $0.alpha,
         "bounds": [$0.bounds.minX, $0.bounds.minY, $0.bounds.width, $0.bounds.height]] as [String: Any]
    }
    let axWins: [[String: Any]] = wins.map {
        ["index": $0.index, "title": $0.title, "frame": $0.frame, "windowNumber": $0.windowNumber,
         "resolvedBy": $0.resolvedBy, "isMain": $0.isMain, "isFocused": $0.isFocused,
         "layer": $0.layer, "cgTitle": $0.cgTitle]
    }
    emit(["pid": Int(pid), "spi": spiReport, "axWindows": axWins, "cgWindows": cg])

case "axread":
    settleWorkspace()
    let pid = pid_t(intOpt("pid", 0))
    let cap = intOpt("max-nodes", 40000)
    let app = AXUIElementCreateApplication(pid)
    var out: [String: Any] = ["pid": Int(pid)]

    func scan() -> [String: Any] {
        var result: [String: Any] = [:]
        visited.removeAll()
        if let idxStr = opt("window-index"), let idx = Int(idxStr),
           let w = WindowResolver.axWindow(pid: pid, index: idx) {
            var s = TreeStats(); walk(w, depth: 0, cap: cap, stats: &s)
            result["window"] = statsDict(s)
        }
        visited.removeAll()
        var s = TreeStats(); walk(app, depth: 0, cap: cap, stats: &s)
        result["app"] = statsDict(s)
        return result
    }

    out["pass1"] = scan()

    if flag("enable-ax") {
        var accepted: [String: Bool] = [:]
        for attr in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
            accepted[attr] = AXUIElementSetAttributeValue(app, attr as CFString, kCFBooleanTrue) == .success
        }
        out["enableAX"] = accepted
    }
    if flag("observer") {
        var observer: AXObserver?
        let cb: AXObserverCallback = { _, _, _, _ in }
        let err = AXObserverCreate(pid, cb, &observer)
        var registered = 0
        if err == .success, let obs = observer {
            for n in axNotifications where SPI.addNotification(obs, app, n, nil) == .success { registered += 1 }
            CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(obs), .commonModes)
        }
        out["observer"] = ["created": err == .success, "registered": registered,
                           "usedRemoteSPI": SPI.axObserverRemoteAvailable]
    }
    let waitMs = intOpt("wait-ms", 0)
    if waitMs > 0 { settleWorkspace(Double(waitMs) / 1000.0) }
    if flag("rescan") { out["pass2"] = scan() }
    emit(out)

case "act":
    settleWorkspace()
    let pid = pid_t(intOpt("pid", 0))
    var report: [String: Any] = ["spi": spiReport, "label": opt("label") ?? ""]
    let baseline = frontmostSnapshot()
    let baseCursor = cursorPoint()
    report["baseline"] = baseline

    // --- 解析目标窗口 ---
    let wins = WindowResolver.windows(pid: pid)
    var chosen: WindowInfo?
    // 显式覆盖：AX 解析不可用时（如锁屏），用带外拿到的 windowNumber + frame 直接寻址
    if let forced = opt("force-window-number").flatMap({ Int($0) }) {
        let fr = (opt("force-frame") ?? "").split(separator: ",").compactMap { Double($0) }
        chosen = WindowInfo(index: -1, title: "(forced)", frame: fr.count == 4 ? fr : [0, 0, 0, 0],
                            windowNumber: forced, resolvedBy: "forced", isMain: false,
                            isFocused: false, layer: 0, cgTitle: "")
    }
    else if let wn = opt("window-number"), let n = Int(wn) { chosen = wins.first { $0.windowNumber == n } }
    else if let t = opt("window-title") { chosen = wins.first { $0.title.contains(t) } }
    else { chosen = wins.first { $0.index == intOpt("window-index", 0) } }
    guard let win = chosen, win.frame.count == 4 else {
        report["error"] = "NO_WINDOW"; report["windows"] = wins.map { ["index": $0.index, "title": $0.title] }
        emit(report); exit(3)
    }
    let frame = CGRect(x: win.frame[0], y: win.frame[1], width: win.frame[2], height: win.frame[3])
    let windowNumber = win.windowNumber
    report["target"] = ["pid": Int(pid), "index": win.index, "title": win.title,
                        "windowNumber": windowNumber, "resolvedBy": win.resolvedBy,
                        "frame": win.frame, "isMain": win.isMain, "isFocused": win.isFocused]
    if windowNumber == 0 { report["warn"] = "NO_WINDOW_ID" }

    var options = DispatchOptions()
    options.useWindowFields = !flag("no-window-fields")
    options.useMouseWindowFields = !flag("no-mouse-window-fields")
    options.useWindowLocation = !flag("no-window-location")
    options.useTargetPID = !flag("no-target-pid")
    report["options"] = ["f51_58": options.useWindowFields, "f91_92": options.useMouseWindowFields,
                         "windowLocation": options.useWindowLocation, "f40": options.useTargetPID]

    // --- 会话 ---
    var session: BackgroundActivationSession?
    if flag("session") {
        let dropTypes = Set((opt("drop-types") ?? "13").split(separator: ",").compactMap { UInt32($0) })
        let maskSpec = opt("mask") ?? "13,19,20"
        let mask: CGEventMask
        if maskSpec == "max" { mask = CGEventMask.max }
        else {
            var m: CGEventMask = 0
            for b in maskSpec.split(separator: ",").compactMap({ UInt64($0) }) { m |= (1 << b) }
            mask = m
        }
        let prev: pid_t? = opt("suppress-pid").flatMap { pid_t($0) }
            ?? NSWorkspace.shared.frontmostApplication?.processIdentifier
        let s = BackgroundActivationSession(targetPID: pid, previousPID: prev,
                                            dropTypes: dropTypes, eventMask: mask)
        do {
            try s.installTaps()
            session = s
            report["session"] = ["installed": s.installedKinds, "dropTypes": Array(dropTypes).sorted(),
                                 "mask": maskSpec, "previousPID": Int(prev ?? -1)]
        } catch {
            report["session"] = ["error": "\(error)"]
        }
    }

    // --- 激活 ---
    var activation: [String: Any] = [:]
    if flag("activate") {
        if !flag("no-appkit-primer") {
            activation["appKitPrimer"] = BackgroundActivationSession.postAppKitPrimer(
                targetPID: pid, windowNumber: windowNumber, subtype: 1)
        }
        if !flag("no-center-primer") {
            let p = pointOpt("primer-point").map { CGPoint(x: frame.minX + $0.x, y: frame.minY + $0.y) }
            let r = BackgroundActivationSession.postCenterPrimer(
                targetPID: pid, windowNumber: windowNumber, windowFrame: frame, point: p, options: options)
            activation["centerPrimer"] = ["field40": r.field40, "field51": r.field51, "field58": r.field58,
                                          "field91": r.field91, "field92": r.field92,
                                          "windowLocationApplied": r.windowLocationApplied,
                                          "quartz": r.quartzWindowPoint,
                                          "point": p.map { [$0.x, $0.y] } ?? [frame.midX, frame.midY]]
        }
        settleWorkspace(Double(intOpt("post-activate-ms", 250)) / 1000.0)
        activation["frontmostAfterActivate"] = frontmostSnapshot()
    }
    report["activation"] = activation

    // --- 动作 ---
    var actions: [[String: Any]] = []
    if let c = pointOpt("click") {                   // 窗口内 Quartz 坐标（左上原点）
        let screen = CGPoint(x: frame.minX + c.x, y: frame.minY + c.y)
        let r = BackgroundDispatcher.leftClick(pid: pid, windowNumber: windowNumber,
                                               windowFrame: frame, screenPoint: screen, options: options)
        actions.append(["kind": "click", "windowPoint": [c.x, c.y], "screenPoint": [screen.x, screen.y],
                        "fields": ["40": r.field40, "51": r.field51, "58": r.field58,
                                   "91": r.field91, "92": r.field92],
                        "windowLocationApplied": r.windowLocationApplied, "quartz": r.quartzWindowPoint])
    }
    if let text = opt("type") {
        let r = BackgroundDispatcher.typeUnicode(text, pid: pid, windowNumber: windowNumber, options: options)
        actions.append(["kind": "type", "text": text,
                        "fields": ["40": r.field40, "51": r.field51, "58": r.field58]])
    }
    if let combo = opt("press") {                     // 形如 "cmd+1" / "s:cmd"
        let parts = combo.split(separator: ":")
        let code = CGKeyCode(UInt16(parts[0]) ?? 0)
        var f = CGEventFlags()
        if parts.count > 1 {
            for m in parts[1].split(separator: "+") {
                switch m { case "cmd": f.insert(.maskCommand); case "shift": f.insert(.maskShift)
                case "opt": f.insert(.maskAlternate); case "ctrl": f.insert(.maskControl); default: break }
            }
        }
        BackgroundDispatcher.pressCombo(keyCode: code, flags: f, pid: pid, windowNumber: windowNumber, options: options)
        actions.append(["kind": "press", "combo": combo])
    }
    // 抑制期内向"用户 app"投递输入，验证抑制没有误伤
    if let otherPid = opt("also-pid").flatMap({ pid_t($0) }) {
        var otherWins = WindowResolver.windows(pid: otherPid)
        if let forced = opt("also-window-number").flatMap({ Int($0) }) {
            let fr = (opt("also-frame") ?? "0,0,0,0").split(separator: ",").compactMap { Double($0) }
            otherWins = [WindowInfo(index: -1, title: "(forced)", frame: fr.count == 4 ? fr : [0, 0, 0, 0],
                                    windowNumber: forced, resolvedBy: "forced", isMain: false,
                                    isFocused: false, layer: 0, cgTitle: "")]
        }
        if let ow = otherWins.first, ow.frame.count == 4 {
            let of = CGRect(x: ow.frame[0], y: ow.frame[1], width: ow.frame[2], height: ow.frame[3])
            if let t = opt("also-type") {
                _ = BackgroundDispatcher.typeUnicode(t, pid: otherPid, windowNumber: ow.windowNumber, options: options)
            }
            if let c = pointOpt("also-click") {
                _ = BackgroundDispatcher.leftClick(pid: otherPid, windowNumber: ow.windowNumber,
                                                   windowFrame: of, screenPoint: CGPoint(x: of.minX + c.x, y: of.minY + c.y),
                                                   options: options)
            }
            actions.append(["kind": "alsoPid", "pid": Int(otherPid), "windowNumber": ow.windowNumber])
        } else {
            actions.append(["kind": "alsoPid", "pid": Int(otherPid), "error": "NO_WINDOW"])
        }
    }
    report["actions"] = actions

    settleWorkspace(Double(intOpt("hold-ms", 400)) / 1000.0)

    // --- 收尾 ---
    if let s = session {
        if flag("restore") { report["restored"] = s.restoreIfNeeded(windowNumber: windowNumber) }
        settleWorkspace(0.15)
        report["tapStats"] = s.stats.snapshot()
        s.finish()
    }
    settleWorkspace(0.2)
    var after = frontmostSnapshot()
    after["cursorDelta"] = dist(baseCursor, cursorPoint())
    report["after"] = after
    let afterWins = WindowResolver.windows(pid: pid)
    if let w = afterWins.first(where: { $0.windowNumber == windowNumber }) {
        report["targetAfter"] = ["isMain": w.isMain, "isFocused": w.isFocused, "frame": w.frame]
    }
    report["frontmostUnchanged"] = (baseline["frontmostPID"] as? Int) == (after["frontmostPID"] as? Int)
    emit(report)

default:
    emit(["error": "unknown command \(command)",
          "commands": ["env", "launch", "windows", "axread", "act"]])
    exit(2)
}
