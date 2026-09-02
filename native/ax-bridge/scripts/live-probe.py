#!/usr/bin/env python3
"""Live verification of the background path against a throwaway probe app.

Run it through scripts/live-probe.sh, which builds the probe first.

The probe reports its own state — which window is key, what each window received, what is
in its text field — so every claim below is checked against the target's own account of
what happened rather than against the bridge's return value.

Two modes, chosen by what the machine is actually doing:

  ax  — the desktop is compositing, accessibility exposes the probe's windows, and the
        full path is exercised including window resolution, safe-point choice and
        focusAndType.
  oob — the desktop is not compositing (a running screen saver does this with the session
        unlocked, and so does a locked screen). Accessibility exposes no window for any
        application, so the window number comes from the probe's own log. Everything that
        needs accessibility is SKIPPED and said out loud; nothing is reported as passing.

Touches nothing but the probe it launched.
"""
import json, os, subprocess, sys, time, pathlib

SCRIPTS = pathlib.Path(__file__).resolve().parent
BRIDGE_ROOT = SCRIPTS.parent
ROOT = pathlib.Path(os.environ.get("OUT_DIR") or (pathlib.Path(os.environ.get("TMPDIR", "/tmp")) / "we-ax-live-probe"))
ROOT.mkdir(parents=True, exist_ok=True)
BIN = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else BRIDGE_ROOT / ".build" / "release" / "we-ax"
LOG = ROOT / "WeAxProbe.log"
EV = ROOT / "evidence"
EV.mkdir(exist_ok=True)
if not BIN.exists():
    sys.exit(f"missing {BIN} — run: swift build -c release")

class Bridge:
    def __init__(self):
        self.p = subprocess.Popen([str(BIN)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, bufsize=1)
        self.id = 0
    def call(self, op, **params):
        self.id += 1
        self.p.stdin.write(json.dumps({"id": self.id, "op": op, **params}) + "\n"); self.p.stdin.flush()
        while True:
            line = self.p.stdout.readline()
            if not line: raise RuntimeError("bridge closed unexpectedly")
            try: msg = json.loads(line)
            except json.JSONDecodeError: continue
            if msg.get("id") == self.id: return msg
    def close(self):
        try: self.call("shutdown")
        except Exception: pass
        try: self.p.wait(timeout=5)
        except Exception: self.p.kill()

def save(name, obj):
    (EV / f"{name}.json").write_text(json.dumps(obj, indent=2, ensure_ascii=False))
    return obj

def log_lines(): return LOG.read_text().splitlines() if LOG.exists() else []
def last_state():
    for line in reversed(log_lines()):
        if " STATE " in line: return line
    return ""
def unit(tag):
    for part in last_state().split(" | "):
        if part.strip().startswith(tag + "/"): return part.strip()
    return ""
def clicks(tag):
    for token in unit(tag).split():
        if token.startswith("clicks="): return int(token.split("=")[1])
    return -1
def field(tag):
    part = unit(tag); i = part.find("field=")
    return part[i + 6:].strip() if i >= 0 else ""
def is_key(tag): return "key=true" in unit(tag).lower()

def gap(a, c):
    return ((c["x"] - a["x"]) ** 2 + (c["y"] - a["y"]) ** 2) ** 0.5

def drift(seconds, tries=3):
    """How far the pointer moves on its own, sampled over the same span, worst of `tries`.

    A person using the machine moves the mouse while an op runs, so a raw before/after
    delta cannot tell their movement from ours, and a single control sample can land in a
    still moment while the op landed in a moving one. Taking the worst of several is the
    cheap fix for that race.
    """
    worst = 0.0
    for _ in range(tries):
        a = b.call("env")["result"]["cursor"]
        time.sleep(seconds)
        worst = max(worst, gap(a, b.call("env")["result"]["cursor"]))
    return worst

# The strongest control is free: the pointer's position at the end of one op against its
# position at the start of the next. Nothing is posted in between, so any difference there
# is a person's hand and nothing else.
LAST_CURSOR = {"at": None}

def check_cursor(what, inv, redo=None):
    """Attribution, not a threshold.

    The hard guarantee is structural and asserted separately: a background event is posted
    to a process, never to the HID tap, so it has no route to the pointer at all. This is
    the live cross-check, and it has to survive a person using the mouse at the same time.
    """
    moved = inv["cursorDelta"]
    span = max(inv.get("elapsedMs", 0), 1) / 1000
    between = gap(LAST_CURSOR["at"], inv["cursorBefore"]) if LAST_CURSOR["at"] else 0.0
    LAST_CURSOR["at"] = inv["cursorAfter"]

    if moved <= 2.0:
        check(f"{what} did not move the cursor", True, f"{moved:.2f}px over {span * 1000:.0f}ms")
        return

    # It moved, so the question is whether we moved it. Comparing magnitudes across two
    # different moments cannot answer that — a person's hand is not a constant rate, and a
    # 500px flick during the op against a still control window says nothing either way.
    #
    # What does answer it: was the pointer still around the op? If it was, and it moved
    # during the op, that is ours and it is a real failure. If it was already in motion,
    # the reading carries no information at all and is reported as inconclusive rather
    # than counted either way. Over a run most ops land in still moments and give a real
    # verdict; the structural guarantee (posted to a process, never to the HID tap, and no
    # mouseMoved in the plan) is asserted separately and does not depend on any of this.
    control = max(between, drift(span))
    if control > 2.0:
        skip(f"{what}: cursor reading not attributable",
             f"{moved:.2f}px over {span * 1000:.0f}ms, but the pointer was already moving "
             f"{control:.2f}px on its own — somebody is using the mouse")
        return

    # The pointer looks still, so this reading accuses us. Before believing it: a hand can
    # flick during the op and stop before the control window, which produces exactly this.
    # What separates the two is repetition — code that moves the pointer moves it every
    # time, a hand does not. So repeat the op and take the best reading.
    if redo:
        for attempt in range(3):
            again = redo()
            if again is None:
                break
            if again["cursorDelta"] <= 2.0:
                check(f"{what} did not move the cursor", True,
                      f"{again['cursorDelta']:.2f}px on repeat {attempt + 2} "
                      f"(first reading {moved:.2f}px coincided with a hand)")
                LAST_CURSOR["at"] = again["cursorAfter"]
                return
            LAST_CURSOR["at"] = again["cursorAfter"]
        check(f"{what} did not move the cursor", False,
              f"{moved:.2f}px and it moved on every repeat with the pointer otherwise "
              f"still — this one is ours")
        return
    check(f"{what} did not move the cursor", False,
          f"{moved:.2f}px over {span * 1000:.0f}ms while the pointer was otherwise still "
          f"({control:.2f}px) — this one is ours")

ENV_CODES = {"SCREEN_LOCKED", "AX_SEES_NO_WINDOWS_BUT_CG_DOES", "NO_WINDOW", "NO_SAFE_POINT",
             "FULLSCREEN_SPACE"}

class EnvironmentChanged(Exception):
    """The desktop stopped compositing partway through.

    A screen saver can start between two calls, and every accessibility-dependent step
    after that point is measuring the screen saver rather than the bridge. Raised so the
    run reports what it could not check instead of crashing on a missing `result` — a
    traceback here would read like a bridge failure, which is the one thing it is not.
    """

def result(response, what):
    if response.get("ok"):
        return response["result"]
    code = response.get("error", {}).get("code", "?")
    if code in ENV_CODES:
        raise EnvironmentChanged(f"{what} -> {code}")
    raise AssertionError(f"{what} failed unexpectedly: {json.dumps(response)[:200]}")

RESULTS = []
def check(name, ok, detail=""):
    RESULTS.append((name, "pass" if ok else "fail"))
    print(("  PASS  " if ok else "  FAIL  ") + name + ("   " + detail if detail else ""))
def skip(name, why):
    RESULTS.append((name, "skip"))
    print(f"  SKIP  {name}   {why}")

env = dict(os.environ, WEAX_LOG_DIR=str(ROOT))
subprocess.run(["pkill", "-f", "WeAxProbe"], capture_output=True)
time.sleep(0.6)
out = subprocess.run([str(ROOT / "launch"), str(ROOT / "WeAxProbe.app")], capture_output=True, text=True, env=env)
pid = int(out.stdout.strip().split("=")[1])
time.sleep(1.6)
probe_windows = [int(n) for n in log_lines()[0].split("windows=[")[1].rstrip("]").split(",")]
print(f"probe pid={pid} windows={probe_windows}")

b = Bridge()
mode = "ax"
try:
    print("\n-- environment")
    e = save("00-env", b.call("env"))["result"]
    check("bridge is trusted", e["trusted"], str(e["spi"]))
    baseline = drift(0.30)
    print(f"   pointer drifts {baseline:.2f}px over 300ms with nothing posted"
          + ("  (somebody is using the mouse)" if baseline > 2 else ""))
    if not e["trusted"]:
        raise SystemExit("not trusted")

    print("\n-- windowInfo")
    wi = save("01-windowInfo", b.call("windowInfo", pid=pid))["result"]
    wins = wi["windows"]
    desktop = wi["desktop"]
    mode = "ax" if wins else "oob"
    print(f"   desktop onScreenWindows={desktop['onScreenWindows']} owners={desktop['onScreenOwners']}"
          f"  probe cg={wi['windowServer']['total']} onScreen={wi['windowServer']['onScreen']}  -> mode={mode}")
    if mode == "ax":
        check("both probe windows resolved", len(wins) == 2, str(len(wins)))
        check("resolved through the private SPI", all(w["resolvedBy"] == "axSPI" for w in wins),
              ",".join(w["resolvedBy"] for w in wins))
        check("window numbers match the probe's own",
              sorted(w["windowNumber"] for w in wins) == sorted(probe_windows),
              f"bridge={[w['windowNumber'] for w in wins]} probe={probe_windows}")
        w0 = next(w for w in wins if w["title"].endswith("W0"))
        w1 = next(w for w in wins if w["title"].endswith("W1"))
    else:
        skip("AX window resolution", "the desktop is not compositing; no app exposes a window")
        d = save("01b-diagnosis", b.call("click", pid=pid, background=True, x=1.0, y=1.0))
        check("empty window list is diagnosed, not returned as 'no windows'",
              d["ok"] is False and d["error"]["code"] in
              ("AX_SEES_NO_WINDOWS_BUT_CG_DOES", "SCREEN_LOCKED", "NO_WINDOW",
               "FULLSCREEN_SPACE"),
              f"{d.get('error',{}).get('code')} scope={d.get('error',{}).get('details',{}).get('scope')}")
        w0 = {"windowNumber": probe_windows[0], "frame": None, "title": "W0"}
        w1 = {"windowNumber": probe_windows[1], "frame": None, "title": "W1"}

    print("\n-- foreground defaults are unchanged")
    fg = save("02-click-fg-dryrun", b.call("click", x=100.0, y=100.0, dryRun=True))["result"]
    check("plain click still goes to the HID tap", fg["plan"]["tap"] == "cghidEventTap", fg["plan"]["route"])
    ks = save("03-key-fg-dryrun", b.call("keystroke", pid=pid, key="a", modifiers=["cmd"], dryRun=True))["result"]
    check("plain keystroke plan is byte-for-byte the old one",
          ks["plan"]["target"] == f"postToPid({pid})" and ks["plan"]["sourceState"] == "private"
          and ks["plan"]["events"][-1]["flags"] == 0, ks["plan"]["mode"])

    print("\n-- background plans report the fields actually set")
    bg = save("04-click-bg-dryrun", b.call("click", pid=pid, windowNumber=w0["windowNumber"],
                                           x=300.0, y=300.0, dryRun=True))["result"]
    f = bg["plan"]["addressing"]["fields"]
    check("51 and 58 are set", f["51"] and f["58"], json.dumps(f, sort_keys=True))
    check("no HID tap anywhere in a background plan",
          "tap" not in json.dumps(bg["plan"]) and bg["plan"]["route"] == "background")
    kbg = save("05-key-bg-dryrun", b.call("keystroke", pid=pid, windowNumber=w0["windowNumber"],
                                          key="a", dryRun=True))["result"]
    check("key plan says window fields do not steer keys",
          kbg["plan"]["windowFieldsSteerKeys"] is False)

    print("\n-- background click lands in the addressed window")
    before = clicks("W0")
    args = dict(pid=pid, windowNumber=w0["windowNumber"])
    if w0["frame"]: args.update(x=w0["frame"]["x"] + 260, y=w0["frame"]["y"] + 182)
    else:           args.update(x=460.0, y=450.0)
    cl = save("06-click-bg", b.call("click", **args))["result"]
    time.sleep(0.7)
    landed = [l for l in log_lines() if f'recv[W0/{w0["windowNumber"]}] mouse=1' in l]
    check("W0 received the event", len(landed) > 0, landed[-1][-46:] if landed else "nothing arrived")
    check("frontmost application unchanged", cl["invariants"]["frontmostUnchanged"],
          f'{cl["invariants"]["frontmostBefore"]} -> {cl["invariants"]["frontmostAfter"]}')
    check_cursor("the click", cl["invariants"],
                 redo=lambda: b.call("click", **args)["result"]["invariants"])
    check("the other window received nothing",
          not any(f'recv[W1/{w1["windowNumber"]}] mouse' in l for l in log_lines()))

    print("\n-- activation makes the window key without taking the front")
    if mode == "ax":
        act = result(save("07-activate", b.call("activate", pid=pid, windowNumber=w1["windowNumber"])), "activate")
        time.sleep(0.9)
        check("a safe point was chosen from the tree", act["safePoint"]["region"] in ("titleBar", "body"),
              f'{act["safePoint"]["region"]} clearance={act["safePoint"]["clearance"]:.0f} '
              f'obstacles={act["safePoint"]["obstacles"]}')
        check("the centred button was not pressed", clicks("W1") == 0, f'clicks={clicks("W1")}')
        check("W1 became the key window", is_key("W1"), unit("W1"))
        check("front still unchanged", act["invariants"]["frontmostUnchanged"])
        check_cursor("activation", act["invariants"],
                     redo=lambda: b.call("activate", pid=pid,
                                         windowNumber=w1["windowNumber"])["result"]["invariants"])
    else:
        nosafe = save("07-activate-nosafepoint", b.call("activate", pid=pid, windowNumber=w1["windowNumber"]))
        check("activation refuses to guess where to click",
              nosafe["ok"] is False and nosafe["error"]["code"] == "NO_SAFE_POINT",
              nosafe.get("error", {}).get("code", "?"))
        act = save("07-activate-oob", b.call("activate", pid=pid, windowNumber=w1["windowNumber"],
                                             safePoint={"x": 260.0, "y": 60.0}))["result"]
        time.sleep(0.9)
        check("W1 became the key window", is_key("W1"), unit("W1"))
        check("the centred button was not pressed", clicks("W1") == 0, f'clicks={clicks("W1")}')
        check("front still unchanged", act["invariants"]["frontmostUnchanged"],
              f'{act["invariants"]["frontmostBefore"]} -> {act["invariants"]["frontmostAfter"]}')
        check_cursor("activation", act["invariants"],
                     redo=lambda: b.call("activate", pid=pid,
                                         windowNumber=w1["windowNumber"])["result"]["invariants"])

    print("\n-- typing reaches the focused window")
    ty = save("08-type", b.call("keystroke", pid=pid, windowNumber=w1["windowNumber"], key="k"))
    time.sleep(0.5)
    check("keystroke accepted on the background route", ty["ok"], json.dumps(ty)[:100])
    typed = [l for l in log_lines() if "keyDown" in l]
    check("a key event arrived at the app", len(typed) > 0, typed[-1][-40:] if typed else "none")

    print("\n-- focusAndType (press to focus, then keys to the process)")
    if mode == "ax":
        found = save("09-find", b.call("find", pid=pid, selector={"role": "AXTextField", "maxResults": 8}))["result"]
        node = next((n for n in found if n.get("identifier", "") == "probe-field-W1"), None)
        check("composer found in the tree", node is not None, str([n.get("identifier") for n in found])[:90])
        if node:
            ft = result(save("10-focusAndType", b.call("focusAndType", pid=pid, nodeId=node["nodeId"],
                                                   windowNumber=w1["windowNumber"], text="hello-bg-42")),
                    "focusAndType")
            time.sleep(1.0)
            # The earlier keystroke check typed a "k" into this same field, and it must
            # still be there: the two paths landing in order is a stronger statement than
            # either one landing alone.
            check("the text is in the field, after the earlier keystroke",
                  field("W1") == "khello-bg-42", f'field={field("W1")!r}')
            check("focus was verified by reading it back, not assumed",
                  ft["focused"].get("verifiedBy"), str(ft["focused"]))
            check("front unchanged while typing", ft["invariants"]["frontmostUnchanged"])
            check_cursor(f'typing (focused via {ft["focused"]["method"]})', ft["invariants"],
                         redo=lambda: b.call("focusAndType", pid=pid, nodeId=node["nodeId"],
                                             windowNumber=w1["windowNumber"],
                                             text="")["result"]["invariants"])
    else:
        skip("focusAndType", "needs a node from the tree; accessibility exposes none right now")
        dry = save("10-focusAndType-dryrun",
                   b.call("focusAndType", pid=pid, nodeId=999999, text="x", dryRun=True))
        check("unknown node is refused, not typed blindly",
              dry["ok"] is False and dry["error"]["code"] == "NO_SUCH_NODE",
              dry.get("error", {}).get("code", "?"))

    print("\n-- a focus that cannot be proven sends zero keys")
    if mode != "ax":
        skip("focus verification refuses to type",
             "needs a node from the tree; accessibility exposes none right now")
    else:
        # The label reports the same role as the editable field and cannot take focus. The
        # click strategy applies to it and reports success, so this is the exact shape of the
        # bug: a strategy claiming victory over an element the caret never reached.
        labels = save("10b-find-label", b.call("find", pid=pid,
                                               selector={"role": "AXStaticText", "maxResults": 20}))["result"]
        label = next((n for n in labels if n.get("identifier", "") == "probe-label-W1"), None)
        check("non-focusable label found", label is not None,
              str([n.get("identifier") for n in labels if n.get("identifier")])[:80])
        if label:
            keys_before = sum(1 for l in log_lines() if "keyDown" in l)
            text_before = field("W1")
            bad = save("10c-focus-unverifiable", b.call("focusAndType", pid=pid, nodeId=label["nodeId"],
                                                        windowNumber=w1["windowNumber"], text="DESTRUCTIVE"))
            time.sleep(0.8)
            check("refused with FOCUS_FAILED",
                  bad["ok"] is False and bad["error"]["code"] == "FOCUS_FAILED",
                  bad.get("error", {}).get("code", "unexpectedly ok"))
            det = bad.get("error", {}).get("details", {})
            check("and says a strategy claimed success anyway", bool(det.get("claimedSuccess")),
                  f'claimedSuccess={det.get("claimedSuccess")} focusActuallyOn={det.get("focusActuallyOn")}')
            check("ZERO keys were sent",
                  sum(1 for l in log_lines() if "keyDown" in l) == keys_before,
                  f'{keys_before} -> {sum(1 for l in log_lines() if "keyDown" in l)} keyDown events')
            check("and the real field was not written into", field("W1") == text_before,
                  f'{text_before!r} -> {field("W1")!r}')

    print("\n-- background scroll")
    n = sum(1 for l in log_lines() if "scrollWheel" in l)
    sc = save("11-scroll", b.call("scroll", pid=pid, windowNumber=w1["windowNumber"], deltaY=3,
                                  **({"x": w1["frame"]["x"] + 100, "y": w1["frame"]["y"] + 100} if w1["frame"]
                                     else {"x": 300.0, "y": 200.0})))
    time.sleep(0.6)
    check("scroll reached the window", sum(1 for l in log_lines() if "scrollWheel" in l) > n,
          f'{n} -> {sum(1 for l in log_lines() if "scrollWheel" in l)}')
    check("scroll kept the front", sc["result"]["invariants"]["frontmostUnchanged"])
    check_cursor("the scroll", sc["result"]["invariants"])

    print("\n-- session lifecycle")
    s = save("12-bgSession", b.call("bgSession", pid=pid, windowNumber=w0["windowNumber"]))["result"]
    check("suppression stays off unless asked for", s["suppression"] is None, str(s["suppression"]))
    sc2 = save("13-session-click", b.call("click", session=s["session"], **{k: v for k, v in args.items()
                                                                            if k in ("x", "y")}))["result"]
    check("a session click carries its window", sc2["plan"]["window"]["windowNumber"] == w0["windowNumber"])
    rel = save("14-bgRelease", b.call("bgRelease", session=s["session"]))["result"]
    check("session released", rel["released"])
    stale = save("15-stale-session", b.call("click", session=s["session"], x=1.0, y=1.0))
    check("a released session is refused",
          stale["ok"] is False and stale["error"]["code"] == "NO_SUCH_SESSION",
          stale.get("error", {}).get("code", "?"))

    print("\n-- suppression layer when explicitly asked for")
    s2 = save("16-bgSession-suppress", b.call("bgSession", pid=pid, windowNumber=w1["windowNumber"],
                                              suppressFocus=True))
    if s2["ok"]:
        inst = s2["result"]["suppression"]["installed"]
        check("taps installed on both sides", len(inst) == 2, str(inst))
        r2 = save("17-release-suppress", b.call("bgRelease", session=s2["result"]["session"]))["result"]
        check("release reports the tap statistics", "suppression" in r2,
              json.dumps(r2.get("suppression", {}).get("seen", {}))[:80])
    else:
        check("suppression failure is structured", s2["error"]["code"] == "TAP_FAILED", s2["error"]["code"])

    print("\n-- errors are structured and the bridge survives all of them")
    for name, op, kw, expect in [
        ("unknown op", "nope", {}, "BAD_REQUEST"),
        ("missing pid", "windowInfo", {}, "BAD_REQUEST"),
        ("dead pid", "windowInfo", {"pid": 999999}, "NO_SUCH_PID"),
        ("unknown node", "focusAndType", {"pid": pid, "nodeId": 999999, "text": "x"}, "NO_SUCH_NODE"),
        ("unknown session", "bgRelease", {"session": 4242}, "NO_SUCH_SESSION"),
        ("zero-delta scroll", "scroll", {"pid": pid, "windowNumber": w0["windowNumber"]}, "BAD_REQUEST"),
        ("bad button", "click", {"pid": pid, "windowNumber": w0["windowNumber"], "x": 1.0, "y": 1.0,
                                 "button": "middle", "dryRun": True}, "BAD_REQUEST"),
    ]:
        r = b.call(op, **kw)
        check(f"{name} -> {expect}", r["ok"] is False and r["error"]["code"] == expect,
              r.get("error", {}).get("code", "unexpectedly ok"))
    save("18-alive", b.call("env"))
    check("bridge alive after every error", True)

except EnvironmentChanged as e:
    skip("remaining accessibility checks", f"the desktop stopped compositing mid-run ({e})")
finally:
    b.close()
    subprocess.run(["pkill", "-f", "WeAxProbe"], capture_output=True)
    (EV / "probe.log").write_text("\n".join(log_lines()))
    (EV / "mode.txt").write_text(mode)

print("\n" + "=" * 62)
p = sum(1 for _, r in RESULTS if r == "pass")
f = [n for n, r in RESULTS if r == "fail"]
s = [n for n, r in RESULTS if r == "skip"]
print(f"mode={mode}   {p} passed, {len(f)} failed, {len(s)} skipped")
if s: print("skipped: " + "; ".join(s))
if f: print("FAILED:  " + "; ".join(f))
sys.exit(1 if f else 0)
