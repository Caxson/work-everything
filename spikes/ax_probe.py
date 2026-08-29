"""macOS Accessibility (AX) probe for Feishu/Lark.

Spike goal: prove that pyobjc + the Accessibility API can READ chat messages and
WRITE (send) a reply in the desktop clients, without any private API or injection.

Findings that shaped this module (see spikes/README.md for evidence):
  * Feishu/Lark is a CEF (Chromium) app. Its AX tree is fully populated by default;
    the usual Electron `AXManualAccessibility` toggle is *unsupported* and unneeded.
  * Chromium exposes `AXDOMIdentifier` / `AXDOMClassList`, which give us DOM ids and
    CSS classes -- by far the most stable selectors available. Feishu ships semantic,
    non-hashed hook classes (`js-message-item`, `chatMessages`, `a11y_feed_card_item`).
  * Feishu's composer is a contenteditable rich-text editor, so `AXValue` is read-only.
    Text must be injected with synthetic key events (CGEvent) after focusing it.
"""

from __future__ import annotations

import time
from typing import Any, Callable, Iterable, Optional

from AppKit import NSRunningApplication, NSWorkspace
from ApplicationServices import (
    AXIsProcessTrusted,
    AXIsProcessTrustedWithOptions,
    AXObserverAddNotification,
    AXObserverCreate,
    AXObserverGetRunLoopSource,
    AXUIElementCopyAttributeNames,
    AXUIElementCopyAttributeValue,
    AXUIElementCreateApplication,
    AXUIElementSetAttributeValue,
    AXUIElementSetMessagingTimeout,
)
from Quartz import (
    CFRunLoopAddSource,
    CFRunLoopGetCurrent,
    CGEventCreateKeyboardEvent,
    CGEventKeyboardSetUnicodeString,
    CGEventPost,
    kCFRunLoopDefaultMode,
    kCGHIDEventTap,
)

MAX_DEPTH = 60
"""Feishu's real message content sits around depth 30-45 below the window; a shallow
cap silently hides the entire chat (this cost us an hour -- see README pitfall #2)."""


# --------------------------------------------------------------------------- #
# Permissions
# --------------------------------------------------------------------------- #

def check_trust(prompt: bool = False) -> bool:
    """Return whether this process may use the Accessibility API.

    Trust is granted to the *responsible* process (the .app that spawned the
    interpreter), not to the python binary itself, so a bare `python` inherits the
    grant of its terminal / host app.
    """
    if prompt:
        return bool(AXIsProcessTrustedWithOptions({"AXTrustedCheckOptionPrompt": True}))
    return bool(AXIsProcessTrusted())


# --------------------------------------------------------------------------- #
# Thin AX accessors
# --------------------------------------------------------------------------- #

def ax_get(element: Any, attribute: str) -> Any:
    """Read one AX attribute, returning None instead of raising on any AX error."""
    err, value = AXUIElementCopyAttributeValue(element, attribute, None)
    return value if err == 0 else None


def ax_attribute_names(element: Any) -> list[str]:
    """List every AX attribute this element supports (useful for exploration)."""
    err, names = AXUIElementCopyAttributeNames(element, None)
    return list(names) if err == 0 else []


def ax_children(element: Any) -> list[Any]:
    """Direct AX children of an element, or an empty list."""
    return list(ax_get(element, "AXChildren") or [])


def ax_classes(element: Any) -> list[str]:
    """CSS class list of the backing DOM node (Chromium-only; [] elsewhere)."""
    value = ax_get(element, "AXDOMClassList")
    return list(value) if value else []


def ax_dom_id(element: Any) -> Optional[str]:
    """DOM `id` of the backing node. For Feishu messages this is the message id."""
    value = ax_get(element, "AXDOMIdentifier")
    return str(value) if value else None


# --------------------------------------------------------------------------- #
# Application handles
# --------------------------------------------------------------------------- #

def find_pid(bundle_id: str) -> Optional[int]:
    """Resolve a running application's pid from its bundle identifier."""
    for app in NSWorkspace.sharedWorkspace().runningApplications():
        if app.bundleIdentifier() == bundle_id:
            return int(app.processIdentifier())
    return None


def app_element(pid: int, timeout: float = 10.0) -> Any:
    """Build the AXUIElement for an app, with a messaging timeout so we never hang."""
    element = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(element, timeout)
    return element


def activate(pid: int, settle: float = 2.0) -> None:
    """Bring an app to the front and wait for it to settle.

    Required for Feishu: while the main window is closed to the dock the app reports
    zero AXWindows, so every traversal comes back empty.
    """
    running = NSRunningApplication.runningApplicationWithProcessIdentifier_(pid)
    if running is not None:
        running.activateWithOptions_(1 << 1)  # NSApplicationActivateIgnoringOtherApps
    time.sleep(settle)


def enable_embedded_ax(app: Any) -> dict[str, int]:
    """Try the Electron/Chromium 'turn on accessibility' toggles.

    Returns each attribute's AX error code. For Feishu both are rejected
    (-25205 unsupported / -25208 not implemented) and the tree is complete anyway,
    so this is kept only as a probe in case another client ever needs the toggle.
    """
    results = {}
    for attribute in ("AXManualAccessibility", "AXEnhancedUserInterface"):
        results[attribute] = int(AXUIElementSetAttributeValue(app, attribute, True))
    return results


def windows(app: Any) -> list[Any]:
    """Every AXWindow of an app. Feishu opens modals as extra windows, so never
    assume index 0 is the main one."""
    return [w for w in (ax_get(app, "AXWindows") or []) if ax_get(w, "AXRole") == "AXWindow"]


def main_window(app: Any) -> Optional[Any]:
    """The app's main window, preferring one whose title is not a modal widget."""
    candidates = windows(app)
    for window in candidates:
        title = str(ax_get(window, "AXTitle") or "")
        if not title.startswith("ModalWebViewWidget"):
            return window
    return candidates[0] if candidates else None


def ensure_window(pid: int, app_path: str, timeout: float = 12.0) -> bool:
    """Make sure the app actually has an open window, reopening it if needed.

    `NSRunningApplication.activate` only raises an already-open window. Feishu spends
    most of its life closed to the dock with **zero AXWindows**, and it also closes its
    window on Escape -- in that state every traversal silently returns nothing, which
    reads exactly like "AX is broken". Only the reopen Apple Event (`open -a`) brings
    the window back.
    """
    import subprocess
    app = app_element(pid)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if windows(app):
            return True
        subprocess.run(["open", "-a", app_path], check=False)
        time.sleep(1.5)
    return bool(windows(app))


# --------------------------------------------------------------------------- #
# Traversal
# --------------------------------------------------------------------------- #

def walk(root: Any, visit: Callable[[Any, int], bool], depth: int = 0) -> None:
    """Depth-first walk. `visit` returns False to stop descending into that node."""
    if depth > MAX_DEPTH or root is None:
        return
    if visit(root, depth) is False:
        return
    for child in ax_children(root):
        walk(child, visit, depth + 1)


def find_all(root: Any, predicate: Callable[[Any], bool], limit: int = 0) -> list[Any]:
    """Collect every descendant matching `predicate` (pre-order, optionally capped)."""
    found: list[Any] = []

    def visit(element: Any, _depth: int) -> bool:
        if predicate(element):
            found.append(element)
        return not (limit and len(found) >= limit)

    walk(root, visit)
    return found


def find_first(root: Any, predicate: Callable[[Any], bool]) -> Optional[Any]:
    """First descendant matching `predicate`, or None."""
    hits = find_all(root, predicate, limit=1)
    return hits[0] if hits else None


def has_class(*wanted: str) -> Callable[[Any], bool]:
    """Predicate factory: element whose DOM class list contains all of `wanted`."""
    def predicate(element: Any) -> bool:
        classes = ax_classes(element)
        return bool(classes) and all(w in classes for w in wanted)
    return predicate


def collect_text(element: Any, depth: int = 0) -> list[str]:
    """Flatten every AXStaticText / link description under an element, in visual order."""
    out: list[str] = []
    if depth > MAX_DEPTH or element is None:
        return out
    role = ax_get(element, "AXRole")
    if role == "AXStaticText":
        value = ax_get(element, "AXValue")
        if value:
            out.append(str(value))
    for child in ax_children(element):
        out.extend(collect_text(child, depth + 1))
    return out


def dump_tree(root: Any, path: str, max_depth: int = MAX_DEPTH) -> int:
    """Write an indented AX skeleton (role/classes/id/title/value/desc) to `path`."""
    lines: list[str] = []

    def clip(value: Any, width: int = 90) -> str:
        text = str(value).replace("\n", "\\n")
        return text[:width] + ("…" if len(text) > width else "")

    def visit(element: Any, depth: int) -> bool:
        parts = [f"{'  ' * depth}[{depth}] {ax_get(element, 'AXRole')}"]
        for attribute, label in (("AXSubrole", "sub"), ("AXTitle", "title"),
                                 ("AXValue", "val"), ("AXDescription", "desc")):
            value = ax_get(element, attribute)
            if value is not None and str(value) != "":
                parts.append(f"{label}={clip(value)!r}")
        dom_id = ax_dom_id(element)
        if dom_id:
            parts.append(f"#{dom_id}")
        classes = ax_classes(element)
        if classes:
            parts.append("cls=" + ".".join(classes))
        lines.append(" ".join(parts))
        return depth < max_depth

    walk(root, visit)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines))
    return len(lines)


# --------------------------------------------------------------------------- #
# Feishu / Lark selectors
#
# Stability note: Feishu's build ships two kinds of CSS classes -- hashed ones
# (`_13e3ffd`, `c90c31ea`) that change every release, and semantic hook classes
# that do not. Only ever select on the semantic ones listed here.
# --------------------------------------------------------------------------- #

FEISHU_BUNDLE_ID = "com.bytedance.macos.feishu"
FEISHU_APP_PATH = "/Applications/Lark.app"


def feishu_web_area(app: Any, title: str) -> Optional[Any]:
    """Find one of Feishu's CEF web areas by title ('messenger', 'messenger-chat').

    Feishu renders each module in its own <webview>; the conversation list lives in
    'messenger' and the open conversation in 'messenger-chat'.
    """
    for window in windows(app):
        hit = find_first(
            window,
            lambda el: ax_get(el, "AXRole") == "AXWebArea" and ax_get(el, "AXTitle") == title,
        )
        if hit is not None:
            return hit
    return None


def feishu_conversations(app: Any) -> list[dict[str, Any]]:
    """Read the conversation list: name, tag, date and last-message preview.

    Selector: `.a11y_feed_card_item` inside `.a11y_feed_main_list` -- both are
    accessibility hook classes Feishu ships deliberately, so they survive releases.
    """
    messenger = feishu_web_area(app, "messenger")
    if messenger is None:
        return []
    conversations = []
    for card in find_all(messenger, has_class("a11y_feed_card_item")):
        texts = collect_text(card)
        conversations.append({
            "name": texts[0] if texts else None,
            "texts": texts,
            "element": card,
        })
    return conversations


def feishu_chat_title(app: Any) -> Optional[str]:
    """Title of the conversation currently open, from `.chatWindow_chatName`."""
    chat = feishu_web_area(app, "messenger-chat")
    if chat is None:
        return None
    header = find_first(chat, has_class("chatWindow_chatName"))
    if header is None:
        return None
    texts = collect_text(header)
    return texts[0] if texts else None


def feishu_messages(app: Any, limit: int = 20) -> list[dict[str, Any]]:
    """Read the visible messages of the open conversation, newest last.

    Selector: `.js-message-item` -- a JS hook class, never used for styling. Each one
    carries the real Feishu message id in `AXDOMIdentifier`, and its class list encodes
    direction (`message-self` / `message-not-self`), chat kind (`message-is-p2p`),
    read state (`message-me-read`) and payload kind (`text-message`, `card-message`).
    """
    chat = feishu_web_area(app, "messenger-chat")
    if chat is None:
        return []
    items = find_all(chat, has_class("js-message-item"))
    messages = []
    for item in items[-limit:] if limit else items:
        classes = ax_classes(item)
        body = find_first(item, has_class("message-content-container")) or item
        messages.append({
            "id": ax_dom_id(item),
            "from_me": "message-self" in classes,
            "kind": next((c for c in classes if c.endswith("-message")), None),
            "text": "".join(collect_text(body)).strip(),
        })
    return messages


def feishu_composer(app: Any) -> Optional[Any]:
    """The message input box: the AXTextArea of Feishu's `editor-kit` container.

    This is a contenteditable, *not* a text field -- see `set_text_via_keyboard`.
    """
    chat = feishu_web_area(app, "messenger-chat")
    if chat is None:
        return None
    return find_first(
        chat,
        lambda el: ax_get(el, "AXRole") == "AXTextArea" and "editor-kit-container" in ax_classes(el),
    )


# --------------------------------------------------------------------------- #
# Input
# --------------------------------------------------------------------------- #

KEY_RETURN = 36
KEY_DELETE = 51
KEY_A = 0


def element_center(element: Any) -> Optional[tuple[float, float]]:
    """Screen coordinates of an element's centre, decoded from AXPosition/AXSize."""
    from ApplicationServices import AXValueGetValue, kAXValueCGPointType, kAXValueCGSizeType
    pos, size = ax_get(element, "AXPosition"), ax_get(element, "AXSize")
    if pos is None or size is None:
        return None
    ok_p, point = AXValueGetValue(pos, kAXValueCGPointType, None)
    ok_s, extent = AXValueGetValue(size, kAXValueCGSizeType, None)
    if not (ok_p and ok_s):
        return None
    return (point.x + extent.width / 2, point.y + extent.height / 2)


def click(element: Any, pid: Optional[int] = None) -> bool:
    """Left-click an element's centre with a synthetic mouse event.

    Needed because setting `AXFocused` on Feishu's contenteditable composer is
    rejected; a real click is what actually moves the caret into it.

    Note the asymmetry with `send_key`: mouse events must go to the **global HID tap**
    so the window server can route them by screen coordinate, while keyboard events
    must go to **CGEventPostToPid**. Sending the mouse click to the pid instead makes
    it land nowhere and focus silently fails. `pid` is accepted only for symmetry.
    """
    from Quartz import (CGEventCreateMouseEvent, CGPoint, kCGEventLeftMouseDown,
                        kCGEventLeftMouseUp, kCGEventMouseMoved, kCGMouseButtonLeft)
    center = element_center(element)
    if center is None:
        return False
    spot = CGPoint(center[0], center[1])
    for event_type in (kCGEventMouseMoved, kCGEventLeftMouseDown, kCGEventLeftMouseUp):
        CGEventPost(kCGHIDEventTap,
                    CGEventCreateMouseEvent(_source(), event_type, spot, kCGMouseButtonLeft))
        time.sleep(0.06)
    return True


def focus(element: Any, pid: Optional[int] = None) -> bool:
    """Focus an element: try AX first, fall back to a real click (CEF needs the click)."""
    if AXUIElementSetAttributeValue(element, "AXFocused", True) == 0:
        return True
    return click(element, pid)


def focus_composer(app: Any, composer: Any, pid: int, attempts: int = 3) -> bool:
    """Click into the composer until the app confirms it holds focus.

    Typing without this confirmation is destructive: with focus anywhere else, Feishu
    treats the characters as global shortcuts and navigates away from the chat.
    """
    for _ in range(attempts):
        click(composer, pid)
        time.sleep(0.6)
        if is_focused(app, composer):
            return True
    return False


def _post(pid: Optional[int], event: Any) -> None:
    """Deliver a synthetic event, preferring the targeted per-process queue.

    THE key pitfall of this spike: keyboard events sent to the global HID tap are
    accepted by Feishu's *native* layer (they fire menu shortcuts and navigate the
    app) but never reach the CEF render widget, so nothing is typed. Addressing the
    process directly with CGEventPostToPid delivers them to the web view. Mouse
    events work either way, which makes the failure look like a focus problem.
    """
    from Quartz import CGEventPostToPid
    if pid is not None:
        CGEventPostToPid(pid, event)
    else:
        CGEventPost(kCGHIDEventTap, event)


def _source() -> Any:
    """A *private* event source for synthetic input.

    Must not be `kCGEventSourceStateHIDSystemState`: that source inherits the live
    modifier state, and because `CGEventSetFlags` fakes a Cmd chord without ever
    sending a real Command key-up, the Command flag stays latched and poisons every
    later keystroke. That is how typing "work-everything" turned its `w` into Cmd+W
    and closed Feishu's window mid-run. A private source starts with clean flags.
    """
    from Quartz import CGEventSourceCreate, kCGEventSourceStatePrivate
    return CGEventSourceCreate(kCGEventSourceStatePrivate)


def send_key(keycode: int, flags: int = 0, pid: Optional[int] = None) -> None:
    """Post a synthetic key down/up pair, addressed to `pid` when given."""
    from Quartz import CGEventSetFlags
    source = _source()
    for is_down in (True, False):
        event = CGEventCreateKeyboardEvent(source, keycode, is_down)
        CGEventSetFlags(event, flags)  # always explicit, including back to 0
        _post(pid, event)
        time.sleep(0.01)


def type_unicode(text: str, pid: Optional[int] = None) -> None:
    """Type arbitrary text (CJK included) by attaching a unicode string to key events.

    Chromium's contenteditable honours this, which is why it works where setting
    `AXValue` on the composer does not (the composer is a rich-text editor, so its
    AXValue is read-only and only ever reports the placeholder).
    """
    from Quartz import CGEventSetFlags
    source = _source()
    for char in text:
        for is_down in (True, False):
            event = CGEventCreateKeyboardEvent(source, 0, is_down)
            CGEventSetFlags(event, 0)  # never inherit a latched modifier
            CGEventKeyboardSetUnicodeString(event, len(char), char)
            _post(pid, event)
        time.sleep(0.015)


def is_focused(app: Any, element: Any) -> bool:
    """Whether `element` currently holds the app's keyboard focus.

    Compared by DOM class list because AXUIElement identity is not stable across
    separate `AXUIElementCopyAttributeValue` calls in Chromium.
    """
    focused = ax_get(app, "AXFocusedUIElement")
    if focused is None:
        return False
    return ax_classes(focused) == ax_classes(element) and ax_classes(element) != []


def set_text_via_keyboard(app: Any, composer: Any, text: str,
                          pid: Optional[int] = None, clear: bool = True) -> bool:
    """Focus the composer and type `text` into it. Never sends.

    Refuses to emit any keystroke until focus is confirmed to be inside the composer,
    so a failed focus can't leak Cmd+A / Delete / free text into the rest of the app
    as accidental keyboard shortcuts.
    """
    if not focus_composer(app, composer, pid):
        return False
    if clear:
        from Quartz import kCGEventFlagMaskCommand
        send_key(KEY_A, kCGEventFlagMaskCommand, pid)
        send_key(KEY_DELETE, pid=pid)
        time.sleep(0.2)
    type_unicode(text, pid)
    time.sleep(0.5)
    return True


def press_send(pid: Optional[int] = None) -> None:
    """Send the composed message. Feishu has no send *button*: Enter is the send key
    (the composer advertises this via the `editor__tip--enter` node)."""
    send_key(KEY_RETURN, pid=pid)


# --------------------------------------------------------------------------- #
# Event-driven observation
# --------------------------------------------------------------------------- #

def observe(pid: int, element: Any, notifications: Iterable[str],
            callback: Callable[[str, Any], None]) -> Any:
    """Subscribe to AX notifications on `element` and attach them to the run loop.

    Caller must then run the run loop (e.g. `CFRunLoopRunInMode`) to receive events.
    Returns the observer, which must be kept alive by the caller.
    """
    import objc

    @objc.callbackFor(AXObserverCreate)
    def trampoline(observer, sender, notification, refcon):
        callback(str(notification), sender)

    err, observer = AXObserverCreate(pid, trampoline, None)
    observe._keepalive = getattr(observe, "_keepalive", [])
    observe._keepalive.append(trampoline)
    if err != 0:
        raise RuntimeError(f"AXObserverCreate failed: {err}")
    for notification in notifications:
        AXObserverAddNotification(observer, element, notification, None)
    CFRunLoopAddSource(CFRunLoopGetCurrent(),
                       AXObserverGetRunLoopSource(observer),
                       kCFRunLoopDefaultMode)
    return observer
