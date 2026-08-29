# Spike：pyobjc + Accessibility API 读写飞书

结论先行：**飞书（Lark）读写全部打通，实测发出并读回了消息。**

> 范围：按用户要求，**钉钉不做**，本报告不含任何钉钉内容。

- 探针代码：`spikes/ax_probe.py`
- 证据 AX 树：`spikes/evidence/feishu_tree.txt`
- 过程脚本与中间 dump：`/Users/caosen/.claude/jobs/ae02c800/tmp/spike/`（随任务清理，故关键树已拷进 `evidence/`）
- 环境：macOS 15 (Darwin 25.3.0) / Apple Silicon，Python 3.12.11 + pyobjc 12.2.2，飞书 `Lark Framework 143.0.7499.203`

---

## 总表

| 步骤 | 结果 |
|---|---|
| 1 权限 | 通过 |
| 2 需不需要手开 AX | **不需要**，两个开关都不支持，开关前后节点数不变 |
| 3 感知（读会话/消息/输入框） | **通过**，选择器稳定到 CSS class 级别 |
| 4 事件驱动 observer | **通过**，延迟 60 ms |
| 5 执行（写入+发送） | **通过**，已发出 1 条并读回 |
| 6 性能 | 读 20 条 121 ms / 全窗口 dump 248 ms |
| — 钉钉 | **按用户要求未做** |

---

## 1. 权限：通过

`AXIsProcessTrusted()` → `True`，无需弹窗。

要点：辅助功能授权授给的是 **responsible process（拉起解释器的那个 .app）**，不是 python 可执行文件本身。本次进程链：

```
python(venv) → /bin/zsh → claude bg-spare → claude bg-pty-host → /Users/caosen/.local/bin/claude → launchd
```

`sys.executable` 是 `…/axenv/bin/python`，真实路径 `~/.local/share/uv/python/cpython-3.12.11-macos-aarch64-none/bin/python3.12`。它自己没有单独授权，是继承了宿主 app 的授权。**部署到别的宿主（launchd plist、别的终端）时要重新授权那个宿主**，不是授权 python。

## 2. Electron/CEF 的 AX 开关：不需要，且不支持

飞书是 **CEF（Chromium Embedded）**，不是 Electron。原生 Views 类名在 AX 树里直接可见：`RootView / NonClientView / LarkClientView / BrowserView / TabContentsView / MultiWebView`。

对 application 元素设置两个常见开关，都被拒绝：

| 属性 | 返回码 | 含义 |
|---|---|---|
| `AXManualAccessibility` | `-25205` | kAXErrorAttributeUnsupported |
| `AXEnhancedUserInterface` | `-25208` | kAXErrorNotImplemented |

而**开关前后节点数完全一致（923 → 923，depth 41）**，说明飞书的 AX 树默认就是全量暴露的。`enable_embedded_ax()` 保留在代码里只作为探测其他客户端用，对飞书是 no-op。

## 3. 感知：通过

### 3.1 关键发现：Chromium 暴露 DOM 属性

每个 web 节点都带 `AXDOMIdentifier`（DOM id）和 `AXDOMClassList`（CSS class 列表），还有 `ChromeAXNodeId`。**这是本 spike 最有价值的一点**——不用靠 role+序号+坐标猜，可以直接按 CSS class 选择。

飞书的 class 分两类，只能用后者：
- **哈希类**：`_13e3ffd`、`c90c31ea`、`edb023db` —— 每次发版都会变，**绝对不要用**
- **语义钩子类**：`js-message-item`、`chatMessages`、`a11y_feed_card_item`、`chatWindow_chatName` —— 其中 `js-` 前缀按惯例是给 JS 用的、不参与样式，`a11y_` 是飞书专门为无障碍加的，这两类最稳

### 3.2 稳定选择器

| 目标 | 选择器 | 说明 |
|---|---|---|
| 会话列表容器 | `.a11y_feed_main_list` | 也叫 `lark_feedMainList` |
| 单个会话卡片 | `.a11y_feed_card_item` | 文本顺序＝[名称, 标签, 日期, 预览] |
| 当前会话标题 | `.chatWindow_chatName` | |
| 会话类型 | `.chatContainer` 的 class 列表 | 含 `p2pChat` / 群聊为其他 |
| 消息列表 | `.chatMessages` → `.messageContainer` → `.list_items` | observer 挂这里 |
| 单条消息 | `.js-message-item` | **`AXDOMIdentifier` 就是飞书真实 message_id** |
| 消息正文 | `.message-content-container`（普通）/ `.universal-card-root`（卡片） | |
| 日期分隔 | `.divider.date-divider` | |
| 输入框 | `AXTextArea` 且 class 含 `editor-kit-container` | |

单条消息的完整 class 列表本身就是结构化元数据，实测样例：

```
['js-message-item', 'message-item', 'message-not-self', 'message-item-first',
 'message-is-p2p', 'message-me-read', 'text-card-message', 'card-message']
```

- `message-self` / `message-not-self` → 收发方向
- `message-is-p2p` → 单聊还是群
- `message-me-read` → 已读状态
- `text-message` / `card-message` / `text-card-message` → 消息类型

对应实现见 `ax_probe.py` 的 `feishu_conversations()` / `feishu_messages()` / `feishu_composer()` / `feishu_chat_title()`。

实测读到 18 条会话（名称/标签/日期/预览全有）、当前会话 11 条消息（id + 方向 + 类型 + 正文全有）。

### 3.3 读不到的东西（要如实记）

- **每条消息没有时间戳**。AX 树里只有 `.date-divider` 的日期（"8月21日"），精确时间飞书只在 hover 时渲染，不在树里。可用的替代：`AXDOMIdentifier` 是雪花型 id，**单调递增**，排序可靠；绝对时间要么靠日期分隔符推，要么靠自己首次见到该 id 的时刻打戳。
- **单聊里没有发送者名字节点**，`message-left` 里只有头像。单聊靠 `message-self` 判断方向就够；群聊需要另测（本次当前会话是单聊，没验到群聊的发送者节点）。
- **列表是虚拟化的**：AX 树里只有当前渲染出来的行（实测 6~11 条），拿历史必须先滚动。

## 4. 事件驱动 observer：通过

`AXObserverCreate` + `AXObserverAddNotification` 挂在 `.chatMessages` 和 application 元素上，订阅 `AXValueChanged` / `AXCreated` / `AXLayoutChanged`，`CFRunLoopAddSource` 后跑 run loop。

**实测：自己给自己发一条，`AXValueChanged` 在 Enter 后 +0.060s 触发（两次）。**

坑：pyobjc 的回调必须是带类型签名的闭包，直接传普通函数会报 `Callable argument is not a PyObjC closure`。必须用

```python
@objc.callbackFor(AXObserverCreate)
def trampoline(observer, sender, notification, refcon): ...
```

而且要自己持有引用防止被 GC。

**如实说明**：触发验证是用**自己发出的消息**做的（新消息节点插入 DOM）。别人发来的消息走同一条 DOM 插入路径，理论上一致，但本次没有独立验证——要真验得等一条真实入站消息。

## 5. 执行（写入 + 发送）：通过

**实测结果**：在自聊会话发出 `[work-everything spike] hello`，读回

```
NEW id=7679345486104415420 from_me=True kind=text-message text='[work-everything spike] hello'
```

发送后输入框自动复位成 placeholder。只发了这一条。

### 安全门

飞书的自聊会话就是**和自己同名的那个会话**（本机账号 `曹良欢（Sion）`）。判定它是自聊的**决定性证据是输入框 placeholder 文案**：普通会话是 `发送给 <对方名>`，自聊是 **`可以向自己发送文件或转发消息`**。脚本在按 Enter 前强制校验：会话标题 == 本人姓名 **且** 输入框内容包含目标文本，任一不满足直接 abort（实测 abort 过 3 次，没有误发）。

### 正确的写入姿势

1. `AXValue` **不能写**。输入框是飞书 editor-kit 的 contenteditable，`AXValue` 只读、而且读出来永远是 placeholder（`可以向自己发送文件或转发消息​​​`），不是真实内容。真实内容要遍历子节点的 `AXStaticText`。
2. `AXUIElementSetAttributeValue(composer, "AXFocused", True)` 对 contenteditable **无效**，必须用**真实鼠标点击**（`AXPosition`+`AXSize` 算中心点 → CGEvent 点击）。
3. 点完必须 `AXFocusedUIElement` 回读确认焦点，确认后才允许敲键（见下面的坑 #3）。
4. **没有发送按钮**。整个 toolbar 全是图标按钮（表情/图片/…），发送靠 **Enter**——树里有个 `.editor__tip--enter` 节点就是这个提示。
5. 发完输入框自动清空，可用作发送成功的二次确认。

## 6. 性能实测（中位数，5 次）

| 操作 | 耗时 | 规模 |
|---|---|---|
| 读当前会话标题 | 41 ms | |
| 读会话列表 | 72 ms | 18 条 |
| 读最近 20 条消息 | 121 ms | 实得 7 条（虚拟化） |
| 全窗口 AX dump | 248 ms | 786~923 节点，depth 41 |

轮询完全跑得动，但既然 observer 只有 60 ms 延迟，应该用事件驱动 + 兜底轮询。

## 7. 钉钉

**按用户要求未做。** 本次 spike 范围只包含飞书，钉钉的 dump、observer、发消息全部未执行，报告中也不对钉钉的可行性下任何结论。

---

## 踩过的坑（按杀伤力排序）

**#1 键盘事件必须 `CGEventPostToPid`，鼠标事件必须走全局 HID tap**

最坑的一个。`CGEventPost(kCGHIDEventTap, 键盘事件)` 发给飞书，**原生层收得到**（会触发菜单快捷键、把界面导航到别的 tab），**但永远进不了 CEF 渲染层**，所以一个字都打不进去。必须 `CGEventPostToPid(pid, event)`。

反过来，**鼠标事件必须走 `kCGHIDEventTap`**，因为要靠窗口服务器按屏幕坐标路由；改成 `PostToPid` 后点击落空、焦点静默失败。

这个不对称性极具迷惑性：现象长得完全像"焦点没拿到"，我一开始就往焦点方向查错了。

**#2 `CGEventSetFlags` 伪造 Cmd 组合键会把修饰键卡住，污染后续所有击键**

用 `kCGEventSourceStateHIDSystemState` 建事件源时，事件源会**继承当前的修饰键状态**。我用 `CGEventSetFlags(ev, kCGEventFlagMaskCommand)` 伪造了一次 Cmd+A，但从来没有真正发过 Command 的 key-up，于是 Command 标志位一直挂着，**后面每一次击键都变成了 Cmd 组合键**——打 `work-everything` 时那个 `w` 变成 **Cmd+W，直接把飞书窗口关了**。

我为此白白怀疑了好几轮"飞书窗口为什么自己会关"。修法：
- 事件源用 `kCGEventSourceStatePrivate`（干净的、不继承状态）
- 每个事件都显式 `CGEventSetFlags(ev, flags)`，包括显式置 0

**#3 焦点没确认就敲键 = 破坏性操作**

焦点不在输入框时，飞书把每个字符当全局快捷键吃掉，会跳到历史记录页、切 tab、关窗口。所以 `set_text_via_keyboard()` 在 `is_focused()` 确认之前**一个键都不发**。`is_focused` 用 class 列表比对而不是元素相等——Chromium 里每次 `AXUIElementCopyAttributeValue` 拿到的 AXUIElement 不是同一个对象，直接 `==` 永远为 False。

**#4 飞书大部分时间是 0 个 AXWindow**

飞书关窗后只留在 Dock，此时 `AXWindows` 是空的，所有遍历静默返回空——**看起来跟"AX 坏了"一模一样**。而 `NSRunningApplication.activate()` **不会**重新打开窗口，只会把已有窗口提到前面。只有 reopen Apple Event（`open -a /Applications/Lark.app`）能把窗口拉回来。`ensure_window()` 就是干这个的，每次操作前都该调。按 Esc 也会关窗口。

**#5 不要假设 `AXWindows[0]` 是主窗口**

点头像会弹出 `ModalWebViewWidget - main-window:ternantCardModal:default` 这种独立 AX 窗口，排在主窗口前面。`main_window()` 现在会跳过 `ModalWebViewWidget` 开头的标题，`feishu_web_area()` 直接遍历所有窗口找。

**#6 遍历深度不能设浅**

飞书的消息正文在窗口下方 **depth 30~45**。我一开始 `maxdepth=14`，只拿到 274 个节点、全是空 `AXGroup`，差点误判成"CEF 树是空壳"。实际全量是 923 节点 / depth 41。`MAX_DEPTH` 现在是 60。

**#7 pyobjc 的 out 参数写法**

`AXValueGetValue(pos, kAXValueCGPointType, None)` —— 第三个参数传 `None`，返回 `(ok, value)`。传 `CGPoint()` 会报 `ValueError: 'valuePtr' should be None`。

**#8 飞书的 AX 接口会整个卡死，且症状伪装成"窗口没开"**

跑到最后复验时撞上的，**这是上线前必须处理的运行时风险**：飞书跑了 4 天 17 小时、经历多轮开关窗后，它的 AX 提供者进入了坏状态——

- `AXWindows` 长度是 1，但里面那个元素的 `AXRole` 是 **`AXApplication`（应用自己）**，不是 `AXWindow`，且没有 `AXSize`
- 与此同时**真实窗口好好地显示在屏幕上**（CGWindowList 里 1397x937 onscreen），进程健康（STAT=S，CPU 1.1%）
- Apple Event 也一起坏了：`osascript -e 'tell application "飞书" to activate'` 报 **-1728（不能获得该 application）**
- `NSRunningApplication.activate()` 调了也不生效，`AXFrontmost` 恒为 False
- `open -a` 重开窗口**无效**

危险的地方在于：按 role 过滤后 `windows()` 返回空列表，**和"用户把窗口关了"完全一样**，于是 `ensure_window()` 会无限重试 `open -a`，永远等不到。

已加 `ax_health(app)` 专门区分这三态，`ensure_window()` 撞上 `wedged` 会直接抛错而不是傻等：

```python
p.ax_health(app)   # 'ok' | 'no_window' | 'wedged'
```

**恢复方式只有重启飞书客户端。** 本次没有替用户重启（那是用户自己的聊天应用，且飞书本身还能正常用，只有 AX 层坏了），所以最后一次只读复验没跑成——但发消息、observer、选择器这些结论都是在此之前实测拿到的，证据是 message id `7679345486104415420` 和 `evidence/feishu_tree.txt`。用户重启飞书后可直接重跑复验。

**#9 本机没有屏幕录制权限**

`screencapture` 全部失败（`could not create image from display` / `from rect`），所以本报告**没有截图**，全部证据是 AX 树 dump 和读回的消息 id。要截图需要用户在「系统设置 → 隐私与安全性 → 屏幕录制」里授权宿主 app。

---

## 复用方式

```python
import sys; sys.path.insert(0, "spikes")
import ax_probe as p

pid = p.find_pid(p.FEISHU_BUNDLE_ID)
p.ensure_window(pid, p.FEISHU_APP_PATH)      # 必须：窗口可能是关的
p.activate(pid)
app = p.app_element(pid)

p.feishu_conversations(app)                   # 会话列表
p.feishu_messages(app, limit=20)              # 当前会话消息
comp = p.feishu_composer(app)
p.set_text_via_keyboard(app, comp, "文本", pid=pid)   # 焦点没确认会返回 False
p.press_send(pid)                             # Enter
```

`observe(pid, element, notifications, callback)` 返回 observer，调用方自己保活并跑 run loop。
