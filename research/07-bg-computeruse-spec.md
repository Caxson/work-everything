# 后台驱动改造规格 — 精读 EYHN/kwwk-computer-use-core

> 目标：把 `native/ax-bridge`（`we-ax`）从「抢前台 + 全局 HID tap」改造成「后台驱动」——agent 操作目标 app 时，用户的前台 app 不变、真实光标不动。
>
> 源码副本：`/Users/caosen/.claude/jobs/ae02c800/tmp/kwwk-core`（`git clone --depth 1`，HEAD = `5201e30`，2026-08-30 05:56 UTC 最后更新，59 star）。
> 下文所有行号均指该副本；凡与参考文章冲突处，**以源码为准**并单列在 §3。

---

## 0. 结论摘要

后台驱动不是一个 API，是**三层机制叠加**，缺一层就退化成「打不中」或「抢前台」：

| 层 | 作用 | 关键实现 |
|---|---|---|
| L1 事件寻址 | 让 `postToPid` 的鼠标事件真正落到某个窗口的某个点 | 公有字段 `40/91/92` + **私有字段 51/58** + SkyLight 私有函数 `CGEventSetWindowLocation` |
| L2 后台激活 | 让目标 app 自己认为「我是 active/key/main」，从而正常响应点击、吐完整 AX 树 | appKitDefined(subtype=1) primer + **窗口正中心**假点击 |
| L3 焦点抑制 | 阻止 L2 的副作用把真实前台切走 | 对「原前台 app」装 per-process event tap，丢弃焦点消息 |

三层都是 MIT 可直接借用的代码，**但不建议整包依赖**（见 §1）。

---

## 1. 仓库结构与 LICENSE

**LICENSE：MIT © 2026 EYHN**（`LICENSE:1-21`）。`gh repo view` 报 `licenseInfo.key = "other"` 只是因为文件尾部追加了第三方声明段，**不影响 MIT 授权**。

第三方继承：`LICENSE:23-30` + `LICENSES/cua-driver-MIT.txt` 声明部分代码衍生自 **trycua/cua (cua-driver)，MIT © Cua AI, Inc.**。具体到文件头注释：

- `BackgroundInputDispatcher.swift:1-6` —— 鼠标事件的 window-addressing 字段来自 cua-driver `MouseInput.swift` (v0.1)
- `BackgroundWindowLocalEvent.swift:1-5` —— `CGEventSetWindowLocation` 的私有 SPI 解析来自 cua-driver `SkyLightEventPost.swift` (v0.1)
- `ChromiumAccessibilityActivation.swift:1-7` —— AX 通知集合/顺序、`AXObserverAddNotificationAndCheckRemote` fallback、`AXManualAccessibility`+`AXEnhancedUserInterface` 双断言来自 cua-driver `AppState.swift` / `AXEnablementAssertion.swift`

> **合规动作**：我们只要抄了这三块的实质逻辑，就必须在对应 Swift 文件头保留「Portions derived from trycua/cua (cua-driver), MIT © Cua AI, Inc.」并在仓库里放一份 cua-driver 的 MIT 全文。这是 MIT 的 attribution 义务，不是可选项。

**包形态**：`Package.swift` — swift-tools 6.1，`platforms: [.macOS(.v14)]`，`swiftLanguageModes: [.v6]`，产物是 **library** `KWWKComputerUseCore`，链接 AppKit / ApplicationServices / Metal / QuartzCore。CI 跑在 `macos-15`（`.github/workflows/ci.yml`）。

**规模**：Sources 约 8.4k 行 Swift（37 文件），Tests 约 2.2k 行。

**能否直接借用？建议「移植而非依赖」**，理由：

1. 它是 library 不是可执行体，我们的 `we-ax` 是 stdio NDJSON 可执行包，语义模型完全不同（它是 snapshot/elementIndex 模型，我们是 nodeId handle 模型）。
2. 它有 ~1.8k 行是我们完全不需要的 UI 装饰（`CueboardColorfulBorder/*` 彩色边框 overlay + `CueboardCursor/*` 假光标动画 + `Resources/OverlayCursor.png`），还有 snapshot 持久化、agent 文本格式化（`StateFormatter.swift`、`ComputerUseSession.swift` 里的 `harnessAnnotation`）——这些和我们的协议冲突。
3. 真正要抄的是 **4 个文件 ≈ 900 行**：`BackgroundWindowLocalEvent.swift`(28) + `BackgroundInputDispatcher.swift`(483) + `BackgroundActivationSession.swift`(291) + `AXWindowIDResolver.swift`(31)，外加 `CoordinateSpaces.swift`(169) 和 `ChromiumAccessibilityActivation.swift`(133) 的核心部分。

---

## 2. 逐文件要点

### 2.1 `BackgroundWindowLocalEvent.swift`（28 行）— 私有 SPI 解析

职责：拿到 `CGEventSetWindowLocation`，给 CGEvent 打上「窗口内坐标」。

```swift
enum BackgroundWindowLocalEvent {
    private typealias SetWindowLocationFn = @convention(c) (CGEvent, CGPoint) -> Void

    private static let setWindowLocation: SetWindowLocationFn? = {
        _ = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
        // -2 == RTLD_DEFAULT：在全进程符号表里找，不绑定到具体 handle
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventSetWindowLocation") else {
            return nil
        }
        return unsafeBitCast(symbol, to: SetWindowLocationFn.self)
    }()

    @discardableResult
    static func setPoint(_ point: CGPoint, on event: CGEvent) -> Bool {
        guard let setWindowLocation else { return false }
        setWindowLocation(event, point)
        return true
    }
}
```

坑：
- **`dlsym` 用 `RTLD_DEFAULT`（`bitPattern: -2`）而不是 dlopen 返回的 handle**（`:16`）。符号实际由 SkyLight 导出，但先 `dlopen` 只是保证它被加载进来。
- 整个链路对失败**静默降级**（返回 `false`，`:24`）——调用方 `_ = BackgroundWindowLocalEvent.setPoint(...)` 全部忽略返回值（`BackgroundInputDispatcher.swift:130,165`；`BackgroundActivationSession.swift:170`）。**我们必须把这个 bool 冒泡上去**，否则新系统上符号消失会表现为「点击静默无效」，而不是可诊断的错误。
- 传入的是 **窗口内 top-left 原点、y 向下** 的点（见 §4.2）。

### 2.2 `BackgroundInputDispatcher.swift`（483 行）— 鼠标/键盘/滚轮

#### 私有字段的确切写法（`:277-291`，定义在 BackgroundActivationSession.swift 尾部的 CGEvent extension）

```swift
extension CGEvent {
    // 51 = 目标 windowNumber；58 = 「按窗口路由」开关
    private static let targetWindowNumberField   = CGEventField(rawValue: 51)
    private static let privateWindowRoutingField = CGEventField(rawValue: 58)

    func setWindowAddressingFields(windowNumber: Int) {
        if let f = Self.targetWindowNumberField   { setIntegerValueField(f, value: Int64(windowNumber)) }
        if let f = Self.privateWindowRoutingField { setIntegerValueField(f, value: 1) }
    }
}
```

`CGEventField(rawValue:)` 是可失败构造器，所以是 `if let`。**51 / 58 确认为私有**：我已对本机 SDK 头 `MacOSX.sdk/.../CGEventTypes.h` 的 `CGEventField` 枚举做过全量提取，51 与 58 都不在公有枚举里；而 `40 = kCGEventTargetUnixProcessID`、`91 = kCGMouseEventWindowUnderMousePointer`、`92 = kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent` **都是公有常量**，Swift 里直接用 `.eventTargetUnixProcessID` / `.mouseEventWindowUnderMousePointer` / `.mouseEventWindowUnderMousePointerThatCanHandleThisEvent`，不需要 rawValue。

#### 鼠标事件完整构造（`postMouse`，`:137-167`）

```swift
private func postMouse(_ type: CGEventType, at screenPoint: CGPoint,
                       button: MouseButton, clickState: Int64, pressure: Double) {
    guard let event = CGEvent(mouseEventSource: nil,          // ← source 为 nil
                              mouseType: type,
                              mouseCursorPosition: screenPoint, // ← AX 全局屏幕坐标
                              mouseButton: button.cgMouseButton) else { return }
    event.flags = modifierFlags
    event.setIntegerValueField(.mouseEventClickState, value: clickState)
    event.setDoubleValueField(.mouseEventPressure,   value: pressure)
    event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(targetPID))          // 40
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowNumber))                       // 91
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowNumber)) // 92
    event.setWindowAddressingFields(windowNumber: windowNumber)                              // 51 + 58
    let quartzPoint = quartzWindowPoint(
        fromWindowLocal: Point<WindowLocalSpace>(windowLocalPoint(from: screenPoint)),
        windowHeight: windowFrame.height)
    _ = BackgroundWindowLocalEvent.setPoint(quartzPoint.cgPoint, on: event)                  // 窗口内坐标
    event.postToPid(targetPID)
}
```

要点：
- **`mouseEventSource: nil`**（`:145`）。注意与键盘不同——键盘用 `CGEventSource(stateID: .hidSystemState)`（`:277`）。我们现在两边都用 `.privateState`，需要重新评估（见 §9 风险项）。
- 屏幕坐标**照样要填**（`mouseCursorPosition`），窗口内坐标是**额外**打上去的，不是替代。两者必须自洽。
- 左键点击 = down(clickState=1, pressure=1) → `usleep(30_000)` → up(clickState=1, pressure=0)（`:60-67`）。**pressure 一定要 1 → 0**，不是恒 0。

#### 拖拽（`:69-93`）

`mouseMoved`（clickState=0, pressure=0）→ `usleep(15_000)` → down → N 次 `dragged`（clickState=1, pressure=1）→ up(pressure=0)。调用方 `ComputerUseActions.swift` 的 `drag` 用 16 步插值、每步 `usleep(12_000)`。

#### 滚轮（`:95-135`）

```swift
let ticks = max(1, Int((max(0.05, pages) * 8).rounded(.up)))
let lineDelta: Int32 = 12
// up:(0,+12) down:(0,-12) left:(+12,0) right:(-12,0)
for _ in 0..<ticks {
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .line,
                              wheelCount: 2, wheel1: delta.y, wheel2: delta.x, wheel3: 0) else { throw ... }
    event.location = screenPoint                                     // ← 用 .location 赋值，不是构造参数
    event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(targetPID))
    event.setWindowAddressingFields(windowNumber: windowNumber)      // 51 + 58
    _ = BackgroundWindowLocalEvent.setPoint(quartzPoint.cgPoint, on: event)
    event.postToPid(targetPID)
    usleep(8_000)
}
```

**滚轮不设 91/92**（只有 40 + 51/58 + windowLocation）——`:124-130` vs 鼠标的 `:155-160`。这是源码事实，不是遗漏还是有意我无法从代码判断，但照抄即可。

#### 键盘（`BackgroundKeyboardDispatcher`，`:273-360`）

```swift
private let source = CGEventSource(stateID: .hidSystemState)   // ← hidSystemState，不是 privateState

private func postKeyEvent(_ event: CGEvent) {
    event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(targetPID))  // 40
    event.setWindowAddressingFields(windowNumber: windowNumber)                     // 51 + 58 ← 我们缺的就是这行
    event.postToPid(targetPID)
}
```

**这就是我们 bug 的正解**：`native/ax-bridge/Sources/weax/Actions.swift:80-93` 的 `post()` 只做了 `event.flags = spec.flags` + `event.postToPid(pid)`，**既没填 40 也没填 51/58**，所以只能打前台窗口。

### 2.3 `BackgroundActivationSession.swift`（291 行）— 激活 + 焦点抑制

#### 生命周期（`:43-54`）

```swift
static func start(targetPID: pid_t) throws -> BackgroundActivationSession {
    let previousApp = NSWorkspace.shared.frontmostApplication   // ① 先记下"当前前台"
    let session = BackgroundActivationSession(targetPID: targetPID)
    do { try session.installTapsIfNeeded(previousApp: previousApp); return session }   // ② 装 tap
    catch { session.finish(); throw error }
}
```

调用方 `ComputerUseSession.swift:316-321` 先 `start()`（装 tap），**之后**才 `activation.activateWindow(...)`（`:299-302`）。**「先装 tap 再发激活点击」的顺序确认无误。**

#### tap 安装（`:198-229`）

```swift
private static let focusSuppressionEventMask = CGEventMask.max   // 注册"所有事件"，再在回调里窄过滤

private func installTapsIfNeeded(previousApp: NSRunningApplication?) throws {
    guard let previousApp, previousApp.processIdentifier != targetPID else { return }  // 目标已是前台 → 一个 tap 都不装
    try installTap(kind: .previous, pid: previousApp.processIdentifier)
    try installTap(kind: .target,   pid: targetPID)
}

private func installTap(kind: TapKind, pid: pid_t) throws {
    let context = TapContext(session: self, kind: kind)
    let pointer = Unmanaged.passUnretained(context).toOpaque()
    guard let tap = CGEvent.tapCreateForPid(
        pid: pid, place: .headInsertEventTap, options: .defaultTap,
        eventsOfInterest: Self.focusSuppressionEventMask,
        callback: backgroundActivationEventTapCallback, userInfo: pointer) else { throw ... }
    guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else { CFMachPortInvalidate(tap); throw ... }
    CoreRunLoopThread.shared.addSource(source, mode: .commonModes)   // ← 专用后台 runloop 线程
    CGEvent.tapEnable(tap: tap, enable: true)
    contexts.append(context); taps.append(tap)     // context 必须强持有，否则 Unmanaged 悬垂
}
```

#### 丢弃判据（`:231-253`）

```swift
func shouldDrop(kind: TapKind, type: CGEventType, event: CGEvent) -> Bool {
    guard isFocusMessage(type: type, event: event) else { return false }
    switch stateLock.withLock({ phase }) {
    case .deliveringToTarget: return kind == .previous
    case .holding:            return kind == .previous
    case .finished:           return false
    }
}
private func isFocusMessage(type: CGEventType, event _: CGEvent) -> Bool {
    type.rawValue == 13 || type.rawValue == 19 || type.rawValue == 20
}
```

**两个必须点名的事实**（见 §3）：
1. `kind == .target` 在任何 phase 都 **返回 false**——目标 app 的 tap 从头到尾**一个事件都不丢**，纯 pass-through。
2. `.deliveringToTarget` 与 `.holding` 两个 phase 的行为**完全相同**，相位机现在是空转的。

#### 两步激活（`:74-137`）

```swift
static func activateWindow(targetPID: pid_t, windowNumber: Int, windowFrame: CGRect) {
    postWindowActivationEvent(targetPID: targetPID, windowNumber: windowNumber)   // 步骤①
    postWindowCenterPrimer(targetPID: targetPID, windowNumber: windowNumber, windowFrame: windowFrame)  // 步骤②
}

// ① appKitDefined primer：subtype = 1 (applicationActivated)
private static func postWindowActivationEvent(targetPID: pid_t, windowNumber: Int) {
    guard windowNumber != 0 else { return }
    let event = NSEvent.otherEvent(
        with: .appKitDefined, location: .zero, modifierFlags: [], timestamp: 0,
        windowNumber: windowNumber, context: nil,
        subtype: Int16(1),        // NSEventSubtypeApplicationActivated == 1
        data1: 0, data2: 0)?.cgEvent
    guard let event else { return }
    event.setWindowAddressingFields(windowNumber: windowNumber)   // 只有 51/58，没有 40
    event.postToPid(targetPID)
    usleep(20_000)
}

// ② center primer：窗口正中心一次真点击
private static func postWindowCenterPrimer(targetPID: pid_t, windowNumber: Int, windowFrame: CGRect) {
    guard windowNumber != 0, windowFrame.width > 0, windowFrame.height > 0 else { return }
    let point = CGPoint(x: windowFrame.midX, y: windowFrame.midY)   // ← 绝不用左上角
    postMouse(.leftMouseDown, ..., point: point, clickState: 1, pressure: 1)
    usleep(30_000)
    postMouse(.leftMouseUp,   ..., point: point, clickState: 1, pressure: 0)
    usleep(20_000)
}
```

`postMouse`（`:139-172`，static 版）字段与 `BackgroundInputDispatcher.postMouse` 一致：40 + 91 + 92 + 51/58 + windowLocation，但**不设 `event.flags`**。

#### 收尾复位（`:98-127`）

subtype=2 **不是激活的一部分**，而是**归还焦点**用的（文章此处描述有误，见 §3）：

```swift
func restoreBackgroundActivationIfNeeded(windowNumber: Int) {
    guard windowNumber != 0 else { return }
    // 若目标真的成了前台（用户自己点过去了），什么都不做
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier != targetPID else { return }
    beginTargetDelivery()
    postApplicationFocusEvent(subtype: .applicationDeactivated, windowNumber: windowNumber)  // subtype = 2
    usleep(20_000)
}
```

即：会话结束时告诉目标 app「你失去焦点了」，把它从「我以为我是 active」的假状态里拉回来。调用点在 `ComputerUseSession.swift:353-360` 的 `restoreAndFinish`，随后立刻 `activation.finish()` 拆 tap。

**中心点击的重要副作用**：center primer 是一次**真的左键点击**，会落在窗口正中心的控件上。kwwk 的 probe 测试专门用 `clicks() == expectedClicks` 断言点击数不多不少（`Tests/.../InProcessComputerUseBehaviorTests.swift:968`），说明 primer 落点在 probe 里是空白区。**真实 app（比如飞书会话列表正中）中心可能是一个可点条目——这是必须在我们侧解决的问题**，见 §9.5。

### 2.4 `ComputerUseSession.swift`（554 行）— 编排

关键：**什么时候需要激活**（`prepareActivationIfNeeded`，`:267-306`）

```swift
guard snapshot.windowID > 0 else { return false }
let windowIsMain = isTargetWindowMain(snapshot)     // AXMain 或 app.AXMainWindow == 本窗口

if appIsFrontmost { releaseBackgroundActivation(&target); target.backgroundActivated = false }

let needsActivation = if appIsFrontmost { !windowIsMain }
                      else              { !target.backgroundActivated || !windowIsMain }
guard needsActivation else { return false }

if appIsFrontmost {
    BackgroundActivationSession.activateWindow(...)      // 不装 tap，直接激活（同 app 内换窗口）
} else {
    let activation = try ensureBackgroundActivation(...) // 装 tap
    activation.activateWindow(...)
    target.backgroundActivated = true
}
```

三条设计约束值得照抄：
1. **激活是幂等且带缓存的**：同一个 (pid, windowID) 只在第一次或窗口不再是 main 时重激活。
2. **目标本来就是前台时不装 tap**——省掉全部抑制开销和风险。
3. **用户抢回焦点会自动放弃 lease**：`FrontmostApplicationMonitor` 监听 `NSWorkspace.didActivateApplicationNotification`，一旦目标 pid 成为前台就 `restoreAndFinish` 并清空 activation（`:247-265`）。

`performWithBackgroundActivation`（`:97-120`）是所有动作的统一包壳：`prepare → beginTargetDelivery() → body() → defer holdFocusSuppressionUntilFinish()`。

### 2.5 `FrontmostApplicationMonitor.swift`（98 行）

`NSWorkspace.shared.notificationCenter.addObserver(forName: .didActivateApplicationNotification)`（`:39-53`）。坑：**注册/注销必须在主线程**——`runWorkspaceNotificationCenterOperation`（`:91-97`）用 `Thread.isMainThread ? 直接执行 : DispatchQueue.main.sync`。我们的 `we-ax` 所有 op 都在主线程跑（`Dispatcher.swift:6-7` 注释），天然满足。

### 2.6 `CoreRunLoopThread.swift`（32 行）

单例后台线程，跑一个永不退出的 runloop（靠一个 3600s repeat timer 保活，`:16-17`），给 event tap 和 AXObserver 挂 source。

```swift
let thread = Thread {
    let timer = Timer(timeInterval: 3600, repeats: true) { _ in }
    RunLoop.current.add(timer, forMode: .common)
    box.runLoop = CFRunLoopGetCurrent()
    ready.signal()
    RunLoop.current.run()
}
```

**这是必须品**：event tap 回调在挂 source 的那个 runloop 上执行。如果挂在主 runloop 而主线程正在同步做 AX 遍历（我们的 `we-ax` 恰恰如此），tap 回调就会饿死 → macOS 判定超时 → **整个 tap 被系统禁用** → 原前台 app 的输入抑制失效。必须用独立线程。

### 2.7 `AXWindowIDResolver.swift`（31 行）+ `WindowResolution.swift`（214 行）

见 §4.1。

### 2.8 `ChromiumAccessibilityActivation.swift`（133 行）

见 §6。

### 2.9 `AppDiscovery.swift` — 不抢前台地启动 app

```swift
private static func launchApplication(at url: URL) async throws -> NSRunningApplication? {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false          // ← :277，这一行就是我们 `open -a` 问题的正解
    return try await withCheckedThrowingContinuation { c in
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in ... }
    }
}
```

`openApp` 之后轮询 10s 等 `NSRunningApplication` 出现（`:45-59`）。

> 注：我们 `spikes/README.md:179` 记的「飞书关窗后 `AXWindows` 为空，只有 reopen Apple Event 能拉回窗口」在后台模式下**依然成立且更棘手**——`configuration.activates = false` 的 `openApplication` 走的也是 reopen 语义，能恢复窗口且不抢前台，正好替代 `open -a`。

### 2.10 `CoordinateSpaces.swift`（169 行）

见 §4.2。

---

## 3. 文章 vs 源码：逐条核实

| # | 文章说法 | 源码事实 | 判定 |
|---|---|---|---|
| 1 | 填 `eventTargetUnixProcessID`、`windowUnderMouse`、`windowThatCanHandle`、私有 51、私有 58=1，并 `CGEventSetWindowLocation` | 全部属实（`BackgroundInputDispatcher.swift:155-165`） | ✅ |
| 1b | ——（文章未说） | **91/92 是公有常量，不需要 rawValue**；只有 51/58 是私有。混为一谈会让人以为四个都得 hack | ⚠️ 省略 |
| 1c | ——（文章未说） | **滚轮事件不设 91/92**（`:124-130`），只设 40+51/58+windowLocation | ⚠️ 省略 |
| 1d | ——（文章未说） | 鼠标事件 `mouseEventSource: nil`，键盘事件 `CGEventSource(stateID: .hidSystemState)`。两者 source 不同 | ⚠️ 省略 |
| 1e | 左键 = down(clickState=1,pressure=1) + 30ms + up(pressure=0) | 属实（`:60-67`），且 up 的 clickState 仍是 1 | ✅ |
| 2 | 给「当前前台 app」和「目标 app」各装 per-process tap；**发往前台的 deactivation `return nil`**；**放行目标 app 的 activation** | 前半属实。但「放行目标 activation」在代码里是**目标 tap 从不丢弃任何事件**（`shouldDrop` 里 `.target` 永远 false，`:236-241`）——即目标那个 tap 是**纯 pass-through，逻辑上可删**。文章把它描述成有主动放行逻辑，是过度解读 | ⚠️ 描述失准 |
| 2b | focus 消息按 raw value 13/19/20 识别 | 数值属实（`:252`）。但要说清：**13 = `NSEventTypeAppKitDefined`**（激活/去激活的载体，头文件 `NSEvent.h` 已核对）；**19/20 在 NSEvent 编号里是 `NSEventTypeBeginGesture`/`NSEventTypeEndGesture`**，并非公认的 focus 消息。源码注释自称「focus messages 没有稳定公有类型，先宽注册再窄过滤」。**副作用：抑制期内原前台 app 的触控板手势事件会被一并丢掉** | ⚠️ 需实测 |
| 2c | 先装 tap 再发激活点击 | 属实（`ComputerUseSession.swift:316→321→299`） | ✅ |
| 2d | ——（文章未说） | tap 的 `eventsOfInterest = CGEventMask.max`（**注册全部事件**，`:30`），不是只注册几个类型。这意味着**原前台 app 的每一个输入事件都要过我们进程一趟** | ⚠️ 重大省略，见 §9.3 |
| 3① | appKitDefined primer：`NSEvent.otherEvent(type=appKitDefined, subtype=1)`，带 windowNumber，写 51/58，postToPid | 属实（`:79-96`）。补充：**只写 51/58，不写 40**；发完 `usleep(20_000)` | ✅ |
| 3① | 「**收尾发 subtype=2**」 | **失准**。subtype=2（`applicationDeactivated`）不是激活流程的收尾，而是**整个会话结束时的焦点归还**，走独立方法 `restoreBackgroundActivationIfNeeded`（`:98-107`），且**目标已是前台时会跳过**。把它当成激活序列的第二步发出去，会把刚激活的窗口立刻打回后台 | ❌ 说错 |
| 3② | center primer：窗口正中心 postToPid 点击，绝不点左上角；红绿灯在非激活态也响应 | 中心点击属实（`:132`用 `windowFrame.midX/midY`）。「红绿灯」的解释源码里没有依据（无注释），但「不点左上角」的行为是代码事实 | ✅ 行为属实 / 解释无源码支撑 |
| — | ——（文章未说） | **对 tap 被系统禁用（`kCGEventTapDisabledByTimeout`）没有任何处理**：全仓库 grep `tapDisabled` 零命中，`tapEnable` 只在安装时调用一次（`:225`）。这是 kwwk 的真实缺陷 | ❌ 缺失 |
| — | ——（文章未说） | `configuration.activates = false` 启动 app（`AppDiscovery.swift:277`）——文章完全没提，但这是「不抢前台」拼图的一块 | ⚠️ 省略 |

---

## 4. windowNumber 怎么拿 + 坐标怎么换算

### 4.1 从 `AXUIElement` 拿 `CGWindowID`

**主路径：私有 SPI `_AXUIElementGetWindow`**（`AXWindowIDResolver.swift`）

```swift
enum AXWindowIDResolver {
    private typealias AXUIElementGetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError

    private static let getWindowForAXElement: AXUIElementGetWindowFn? = {
        _ = dlopen("/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices", RTLD_LAZY)
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else { return nil }
        return unsafeBitCast(symbol, to: AXUIElementGetWindowFn.self)
    }()

    static func cgWindowID(forAXWindow element: AXUIElement) -> CGWindowID? {
        guard let getWindowForAXElement else { return nil }
        var windowID: CGWindowID = 0
        guard getWindowForAXElement(element, &windowID) == .success, windowID != 0 else { return nil }
        return windowID
    }
}
```

**降级链**（`WindowResolution.swift:177-213`，`matchCGWindow`），逐级 fallback：

1. `_AXUIElementGetWindow` 拿到 ID，且该 ID 在本 pid 的 CGWindowList 里 → 用它（`:184-188`）
2. 调用方给了 `preferredWindowID`，且其 bounds 与 AX frame 在 4pt 内相等 → 用它（`:190-194`）
3. AX title 非空：CGWindow 的 `kCGWindowName` 包含该 title 且 bounds 与 AX frame 近似相等 → 用它；否则同名的第一个（`:197-209`）
4. bounds 近似相等的第一个（默认容差 2pt，`nearlyEqualRects`）
5. 第一个 `layer == 0` 的窗口（`:211-212`）

CGWindowList 的读法：`CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID)`，按 `kCGWindowOwnerPID == pid` 过滤，取 `kCGWindowNumber` / `kCGWindowName` / `kCGWindowLayer` / `kCGWindowAlpha` / `kCGWindowBounds`（`AXHelpers.swift:329-360`）。注意用的是 **`.optionAll` 而不是 `.optionOnScreenOnly`**——离屏窗口也要能寻址。

> 我们侧的对应：`we-ax` 的 `windows` op 现在只返回 AX 节点 + `index`（`Dispatcher.swift:82-90`），**没有 windowNumber**。必须补。

### 4.2 坐标空间（`CoordinateSpaces.swift`）

四个空间，命名和方向必须钉死：

| 空间 | 原点 | y 方向 | 单位 | 来源 |
|---|---|---|---|---|
| `AXScreenSpace` | 主显示器**左上** | **向下** | pt | `AXPosition`/`AXSize`、`CGDisplayBounds`、`CGEvent.location` |
| `AppKitScreenSpace` | 主显示器**左下** | **向上** | pt | `NSScreen.frame`、`NSWindow` |
| `WindowLocalSpace` | 窗口**左下** | **向上** | pt | kwwk 内部通用表示 |
| `QuartzWindowSpace` | 窗口**左上** | **向下** | pt | **`CGEventSetWindowLocation` 的入参** |
| `ScreenshotPixelSpace` | 截图**左上** | 向下 | px | 截图坐标点击 |

换算公式（`:65-124`）：

```swift
// 窗口内(左下原点) → AX 屏幕(左上原点)
func axScreenPoint(fromWindowLocal p: Point<WindowLocalSpace>, windowFrame: CGRect) -> Point<AXScreenSpace> {
    Point(x: p.x + windowFrame.minX,
          y: windowFrame.minY + (windowFrame.height - p.y))
}
// 逆变换
func windowLocalPoint(fromAXScreen p: Point<AXScreenSpace>, windowFrame: CGRect) -> Point<WindowLocalSpace> {
    Point(x: p.x - windowFrame.minX,
          y: windowFrame.height - (p.y - windowFrame.minY))
}
// 窗口内(左下) → Quartz 窗口内(左上)  ← 这是喂给 CGEventSetWindowLocation 的
func quartzWindowPoint(fromWindowLocal p: Point<WindowLocalSpace>, windowHeight: CGFloat) -> Point<QuartzWindowSpace> {
    Point(x: p.x, y: windowHeight - p.y)
}
// 截图像素 → 窗口内(左下)：先归一化再乘窗口尺寸，天然分辨率无关
func windowLocalPoint(fromScreenshotPixel px: ..., screenshotSize: CGSize, windowFrame: CGRect) -> Point<WindowLocalSpace> {
    let nx = clamp(px.x, 0, w)/w, ny = clamp(px.y, 0, h)/h
    return Point(x: nx * windowFrame.width, y: windowFrame.height - (ny * windowFrame.height))
}
```

**多显示器**（`DisplayCoordinateSpaceRegistry`，`:126-148`）：对每块 `NSScreen` 记一对 `(appKitFrame = screen.frame, axFrame = CGDisplayBounds(displayID))`；转换时先找**包含该点**的显示器，找不到就找**欧氏距离最近**的（`:33-37`），再做局部平移 + y 翻转。

> **关键结论：`postToPid` 全链路根本不碰 AppKit 空间。** 从 AX frame → windowLocal → quartzWindow，全在 AX 空间内完成，`appKitScreenPoint` 只被视觉 overlay（`DispatchSupport.swift:49` `overlayScreenPointForLocalPoint`）用到。所以**我们的后台点击链路可以完全不处理多显示器**——AX 坐标本来就是全局统一的。

**缩放 / Retina**：全链路是 **pt 不是 px**，没有任何地方读 `backingScaleFactor`。唯一的 px 空间是截图，靠「归一化再乘窗口 pt 尺寸」消化（`:111-124`）。因此 HiDPI、混合 DPI 多屏都是天然正确的。

**坐标动作的防陈旧检查**（`ComputerUseCore.swift:364-378`）：坐标点击/拖拽前，必须重新抓 snapshot 并断言 `windowFrame` 与截图时的 frame 在 **8pt** 内相等，否则抛 `staleState`。窗口在两次调用之间被移动/缩放，坐标就作废了。

---

## 5. 后台键盘输入 与 滚动

### 5.1 键盘

**唯一的差别就是加两组字段**（`BackgroundInputDispatcher.swift:338-342`）：`.eventTargetUnixProcessID = pid` + `setWindowAddressingFields(windowNumber:)`，然后 `postToPid`。没有 windowLocation（键盘事件没有坐标）。

**Unicode 字符**（`typeText`，`:279-302`）：

```swift
for cluster in text {                         // 按 Character（grapheme cluster）逐个发
    let units: [UniChar] = Array(String(cluster).utf16)
    try units.withUnsafeBufferPointer { buffer in
        guard let base = buffer.baseAddress, buffer.count > 0 else { return }
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up   = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { throw ... }
        down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
        postKeyEvent(down)
        up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
        postKeyEvent(up)
    }
    usleep(1_000)     // 每字符 1ms
}
```

要点：
- `virtualKey: 0` + `keyboardSetUnicodeString`，**down 和 up 都要 set**（`:293,296`）——只设 down 有些 app 会漏字。
- **按 `Character` 而不是 UTF-16 code unit 迭代**，所以 emoji / 组合字符（一个 grapheme cluster 多个 UTF-16 unit）能整体投递。
- **中文可行**：中文字符走的就是这条 unicode 路径，`「你好」` 会作为两个 cluster 各发一对 down/up。**这条路径完全绕过输入法（IME）**——它是直接把最终文本塞给 app，不经过候选词/组字。所以：拼音输入法不会弹候选框，也不需要处理 IME 状态；反过来，需要 IME 交互的场景（比如让 app 自己走联想）做不到。对 agent 场景这是**优点**。
- 我们现有的 `Keyboard.unicodePlan`（`native/ax-bridge/Sources/weax/Keyboard.swift:107-119`）已经是同一套思路，且**已经拒绝了「unicode + 修饰键」的组合**（`:110-113`），比 kwwk 更严谨（kwwk 的 `typeText` 干脆不支持修饰键，`press` 才支持）。

**修饰键 / 组合键**（`press(keyCombination:)`，`:304-336`）：

```swift
for modifier in combo.modifiers { post(buildKeyEvent(keyCode: modifier.virtualKey, flags: modifier.flags, isDown: true)) }
let combinedFlags = combo.modifiers.reduce(into: CGEventFlags()) { $0.formUnion($1.flags) }
post(buildKeyEvent(keyCode: combo.keyCode, flags: combinedFlags, isDown: true))
post(buildKeyEvent(keyCode: combo.keyCode, flags: combinedFlags, isDown: false))
var remaining = combinedFlags
for modifier in combo.modifiers.reversed() {
    remaining.subtract(modifier.flags)
    post(buildKeyEvent(keyCode: modifier.virtualKey, flags: remaining, isDown: false))
}
```

注意 kwwk 的修饰键事件是 **`keyDown`/`keyUp` 类型**（`CGEvent(keyboardEventSource:virtualKey:keyDown:)`，没改 `.type`），**不是 `flagsChanged`**。我们的实现（`Keyboard.plan`，`:90-102`）显式把修饰键发成 `flagsChanged`，并保证序列以 `flags == 0` 收尾——**我们的更正确，不要退回 kwwk 的写法**。我们要抄的只有「加 40 + 51/58」。

### 5.2 滚动：先 AX 后事件

`ComputerUseActions.scroll`（`:222-230`）是**两级降级**，值得照抄：

1. **优先 AX**：`performAXScroll`（`ComputerUseActionSupport.swift:282-324`）——从目标元素和窗口根出发 BFS 找 `AXScrollBar`（沿 `AXChildren`/`AXContents`/`AXVerticalScrollBar`/`AXHorizontalScrollBar` 四种关系，`:330-335`），按 `AXOrientation` 过滤方向，对它 `AXIncrement`/`AXDecrement` 重复 `ceil(pages*3)` 次；失败再退到直接 `setScrollBarValue`（把 `AXValue` 按 `span * 0.18 * pages` 挪，`:358-383`）。
2. **AX 全失败才发滚轮事件**（§2.2）。

3. **结果自检**：如果动作后 snapshot 指纹没变，返回文本里显式告诉 agent「本次滚动没有产生可观察变化，**不要据此认定列表到底了**」（`ComputerUseActions.swift:238-250`）。这是防止 agent 把「投递失败」误判成「数据到头」的护栏，值得抄进我们的返回结构（做成 `{"delivered": "ax"|"wheel", "stateChanged": false}` 而不是自然语言）。

---

## 6. CEF / Electron（飞书、Chrome）的特殊处理

`ChromiumAccessibilityActivation.swift` 的完整配方（`:44-116`）：

```swift
func activateIfNeeded(pid: pid_t, root: AXUIElement) {
    let alreadyActivated = activatedPIDs.contains(pid)
    guard assertChromiumAccessibility(root: root) else { return }   // ① 每次都重新断言
    guard !alreadyActivated else { return }                          // ② observer + 等待只做一次
    guard activatedPIDs.insert(pid).inserted else { return }
    registerObserver(pid: pid, root: root)                           // ③ 注册 13 个 AX 通知
    waitForActivation(duration: 0.5)                                 // ④ 固定睡 500ms
}

private func assertChromiumAccessibility(root: AXUIElement) -> Bool {
    var accepted = false
    for attribute in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
        let r = AXUIElementSetAttributeValue(root, attribute as CFString, kCFBooleanTrue)
        accepted = accepted || r == .success        // ← 只要有一个成功就算数
    }
    return accepted
}
```

**三个必须照做的点**：

1. **`AXManualAccessibility` + `AXEnhancedUserInterface` 两个都设，只要一个成功就继续**（`:70-79`）。我们的 `Actions.enableAX`（`native/ax-bridge/Sources/weax/Actions.swift:8-16`）已经这么做了，且协议文档已写明「两个都失败是正常的，调用方不得据此 gate」——这条是对的，保持。
2. **注册 AXObserver 是「唤醒」手段，不是为了收通知**。回调是空函数（`:12` `chromiumAXObserverNoopCallback`），13 个通知（`:118-132`：FocusedUIElementChanged / FocusedWindowChanged / ApplicationActivated / ApplicationDeactivated / ApplicationHidden / ApplicationShown / WindowCreated / WindowMoved / WindowResized / ValueChanged / TitleChanged / SelectedChildrenChanged / LayoutChanged）**注册这个动作本身**会让 Chromium 认为「有 AT 客户端在监听」，从而把完整的可访问性树构建出来。
3. **优先用私有 `_AXObserverAddNotificationAndCheckRemote`**（`:24-39`），拿不到再退 `AXObserverAddNotification`。前者会**同步等待远端进程确认**，这正是 CEF 需要的握手；后者是异步的，注册"成功"了但对端可能还没建树。

**后台激活后 AX 树是否完整 / 等多久**：

- 源码给出的确定数字只有一个：**首次激活后固定 `Thread.sleep(0.5)`**（`:61,114-116`），无重试、无轮询。
- 真正的「等到稳定」逻辑在动作之后：`captureSettledSnapshot`（`ComputerUseCore.swift:379-445`）反复抓 snapshot 算指纹，**要求连续 3 次指纹相同**才认为稳定，**超时 1600ms**，轮询间隔 **120ms**（`ComputerUseActionSettleTiming`，`:1175-1205`，可用 `KWWK_COMPUTER_USE_CORE_ACTION_SETTLE_*_MS` 环境变量覆盖）。
- **激活后会重新抓一次树**：`captureSnapshotAfterPreparingTarget`（`ComputerUseActionSupport.swift:41-79`）——先抓一次拿到 pid/windowID，`prepareForSnapshotCapture` 若返回「本次真的做了激活」，**丢掉第一次结果重抓**。这就是「后台 CEF 第一次抓是空/残缺」的正解：**不是等更久，是激活后重抓**。
- 失败重试策略：源码里**没有**针对 CEF 的显式重试。可靠性来自「激活幂等 + 重抓 + 指纹稳定轮询」这三件事的组合。

**CEF 元素的点击方式**（`ComputerUseActionSupport.swift:168-178`）：

```swift
static func shouldUseMouseClickForElement(_ node: RuntimeAXNode, in snapshot: RuntimeAppSnapshot) -> Bool {
    guard node.role != kAXMenuBarItemRole as String, node.role != kAXMenuItemRole as String else { return false }
    return webAreaAncestor(for: node, in: snapshot) != nil     // 祖先里有 AXWebArea → 必须用鼠标事件
}
```

**在 `AXWebArea` 里的元素一律走合成鼠标点击，不走 `AXPress`**；菜单项例外（菜单必须走 `AXPress`/`AXPick`）。非 web 元素则先试 `AXPress`，失败才降级到鼠标点击（`ComputerUseActions.swift:150-154`）。这与我们 `spikes/README.md` 记录的经验一致，可以直接固化成规则。

---

## 7. 我们 `native/ax-bridge` 的改造清单

### 7.1 现状精确定位（问题在哪一行）

| 问题 | 位置 | 事实 |
|---|---|---|
| 键盘没填窗口寻址 | `Sources/weax/Actions.swift:80-93` | `post()` 只有 `event.flags = spec.flags` + `event.postToPid(pid)`，**40 / 51 / 58 全缺** |
| 鼠标走全局 HID tap（抢光标） | `Sources/weax/Mouse.swift:86-107` | `move.post(tap: .cghidEventTap)` + down/up 同样 `.cghidEventTap` |
| 注释把「HID tap 是唯一出路」写成了定论 | `Sources/weax/Mouse.swift:7-10` | 「mouse events MUST go to the global HID tap … Posting them to a pid instead makes clicks land nowhere」——**在没有窗口寻址字段的前提下这句是对的，但它被写成了普适结论**，正是它挡住了后台方案。改造时必须一并改掉，否则下一个人还会被它劝退 |
| `windows` 不返回 windowNumber | `Sources/weax/Dispatcher.swift:82-90` | 只有 AX 描述 + `index` |
| 无激活/焦点抑制概念 | 全仓 | 没有 session、没有 tap、没有 frontmost 监听 |

### 7.2 新增文件（移植自 kwwk，保留 cua-driver attribution）

```
native/ax-bridge/Sources/weax/
├── background/
│   ├── WindowAddressing.swift        // CGEvent extension: setWindowAddressingFields(51/58) + 40/91/92 封装
│   ├── WindowLocalEvent.swift        // CGEventSetWindowLocation 的 dlsym 解析（← BackgroundWindowLocalEvent.swift）
│   ├── AXWindowID.swift              // _AXUIElementGetWindow（← AXWindowIDResolver.swift）
│   ├── CoordinateSpaces.swift        // 四空间 + 换算（← CoordinateSpaces.swift，可去掉 AppKit/Screenshot 两个空间）
│   ├── BackgroundDispatcher.swift    // 鼠标/键盘/滚轮 postToPid（← BackgroundInputDispatcher.swift）
│   ├── ActivationSession.swift       // tap + 两步激活 + 复位（← BackgroundActivationSession.swift）
│   ├── TapRunLoopThread.swift        // 专用 runloop 线程（← CoreRunLoopThread.swift）
│   └── FrontmostMonitor.swift        // NSWorkspace 前台变更监听（← FrontmostApplicationMonitor.swift）
└── SessionRegistry.swift             // bgSession id → ActivationSession 的句柄表（仿 ElementRegistry）
```

新增 `LICENSES/cua-driver-MIT.txt`，并在 `WindowAddressing.swift` / `WindowLocalEvent.swift` / `ChromiumActivation` 相关文件头加衍生声明。

### 7.3 协议扩展（**严格向后兼容**）

原则：**现有 op 的默认行为一个字节都不变**，后台能力全部通过新增可选参数和新 op 引入。`docs/ax-bridge-protocol.md` 明说「neither side may extend it unilaterally」，所以文档和两端要同一个 commit 改。

**A. 新 op（4 个）**

| op | params | result |
|---|---|---|
| `windowInfo` | `pid`, `windowIndex?` \| `nodeId?` | `{"windowNumber": int, "frame": AxFrame, "title": string, "isMain": bool, "layer": int, "resolvedBy": "axSPI"\|"frameMatch"\|"titleMatch"\|"fallback"}` |
| `bgSession` | `pid`, `windowNumber` | `{"session": int, "suppressing": bool, "activated": bool, "frontmostUnchanged": bool}` |
| `bgRelease` | `session` | `{"session": int, "ok": true}` |
| `scroll` | `session?`, `nodeId`\|(`x`,`y`), `direction`, `pages?`, `dryRun?` | `{"ok": true, "delivered": "ax"\|"wheel", "plan": {...}}` |

**B. 现有 op 加可选参数（不传 = 完全维持旧行为）**

| op | 新增可选参数 | 语义 |
|---|---|---|
| `click` | `session` | 传了就走 `postToPid` + 窗口寻址；不传维持 `.cghidEventTap` |
| `keystroke` | `session` | 传了就补 40 + 51/58；不传维持裸 `postToPid` |
| `windows` | — | result 每项**增加** `windowNumber` 字段（新增字段，旧客户端忽略即可，属兼容变更） |

**C. `plan` 字段扩展**（`dryRun` 是我们的核心可测性资产，必须覆盖新路径）

```json
{"ok": true, "dryRun": true, "plan": {
  "x": 512, "y": 384,
  "windowLocal": {"x": 212, "y": 84},          // 新：Quartz 窗口内坐标（左上原点）
  "target": "postToPid(702)",                   // 新：后台模式下不再是 tap
  "tap": null,                                  // 新：后台模式为 null，前台模式仍是 "cghidEventTap"
  "fields": {"40": 702, "51": 19334, "58": 1, "91": 19334, "92": 19334},   // 新：所有寻址字段可断言
  "windowLocationApplied": true,                // 新：CGEventSetWindowLocation 是否真的生效
  "events": ["leftMouseDown", "leftMouseUp"]
}}
```

**D. 新错误码**

| code | 含义 |
|---|---|
| `NO_WINDOW_ID` | `_AXUIElementGetWindow` 与全部降级都没能解析出 windowNumber |
| `SPI_UNAVAILABLE` | `CGEventSetWindowLocation` 或 `_AXUIElementGetWindow` 在本系统上 dlsym 失败 |
| `TAP_FAILED` | `CGEvent.tapCreateForPid` 返回 nil（通常是 AX 权限被撤） |
| `NO_SUCH_SESSION` | `session` 句柄未知（对齐现有 `NO_SUCH_SUBSCRIPTION` 的命名） |
| `STALE_FRAME` | 坐标动作时窗口 frame 与建立 session 时相差 > 8pt |

**E. TS 侧**：`src/perception/macos/axProtocol.ts:15-30` 的 `AX_OPS` 加 4 个新 op；`AxFrameSchema` 之外加 `AxWindowInfoSchema` / `AxSessionSchema`；`shutdown` 目前不在 `AX_OPS` 里（Swift 端有、TS 端无），补上时顺手对齐。

### 7.4 实现要点清单（按依赖顺序）

1. `WindowAddressing.swift`：`setWindowAddressingFields` + `setMouseWindowFields`（91/92）+ `setTarget(pid:)`（40）。**`CGEventField(rawValue:)` 失败要能上报**，不能像 kwwk 那样静默跳过。
2. `WindowLocalEvent.swift`：`setPoint` 返回 `Bool`，**必须冒泡到 `plan.windowLocationApplied`**。
3. `AXWindowID.swift` + `windowInfo` op：主路径 SPI，降级链照 §4.1 五级实现，`resolvedBy` 回传，便于诊断。
4. `TapRunLoopThread.swift`：**先于 tap 存在**。我们的 `Dispatcher` 全部在主线程跑同步 AX 遍历（`Dispatcher.swift:6-7`），tap 回调**绝不能挂主 runloop**。
5. `ActivationSession.swift`：
   - `start(targetPID:)` 内部先记 `previousApp` 再装 tap（顺序不能反）。
   - **加 kwwk 缺失的 tap 自愈**：回调里判 `type.rawValue == 0xFFFFFFFE`（`kCGEventTapDisabledByTimeout`）或 `0xFFFFFFFF`（`ByUserInput`）时立刻 `CGEvent.tapEnable(tap:enable:true)` 并计数上报。
   - **收紧 `eventsOfInterest`**：kwwk 用 `CGEventMask.max` 拦全部事件，风险太大（§9.3）。先实测 13/19/20 三个类型是否够，若够就用 `(1<<13)|(1<<19)|(1<<20)`；实测不够再放宽，**但要把最终 mask 写进代码注释并附实测凭证**。
   - `activateWindow` 两步；`release()` 里按 kwwk 的条件发 subtype=2 复位（目标已是前台就跳过）。
   - 挂 `FrontmostMonitor`，用户抢回焦点时自动 release。
6. `BackgroundDispatcher.swift`：鼠标 `mouseEventSource: nil`（**与我们键盘的 `.privateState` 不同，别统一**）；键盘沿用我们现有的 `flagsChanged` 编排 + `.privateState`，**只加 40/51/58**。
7. `Mouse.swift`：保留 HID tap 路径作为 `session` 缺省时的行为，**同时重写文件头注释**——把「MUST go to HID tap」改成「不带窗口寻址字段时只能走 HID tap；带齐 40/91/92/51/58 + windowLocation 后 postToPid 可精确投递到后台窗口」。
8. `Dispatcher.swift`：`trustRequired` 集合加入 `windowInfo`/`bgSession`/`bgRelease`/`scroll`。
9. **CEF 唤醒升级**：`Actions.enableAX` 现在只设两个属性就返回。补上 kwwk 的第 2、3 步——注册空回调 AXObserver（13 个通知，优先私有 `_AXObserverAddNotificationAndCheckRemote`）+ 首次 500ms 等待，并把 observer 按 pid 缓存。可以复用现有 `ObserverRegistry`（`Sources/weax/Observer.swift`）。
10. TS 客户端 + `docs/ax-bridge-protocol.md` 同 commit 更新。

---

## 8. 怎么验证「没抢前台」——可自动化判据

kwwk 的 GUI probe 测试给了一套**完整可抄的判据**，在 `Tests/KWWKComputerUseCoreTests/InProcessComputerUseBehaviorTests.swift:944-973`（`ProbeHarness.captureBaseline` + `expectInvariant`）：

```swift
static func captureBaseline(_ context: Context) -> Baseline {
    Baseline(stack: stack(ids: context.ids),                    // 屏上窗口 z 序
             frontmost: frontmost(),                            // "名称:pid"
             cursor: CGEvent(source: nil)?.location ?? .zero,   // 真实光标位置
             clicks: clicks())                                  // 目标 app 自报的累计点击数
}

static func expectInvariant(baseline: Baseline, context: Context, expectedClicks: Int) throws {
    // 先给最多 2s 让状态收敛
    let deadline = Date().addingTimeInterval(2.0)
    while Date() < deadline, (frontmost() != baseline.frontmost || clicks() != expectedClicks) { pump(0.05) }

    let currentState = lastState("ProbeB") ?? ""
    #expect(Set(stack(ids: context.ids).split(separator: ">")) == Set(baseline.stack.split(separator: ">")))
    #expect(frontmost() == baseline.frontmost)                                    // ① 前台 app 没变
    #expect(distance(CGEvent(source: nil)?.location ?? .zero, baseline.cursor) <= 1)  // ② 真实光标位移 ≤ 1pt
    #expect(clicks() == expectedClicks)                                           // ③ 目标收到的点击数精确匹配
    #expect(currentState.contains("isActive=true"))                               // ④ 目标自认 active
    #expect(currentState.contains("isKey=true"))                                  //    自认 key
    #expect(currentState.contains("isMain=true"))                                 //    自认 main
    #expect(currentState.contains("front=ProbeA"))                                // ⑤ 目标看到的 frontmost 仍是别人
}
```

**判据 ④+⑤ 是整个方案的判决性证据**：目标 app 内部 `NSApp.isActive == true`、窗口 `isKeyWindow/isMainWindow == true`，**而它自己读到的 `NSWorkspace.frontmostApplication` 仍是另一个 app**。这个自相矛盾的状态正是「后台驱动」成立的定义。

probe app 的自报方式（`scripts/ActivationProbe/main.swift:222-228`）：

```swift
private func writeState() {
    let front = NSWorkspace.shared.frontmostApplication?.localizedName ?? "nil"
    writeLog("isActive=\(NSApp.isActive) isKey=\(window?.isKeyWindow == true) " +
             "isMain=\(window?.isMainWindow == true) front=\(front) clicks=\(clickCount)")
}
```

它在 `windowDidBecomeKey/Main`、`windowDidResignKey`、按钮点击等回调里写一行到 `/private/tmp/<ProbeName>.activation.log`。

### 给我们的落地方案

1. **抄 probe app**：`scripts/build-activation-probe-apps.sh` + `scripts/ActivationProbe/main.swift` 几乎可以原样搬（无签名，`swiftc` 直编 + 手写 Info.plist，产出 3 个 `.app` 到 `/private/tmp/`）。三个 probe（A/B/C）的用途：A 当「用户正在用的前台 app」，B 当操作目标，C 当第三方干扰。
2. **`we-ax` 侧加 `dryRun` 之外的自检**：`bgSession` 的 result 直接带上 `frontmostUnchanged`（session 建立前后比对 `NSWorkspace.frontmostApplication?.processIdentifier`）和 `cursorMoved`（比对 `CGEvent(source: nil)?.location`）。**让不变量在协议层可断言，而不是只在测试里断言。**
3. **补 kwwk 测试的两个漏洞**：
   - `Set(stack.split(">"))` 用的是**集合比较**，只能验证「同一批窗口还在屏上」，**验证不了 z 序**。我们应改成有序比较（`stack(ids:) == baseline.stack`），否则「窗口被提到最前」这个最典型的抢前台症状测不出来。
   - 没有测「用户在 agent 动作期间正常输入」。应加一条：抑制期内向 ProbeA 发键盘/点击，断言 ProbeA 正常收到（验证抑制没有误伤用户）。
4. **真机验证清单**（按 CLAUDE.md ③ 的实证要求，逐条留凭证到 `$CLAUDE_JOB_DIR/tmp/`）：

| 步骤 | 验证方式 | 凭证 |
|---|---|---|
| 窗口寻址生效 | `click` with `dryRun` → 断言 `fields.51 == windowNumber && fields.58 == 1 && windowLocationApplied == true` | NDJSON 响应存档 |
| 后台点击真落地 | 对 ProbeB 后台点击 → 读 `/private/tmp/ProbeB.activation.log` 的 `clicks=` | 日志 diff |
| 不抢前台 | `frontmost()` 前后一致 + probe 日志 `front=ProbeA` | 日志 + 截图 |
| 不动光标 | `CGEvent(source: nil)!.location` 位移 ≤ 1pt | 数值对照 |
| 目标自认 active | probe 日志 `isActive=true isKey=true isMain=true` | 日志 |
| 抑制不误伤 | 抑制期内手动/合成向 ProbeA 输入，ProbeA 日志有响应 | 日志 |
| 飞书 CEF 后台出树 | 飞书**不在前台**时 `bgSession` + `tree`，节点数 > 阈值且能 find 到 `AXWebArea` 后代 | 树 JSON + 节点计数 |
| 中文输入 | 后台 `keystroke` 打「你好」到飞书输入框，`attr AXValue` 读回 | 请求/响应对 |

---

## 9. 风险与降级

### 9.1 私有 API 稳定性

| 依赖 | 类型 | 风险 | 检测 | 降级 |
|---|---|---|---|---|
| CGEventField **51 / 58** | 私有字段号 | **最高**。字段号是 WindowServer 内部约定，可随 macOS 大版本变。SDK 头里 51/58 是空洞（40 之后直接跳到 88/91/92），说明这段号是保留/内部用途 | 无法直接检测——`setIntegerValueField` 对未知字段**不报错**。只能靠**行为探针**：后台点一次 probe 中心，看 `clicks` 有没有 +1 | 探针失败 → 整个 session 降级为前台模式（`NSRunningApplication.activate()` + HID tap），并在 result 里标 `mode: "foreground-fallback"` |
| `CGEventSetWindowLocation` (SkyLight) | 私有符号 | 中。符号名多年稳定，但 SkyLight 是私有框架 | `dlsym` 返回 nil → 可直接检测 | 报 `SPI_UNAVAILABLE`，降级前台模式 |
| `_AXUIElementGetWindow` (HIServices) | 私有符号 | 中低。这个符号在社区里被用了十年以上 | `dlsym` 返回 nil 可检测 | 走 §4.1 的 CGWindowList 降级链（title + frame 匹配），**仍然可用**，只是准确度下降 |
| `_AXObserverAddNotificationAndCheckRemote` | 私有符号 | 低。kwwk 自己就有 fallback | `dlsym` nil | 退 `AXObserverAddNotification`（kwwk 已实现，`:108-111`） |
| `NSEvent.otherEvent(.appKitDefined, subtype: 1)` | 公有 API + 未文档化语义 | 中。API 公有，但「往别的进程发 appKitDefined 就能让它自认 active」是未文档化行为 | 靠 probe 的 `isActive=true` 断言 | 无直接降级，只能整体退前台模式 |

**总原则**：所有私有依赖都必须有**运行时探针 + 显式降级路径 + 在 result 里如实标注模式**。绝不能出现「看起来成功了但什么也没发生」。

### 9.2 macOS 版本

- kwwk 声明 `platforms: [.macOS(.v14)]`，CI 只跑 `macos-15`。
- 本机是 **Darwin 25.3.0 = macOS 26.x**（不是 15）。**kwwk 没有在 macOS 26 上的 CI 证据**。
- `NSEvent.h` 里 `NSEventTypeMouseCancelled = 40 API_AVAILABLE(macos(26.0))` 说明 26 确实动过事件类型表——**必须在本机先跑通 probe 再动手改造**，不能假设 kwwk 的数值在 26 上照样成立。
- 这是**开工第一步**：先只移植 §7.2 的 `WindowAddressing` + `WindowLocalEvent` + `AXWindowID` 三个文件，写一个最小 probe，验证「后台点击能落到 probe 上且不抢前台」。**这一步不过，后面全部无效。**

### 9.3 `eventsOfInterest = CGEventMask.max` 的代价（kwwk 的设计我不建议照抄）

- 后果：抑制期内，**原前台 app 的每一个鼠标移动、每一次按键、每一个手势**都要经过一次跨进程往返到我们的 tap 回调。
- 如果我们的 runloop 线程有任何卡顿，macOS 会判超时并**禁用 tap**（`kCGEventTapDisabledByTimeout`）。kwwk **完全没有处理这个事件**（全仓 grep `tapDisabled` 零命中，`tapEnable` 只在 `:225` 调一次）。tap 一旦被禁，抑制静默失效，下一次激活就会把用户前台切走——**这是 kwwk 现存的真实 bug**。
- 我们的做法：① 回调里必须处理 tapDisabled 并重新 enable；② mask 收窄到实测所需的最小集合；③ 回调本身零分配、零锁竞争（kwwk 用 `NSLock.withLock` 读 phase，`:234`——在全事件 mask 下这是每个事件一次加锁，应改成 atomic）。

### 9.4 focus 消息识别（13/19/20）的误伤

- 13 = `NSEventTypeAppKitDefined`，确实是激活/去激活的载体。
- **19/20 在 `NSEvent.h` 里是 `NSEventTypeBeginGesture` / `NSEventTypeEndGesture`**（已核对本机 SDK 头）。kwwk 注释自称这是「focus messages」，但没有给出依据。
- 若 19/20 真的是手势，那么**抑制期内原前台 app 的触控板手势（缩放/滑动）会被丢弃**——用户会感到「agent 一动，我的触控板就失灵一下」。
- 处置：改造时**先只丢 13**，用 probe 验证够不够；不够再逐个加 19、20，并在真机上确认触控板手势不受影响。**不要一上来照抄三个。**

### 9.5 center primer 会误触

- 激活会在**窗口正中心真点一下**（`BackgroundActivationSession.swift:132-135`）。飞书会话列表正中、Chrome 页面正中都可能是可点内容。
- kwwk 没有任何缓解手段（probe 中心是空白，测不出来）。
- 我们的缓解方向（需实测）：
  1. 优先找窗口内**已知安全区**（如标题栏下方 / 无 AX 子元素覆盖的空白点）做 primer，用 AX 树先算一个「没有可交互元素覆盖」的点；
  2. 只发 `mouseDown` + `mouseUp` 且间隔尽量短，实测是否已足以激活（若 `mouseDown` 单独就够，误触面大幅缩小）；
  3. **先只发 appKitDefined primer（步骤①），实测能否单独激活**——若能，直接不要 center primer。这条最值得先试。

### 9.6 哪些 app 会失效

- **无 CGWindow 的 app**：`windowNumber == 0` 时，`activateWindow`、`postWindowActivationEvent`、`postWindowCenterPrimer` 全部 early return（`:80,99,130`）。菜单栏 extra（`AXMenuExtra`）、无窗口的后台 app 属于这一类——kwwk 对它们走纯 `AXPress` 路径（`ComputerUseActions.swift:147-150`），不做后台激活。
- **弹出菜单**：菜单是独立的 popUpMenu level 窗口（`ComputerUseCore.transientMenuWindowFrame`，按 `CGWindowLevelForKey(.popUpMenuWindow)` 筛，`:642+`）。菜单一旦打开就是系统级模态，**后台驱动对它基本无效**，必须走 `AXPress`/`AXPick`。这也是 `shouldUseMouseClickForElement` 把 `AXMenuBarItem`/`AXMenuItem` 显式排除的原因（`ComputerUseActionSupport.swift:172-175`）。
- **全屏 / Stage Manager / 多 Space**：源码无任何处理。目标窗口在别的 Space 时，`CGWindowListCopyWindowInfo` 用 `.optionAll` 仍能列到，但激活行为未知——**需实测**。
- **沙盒 / 加固运行时的 app**：`postToPid` 依赖 AX 权限，被 SIP 保护的系统 app（如「密码」「系统设置」的部分面板）可能拒收。

---

## 10. 落地顺序（不含工期）

1. **可行性闸门**：只移植 `WindowAddressing` / `WindowLocalEvent` / `AXWindowID`，加 `windowInfo` op，写最小 probe，验证「本机 macOS 26 上后台点击能落地 + 前台不变 + 光标不动」。不过就停，回头做归因。
2. 闸门通过 → `TapRunLoopThread` + `ActivationSession`（含 tapDisabled 自愈、mask 收窄、13-only 起步）+ `bgSession`/`bgRelease`。
3. `click`/`keystroke` 加 `session` 参数走后台路径，`plan` 扩展，`dryRun` 全覆盖。
4. `enableAX` 升级为 kwwk 的三步 CEF 唤醒；`captureSnapshotAfterPreparingTarget` 的「激活后重抓」语义搬进我们的 `tree`/`find`。
5. 新增 `scroll` op（AX 优先 + 滚轮降级 + `stateChanged` 自检）。
6. 协议文档 + TS 客户端 + probe 测试同 commit 落地；跑完 §8 的八条真机验证表。
