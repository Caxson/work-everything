# work-everything

A resident daemon that watches what you do in your tools and answers with the
cheapest thing that will work.

> **pre-alpha.** The core is implemented and tested; there is no perceiver for
> a real tool yet, and no way to start it as a service. See
> [docs/TODO.md](docs/TODO.md) for what is missing.

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

The CLI reads the daemon's state:

```bash
we status              # what each tier absorbed, and what is waiting on you
we scenarios           # scenarios and the plan candidates still on probation
we promote <planId>    # promote a candidate by hand
we replay <traceId>    # a recorded trajectory, and how it would route now
```

Configuration is a JSON file (`--config`, or `WORK_EVERYTHING_CONFIG`) merged
under environment overrides; see `src/config.ts` for the schema. API keys are
read from the environment only — `WORK_EVERYTHING_API_KEY`, `DASHSCOPE_API_KEY`,
`DEEPSEEK_API_KEY`, or `OPENAI_API_KEY`.

## Layout

| path | what lives there |
|---|---|
| `src/core/` | events, scenarios, the chain engine, router, planner, trust gate, promotion |
| `src/perception/` | where events come from, including the macOS accessibility bridge client |
| `src/execution/` | how a chain step touches the world |
| `src/hosts/` | slow thinking, hosted by an existing agent CLI |
| `src/memory/` | trajectories and the durable registry |
| `native/ax-bridge/` | the macOS helper binary ([protocol](docs/ax-bridge-protocol.md)) |
| `spikes/` | throwaway probes |

## License

MIT
