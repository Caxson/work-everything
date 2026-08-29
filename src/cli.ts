#!/usr/bin/env node
/**
 * `we` — a window onto what the daemon has been doing.
 *
 * These commands read and edit the daemon's durable state; none of them
 * starts perceiving. `promote` is the manual half of the promotion gate, and
 * `replay` re-derives a past routing decision against the *current* registry,
 * which is how you see whether a promotion actually changed anything.
 */
import { Command } from 'commander';
import { loadConfig, type Config } from './config.js';
import { openDb } from './memory/db.js';
import { TrajectoryStore } from './memory/trajectory.js';
import { Registry } from './memory/registry.js';
import { Daemon } from './daemon.js';
import { ShellExecutor } from './execution/shell.js';
import { toolRunner } from './execution/base.js';
import { route } from './core/router.js';
import { chainSteps } from './core/scenario.js';
import { describeCandidate } from './core/promotion.js';
import { initialTrust, progress, stageOf } from './core/trust.js';
import type { Event } from './core/events.js';

interface Wired {
  readonly config: Config;
  readonly store: TrajectoryStore;
  readonly registry: Registry;
  readonly daemon: Daemon;
}

function wire(configPath?: string): Wired {
  const config = loadConfig(configPath);
  const db = openDb(config.dbPath);
  const store = new TrajectoryStore(db);
  const registry = new Registry(db);
  const executor = new ShellExecutor(config.tools);
  const daemon = new Daemon({
    store,
    registry,
    runner: toolRunner([executor]),
    tools: config.tools.map((tool) => ({ name: tool.name, description: tool.description, params: tool.params })),
    router: config.router,
    trust: config.trust,
    promotion: config.promotion,
    planner: config.planner,
  });
  return { config, store, registry, daemon };
}

const program = new Command();
program.name('we').description('work-everything — inspect the daemon that routes your events').version('0.0.1-alpha.0');
program.option('-c, --config <path>', 'path to a JSON config file');

program
  .command('status')
  .description('what each tier absorbed, and what is waiting on you')
  .action(() => {
    const { config, store, daemon } = wire(program.opts<{ config?: string }>().config);
    console.log(`db: ${config.dbPath}`);
    console.log(`scenarios: ${daemon.knownScenarios().length}  plan candidates: ${daemon.knownCandidates().length}`);
    const stats = store.tierStats();
    if (stats.length === 0) console.log('no events recorded yet');
    for (const stat of stats) {
      console.log(`  ${stat.tier.padEnd(12)} events=${stat.events}  llm_calls=${stat.llmCalls}  failures=${stat.failures}  avg=${stat.avgDurationMs}ms`);
    }
    const pending = store.pendingConfirmations();
    if (pending.length > 0) {
      console.log(`\nawaiting confirmation (${pending.length}):`);
      for (const record of pending) console.log(`  ${record.traceId}  ${record.tier}  ${record.reason}`);
    }
  });

program
  .command('scenarios')
  .description('registered scenarios and the plan candidates still on probation')
  .action(() => {
    const { registry, daemon } = wire(program.opts<{ config?: string }>().config);
    const trust = registry.trust();
    console.log('scenarios:');
    for (const scenario of daemon.knownScenarios()) {
      const state = trust.get(scenario.id) ?? initialTrust(scenario.id, scenario.origin);
      console.log(`  ${scenario.id}  [${scenario.origin}]  ${chainSteps(scenario.chain).length} steps  trust=${stageOf(state)} ${progress(state)}`);
    }
    console.log('candidates:');
    for (const candidate of daemon.knownCandidates()) {
      const state = trust.get(candidate.planId) ?? initialTrust(candidate.planId, 'promoted');
      console.log(
        `  ${candidate.planId}  ${describeCandidate(candidate)}  ok=${candidate.successes} fail=${candidate.failures}  trust=${stageOf(state)} ${progress(state)}`,
      );
    }
  });

program
  .command('promote <planId>')
  .description('promote a plan candidate into a scenario (the manual track)')
  .action((planId: string) => {
    const { daemon } = wire(program.opts<{ config?: string }>().config);
    const result = daemon.promote(planId);
    console.log(result.reason);
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('replay <traceId>')
  .description('show a recorded trajectory, and how the same event would route now')
  .action((traceId: string) => {
    const { config, store, registry, daemon } = wire(program.opts<{ config?: string }>().config);
    const record = store.get(traceId);
    if (record === undefined) {
      console.log(`no trajectory '${traceId}'`);
      process.exitCode = 1;
      return;
    }
    console.log(`${record.traceId}  ${new Date(record.ts).toISOString()}  ${record.source}/${record.kind}`);
    console.log(`  text: ${record.text}`);
    console.log(`  then: tier=${record.tier} llm_calls=${record.llmCalls} ok=${record.ok} — ${record.reason}`);
    for (const step of record.steps) {
      console.log(`    ${step.ok ? 'ok  ' : 'fail'} ${step.tool}(${JSON.stringify(step.args)}) ${step.durationMs}ms${step.error === undefined ? '' : ` — ${step.error}`}`);
    }
    const event = { traceId: record.traceId, source: record.source, kind: record.kind, ts: record.ts, payload: record.payload } as Event;
    const now = route({
      event,
      scenarios: daemon.knownScenarios(),
      candidates: daemon.knownCandidates(),
      trust: registry.trust(),
      config: config.router,
    });
    console.log(`  now:  tier=${now.tier} — ${now.reason}`);
  });

program.parse();
