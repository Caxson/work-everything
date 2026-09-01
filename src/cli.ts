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
import { DeferredStore } from './memory/deferred.js';
import { describeAge, describeChain } from './queue/deferred.js';
import type { DeferredAction } from './queue/deferred.js';
import { Daemon } from './daemon.js';
import { ShellExecutor } from './execution/shell.js';
import { toolRunner } from './execution/base.js';
import { route } from './core/router.js';
import { chainSteps } from './core/scenario.js';
import { describeCandidate } from './core/promotion.js';
import { initialTrust, progress, stageOf } from './core/trust.js';
import { createFeishuRuntime } from './run/feishuRuntime.js';
import type { Event } from './core/events.js';

interface Wired {
  readonly config: Config;
  readonly store: TrajectoryStore;
  readonly registry: Registry;
  readonly queue: DeferredStore;
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
  return { config, store, registry, queue: new DeferredStore(db), daemon };
}

const program = new Command();
program.name('we').description('work-everything — inspect the daemon that routes your events').version('0.0.1-alpha.0');
program.option('-c, --config <path>', 'path to a JSON config file');

program
  .command('run')
  .description('start the daemon: watch a source, route what it sees, answer back')
  .requiredOption('--source <name>', "event source to watch ('feishu')")
  .action(async (options: { source: string }) => {
    if (options.source !== 'feishu') {
      console.error(`unknown source '${options.source}'; the only implemented source is 'feishu'`);
      process.exitCode = 1;
      return;
    }

    const config = loadConfig(program.opts<{ config?: string }>().config);
    const log = (line: string): void => console.log(line);
    const runtime = createFeishuRuntime(config, log);

    const problems = await runtime.preflight();
    if (problems.length > 0) {
      for (const problem of problems) console.error(`[preflight] ${problem}`);
      await runtime.stop();
      process.exitCode = 1;
      return;
    }

    const controller = new AbortController();
    const stop = (): void => {
      log('[run] stopping');
      controller.abort();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    log(`[run] watching ${config.feishu.allowedChats.length} conversation(s); replying in ${config.trust.autoReplyChats.length}`);
    try {
      await runtime.run(controller.signal);
    } finally {
      await runtime.stop();
      const fatal = runtime.fatal();
      if (fatal === undefined) {
        log('[run] stopped');
      } else {
        // A wedged accessibility layer is not something the daemon can retry
        // its way out of; it ends the run and says what a human has to do.
        console.error(`[run] stopped: ${fatal}`);
        process.exitCode = 1;
      }
    }
  });

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
  .command('queue')
  .description('actions held because the screen was locked, and the ones that never ran')
  .option('--discarded', 'show what was dropped instead of what is waiting')
  .option('-n, --limit <count>', 'how many discarded actions to show', '20')
  .action((options: { discarded?: boolean; limit: string }) => {
    const { config, queue } = wire(program.opts<{ config?: string }>().config);
    const now = Date.now();

    if (options.discarded === true) {
      const settled = queue.settled(Number.parseInt(options.limit, 10) || 20);
      if (settled.length === 0) {
        console.log('nothing has been discarded');
        return;
      }
      console.log(`discarded (${settled.length}), newest first:`);
      for (const action of settled) {
        console.log(`  ${action.id}  ${action.status}`);
        console.log(`    ${action.purpose}`);
        console.log(`    ${action.detail}`);
      }
      return;
    }

    const pending = queue.pending();
    console.log(`db: ${config.dbPath}`);
    if (!config.queue.enabled) {
      console.log('queue.enabled is false: a locked screen fails actions instead of holding them.');
      if (pending.length > 0) {
        console.log(`  ${pending.length} action(s) queued by an earlier run are still here; they will be dropped as they expire, and none will be sent.`);
      }
    }
    if (pending.length === 0) {
      console.log('nothing is waiting on the screen');
    } else {
      console.log(`waiting (${pending.length}/${config.queue.capacity}), in the order they will run:`);
      for (const action of pending) console.log(describePending(action, now));
    }

    // Handed back for a person to answer. Listed here because this is the only
    // place that says how to answer them.
    const waiting = queue.settled(50).filter((action) => action.status === 'trust_reset');
    if (waiting.length === 0) return;
    console.log(`\nwaiting on you (${waiting.length}) — 'we queue-approve <id>' to send, 'we queue-drop <id>' to decline:`);
    for (const action of waiting) {
      console.log(`  ${action.id}  ${action.purpose}`);
      console.log(`    ${action.detail}`);
    }
  });

program
  .command('queue-approve <actionId>')
  .description('re-authorize an action that waited too long to run unattended, and put it back in the queue')
  .action((actionId: string) => {
    const { config, store, queue } = wire(program.opts<{ config?: string }>().config);
    const action = queue.get(actionId);
    if (action === undefined) {
      console.error(`no queued action '${actionId}'`);
      process.exitCode = 1;
      return;
    }
    if (action.status !== 'trust_reset') {
      console.error(`'${actionId}' is ${action.status}, not waiting on you; only an action handed back for confirmation can be approved`);
      process.exitCode = 1;
      return;
    }
    const back = queue.reinstate(action, config.queue, Date.now());
    store.markConfirmed(`${action.traceId}:pending:${action.id}`, true);
    console.log(`approved: ${back.purpose}`);
    console.log(`  back in the queue, authorized from now; it expires in ${Math.round((back.expiresAt - Date.now()) / 1000)}s`);
  });

program
  .command('queue-drop <actionId>')
  .description('decline an action that was handed back for confirmation')
  .action((actionId: string) => {
    const { store, queue } = wire(program.opts<{ config?: string }>().config);
    const action = queue.get(actionId);
    if (action === undefined) {
      console.error(`no queued action '${actionId}'`);
      process.exitCode = 1;
      return;
    }
    store.markConfirmed(`${action.traceId}:pending:${action.id}`, false);
    console.log(`declined: ${action.purpose}`);
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

/**
 * One waiting action. The two deadlines are shown as remaining time rather than
 * timestamps, because the question a person has looking at this list is "will
 * this still go out", not "when was it decided".
 */
function describePending(action: DeferredAction, now: number): string {
  const expiresIn = Math.max(0, Math.round((action.expiresAt - now) / 1000));
  const authority = now > action.trustResetAt ? 'needs confirming again' : `runs unattended for another ${Math.round((action.trustResetAt - now) / 1000)}s`;
  return [
    `  ${action.id}  waiting ${describeAge(action.enqueuedAt, now)}  expires in ${expiresIn}s`,
    `    ${action.purpose}`,
    `    ${describeChain(action)}  [premise: ${action.precondition.kind || 'none captured'}]  ${authority}`,
  ].join('\n');
}

program.parse();
