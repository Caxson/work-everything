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
