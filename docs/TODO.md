# TODO

Everything known to be missing or provisional in this skeleton lives here.

## Perception

- Only the macOS accessibility perceiver has a client. Feishu and Claude Code
  perceivers are interfaces without implementations; the daemon has nothing to
  observe until one exists.
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
  nothing consumes the answer.
- Quarantine is permanent until `reinstate`, which no command calls yet.

## Execution and hosts

- The only executor is `shell`. Tools must be declared in config with a fixed
  argv; there is no HTTP executor and no MCP client.
- `ClaudeCodeHost` sends a bare prompt. It passes no context from the
  trajectory, and it starts a fresh session every time.

## Operations

- `we` inspects state; it cannot start the daemon. There is no `we run`,
  no service definition, and no log rotation.
- The database is never compacted or pruned.
- `we replay` re-derives the routing decision only. It does not re-execute a
  chain against recorded tool results.
