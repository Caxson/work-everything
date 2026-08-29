# work-everything

A resident daemon that watches what you do in your tools and answers with the
cheapest thing that will work.

> **pre-alpha.** The core is implemented and tested, and Feishu is wired end to
> end — `we run --source feishu` watches a conversation, answers `we ping` off
> the muscle tier with no model call, and hands anything else to `claude -p`.
> There is no service definition yet. See [docs/TODO.md](docs/TODO.md).

## How an event is handled

```
                        ┌───────────────────────────┐
   feishu ─┐            │          router           │
claude_code├─ event ──▶ │  retrieval over scenarios │
  macos ax ─┘           │  + anchors over plans     │
                        └────────────┬──────────────┘
                                     │
          ┌──────────────────────────┼──────────────────────────┐
          ▼                          ▼                          ▼
  ┌───────────────┐          ┌───────────────┐          ┌───────────────┐
  │    muscle     │          │ fast thinking │          │ slow thinking │
  │  a scenario   │          │ one LIGHT call│          │  claude -p    │
  │  already      │          │ writes a whole│          │  reasons it   │
  │  covers this  │          │ chain, then   │          │  out step by  │
  │               │          │ determinism   │          │  step         │
  │  0 model calls│          │  1 model call │          │  n model calls│
  └───────┬───────┘          └───────┬───────┘          └───────┬───────┘
          │                          │                          │
          └──────────────┬───────────┴──────────────────────────┘
                         ▼
                 ┌───────────────┐
                 │  trajectory   │  every event, its tier, its cost
                 └───────┬───────┘
                         │
                 ┌───────▼───────┐
                 │  trust gate   │  candidate → confirming (n/N) → auto
                 └───────┬───────┘   a failure demotes; a run of them
                         │           takes the chain out of rotation
                         ▼
              a plan that keeps working
              becomes a scenario, and the
              next event like it is muscle
```

Both deterministic tiers run through one engine, so a generated plan and a
promoted scenario are the same object by the time anything executes. A chain
whose template variables cannot be filled without a model is not muscle,
whatever the router said — it is demoted and the model call is recorded, so
zero in the trajectory always means zero.

## Install

Requires Node ≥ 22.

```bash
npm install
npm run build
npm test
```

```bash
we run --source feishu # watch a Feishu conversation and answer in it
```

The rest of the CLI reads the daemon's state:

```bash
we status              # what each tier absorbed, and what is waiting on you
we scenarios           # scenarios and the plan candidates still on probation
we promote <planId>    # promote a candidate by hand
we replay <traceId>    # a recorded trajectory, and how it would route now
```

Configuration is a JSON file (`--config`, or `WORK_EVERYTHING_CONFIG`) merged
under environment overrides; see `src/config.ts` for the schema and
[`examples/feishu.config.json`](examples/feishu.config.json) for a working one.
API keys are read from the environment only — `WORK_EVERYTHING_API_KEY`,
`DASHSCOPE_API_KEY`, `DEEPSEEK_API_KEY`, or `OPENAI_API_KEY`.

## Watching Feishu

Two separate permissions, both empty by default, so an unconfigured daemon
watches nothing and writes nowhere:

| key | grants |
|---|---|
| `feishu.allowedChats` | conversations it may **read** |
| `trust.autoReplyChats` | conversations it may **write to** without asking |

An answer for a chat that is watched but not answerable is printed and recorded
as a pending confirmation instead of being sent. Perception needs Feishu's
window to be visible — closed to the tray, or behind a locked screen, the app
exposes no accessibility tree at all and the daemon says so rather than
pretending the conversation is empty.

`scripts/e2e-feishu.mjs` drives the whole loop against the real app; it refuses
to run anywhere but a chat with yourself.

## Layout

| path | what lives there |
|---|---|
| `src/core/` | events, scenarios, the chain engine, router, planner, trust gate, promotion |
| `src/perception/` | where events come from: the macOS accessibility bridge client and the Feishu adapter |
| `src/run/` | wiring one source into a running daemon |
| `src/execution/` | how a chain step touches the world |
| `src/hosts/` | slow thinking, hosted by an existing agent CLI |
| `src/memory/` | trajectories and the durable registry |
| `native/ax-bridge/` | the macOS helper binary ([protocol](docs/ax-bridge-protocol.md)) |
| `examples/` | a working configuration ([notes](examples/README.md)) |
| `scripts/` | the end-to-end check against the real Feishu |
| `spikes/` | throwaway probes |

## License

MIT
