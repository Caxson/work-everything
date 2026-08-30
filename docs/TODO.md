# TODO

Everything known to be missing or provisional in this skeleton lives here.

## Perception

- Feishu is implemented; Claude Code is still an interface without one.
- The Feishu reader only sees what is rendered. The message list is virtualized,
  so a burst that arrives while the daemon is busy can scroll out of the tree
  before the next sweep; nothing scrolls back to recover it.
- Group chats are untested. A group message's sender is left empty rather than
  guessed, because the layout that exposes it was never observed.
- Only text is read. A file, image or card message arrives as its rendered
  label, and there is no way to reply with anything but text.
- Perception stops dead when Feishu is closed to the tray or the screen is
  locked: with no window the app exposes no accessibility tree. The daemon
  reports this instead of failing quietly, but it cannot work around it.
- `AxPerceiver` watches by bundle id at startup. It does not notice an app
  launching, quitting, or changing pid afterwards.
- Every AX notification becomes one event. There is no debounce, so a chatty
  app can flood the router.

## Routing

- The prefilter is lexical only. `Retriever` is the seam for an embedding
  ranker; nothing implements it yet, so a request that shares no surface
  tokens with a scenario will not reach it.
- `muscleThreshold` was picked by hand. It should be calibrated against
  recorded trajectories once there are enough of them.
- The router cannot fill template variables, so any chain with an open slot
  is demoted to the fast tier and costs a model call. Recovering slot values
  by aligning an event against a stored anchor would make more promoted
  scenarios genuinely free; it is not implemented.

## Planning and promotion

- Generated plans are linear. The engine executes parallel groups and
  conditional steps, but the planner never emits them.
- Candidate matching compares against every stored anchor. That is fine at
  hundreds of candidates and should be indexed before it is thousands.
- Nothing prunes candidates. They accumulate until promoted or deleted by
  hand; there is no eviction policy and no `we forget`.

## Trust

- Confirmation is a callback with no interface behind it. There is no way for
  a person to actually answer one — `we status` shows what is pending and
  nothing consumes the answer. The Feishu write-back gate sidesteps this by
  printing and recording an unapproved reply rather than asking for one.
- Quarantine is permanent until `reinstate`, which no command calls yet.

## Execution and hosts

- The only executor is `shell`. Tools must be declared in config with a fixed
  argv; there is no HTTP executor and no MCP client.
- `ClaudeCodeHost` sends a bare prompt. It passes no context from the
  trajectory, and it starts a fresh session every time.

## Operations

- `we run --source feishu` starts the daemon in the foreground. There is no
  service definition, no restart policy, and no log rotation.
- The database is never compacted or pruned.
- `we replay` re-derives the routing decision only. It does not re-execute a
  chain against recorded tool results.

## A locked screen removes window addressing

Measured on macOS 26.3: while the Mac is locked, `AXPosition`, `AXSize` and
`_AXUIElementGetWindow` fail for every application. The event channel itself
survives, and `CGWindowList` still answers, so a window can be reached if its
number is already known — but nothing can find that number through the
accessibility API.

This sits directly under the premise of the project. A computer left to work
on its own is a locked computer, and that is precisely when addressing stops
working. Unresolved. Directions worth measuring, none of them verified:

- address windows through `CGWindowList` instead, and act by window number
- hold the session awake (`caffeinate`) and treat the display, not the
  session, as the thing that sleeps
- accept it: perceive while locked, queue anything that acts, run it on unlock

Whichever way this lands, it belongs in the trust gate too — a queued action
that runs much later is not the action the user confirmed.

See `research/09-bg-gate-result.md` §0.

## Unmeasured, blocked by the same lock

The gate run locked itself partway through, leaving three things untested:
the AX parsing chain end to end, whether focus suppression (L3) is needed at
all, and whether a CEF app exposes its web tree once activated in the
background. Re-run unlocked: `spikes/bg-gate/run-gate.sh`.

## Rules the executor must follow (measured, not guessed)

From `research/09-bg-gate-result.md`. Each of these silently produces a wrong
answer if ignored.

**A CEF tree is built by the act of reading it, per client, and it decays.**
The first traversal from a given process returns a stub — often the menu bar
alone, which is three hundred nodes and looks like a real tree. Read again.
Every new process pays this, not just the first one ever.

- Do not sleep a fixed interval and assume readiness. Poll until a web area
  appears, then proceed; time out with an error rather than acting on a stub.
- Judge readiness by the number of `AXWebArea` hits, never by total node count.
  A menu bar alone clears any plausible node threshold.
- Do not assert `AXManualAccessibility` or `AXEnhancedUserInterface` as a
  precondition. Both are refused on macOS 26.3 and the tree arrives anyway.

**A locked screen fails silently, and looks exactly like an app with no
windows.** `AXWindows` returns the right count, but every entry is the
application element itself. Check for this explicitly — `CFEqual(entry, app)` —
and stop with a clear error. Without the check, a locked Mac reads as "this app
has no window" and the caller retries forever against something that cannot
recover on its own.
