/**
 * Wiring the Feishu loop: message in, tier chosen, reply out.
 *
 * Everything here is assembly. The one decision this file owns is the **trust
 * gate on writing back**: watching a conversation and answering in it are
 * separate permissions. A chat in `feishu.allowedChats` produces events; only
 * a chat that is *also* in `trust.autoReplyChats` gets an automatic reply.
 * Everywhere else the reply is printed for the operator and recorded as a
 * pending confirmation, so nothing the daemon decided to say reaches a person
 * without someone having said it may.
 *
 * It is also where the locked-screen policy is assembled, and the assembly is
 * the policy. There is **one** lock sensor, and every channel into it carries
 * the helper's own verdict: the `env` poll, every `SCREEN_LOCKED` the action
 * layer throws (through `ActionRegistry`'s `onError`, while it is still a typed
 * code), and the health monitor's `screen_locked` (which is that same helper
 * diagnosis, and is the only one that fires when the sender refuses before
 * touching a driver). Nothing here reads a lock state for itself.
 *
 * What the gate does **not** touch is perception: no perceiver and no reader
 * passes through it, so a non-GUI source keeps producing events, and every
 * event that arrives is still routed and recorded while the Mac is locked.
 * Worth being exact about the limit, though, because it is physical rather
 * than chosen: Feishu is read *through the screen*, and a locked Mac
 * substitutes the application element for every window. So this particular
 * source goes quiet while locked no matter what this file does — the queue
 * fills from work already in flight and from sources that are not the screen.
 */
import { openDb } from '../memory/db.js';
import { TrajectoryStore } from '../memory/trajectory.js';
import { Registry } from '../memory/registry.js';
import type { DeferredStore } from '../memory/deferred.js';
import { Daemon, type ResponderFn } from '../daemon.js';
import type { Config } from '../config.js';
import { ShellExecutor } from '../execution/shell.js';
import { screenBoundTools, serializeTools, toolRunner, type ToolRunner } from '../execution/base.js';
import { FeishuExecutor, FEISHU_REPLY_CHAIN, FEISHU_REPLY_TOOL } from '../execution/feishu/sender.js';
import type { ExecutionGate } from '../queue/gate.js';
import type { QueueDrainer } from '../queue/drain.js';
import { createActionQueue } from './queueWiring.js';
import { AxBridgeClient } from '../perception/macos/axBridge.js';
import { ActionRegistry } from '../actions/registry.js';
import type { ActionError } from '../actions/errors.js';
import { SnapshotStore } from '../actions/snapshot.js';
import { AutoWait } from '../actions/wait.js';
import { bridgeKeyboardRoute } from '../actions/keyboard.js';
import { systemClipboard } from '../actions/clipboard.js';
import { MacAxDriver } from '../actions/drivers/macAx.js';
import { BrowserCdpDriver } from '../actions/drivers/browserCdp.js';
import { FeishuReader, feishuHealthMonitor } from '../perception/feishu/reader.js';
import { FeishuPerceiver } from '../perception/feishu/perceiver.js';
import { ChatRouteTable } from '../perception/feishu/chatRoutes.js';
import { SentLedger } from '../perception/feishu/sentLedger.js';
import type { FeishuHealth, FeishuHealthMonitor } from '../perception/feishu/health.js';
import { ClaudeCodeHost } from '../hosts/claudeCode.js';
import { createLightModel, resolveApiKey } from '../llm/openaiCompatible.js';
import type { Event } from '../core/events.js';

export interface FeishuRuntime {
  readonly daemon: Daemon;
  readonly store: TrajectoryStore;
  /** What is waiting behind a locked screen, for `we queue` and for tests. */
  readonly queue: DeferredStore;
  readonly drainer: QueueDrainer;
  readonly run: (signal: AbortSignal) => Promise<void>;
  readonly stop: () => Promise<void>;
  /** Set when the loop ended because Feishu's accessibility layer is wedged. */
  readonly fatal: () => string | undefined;
  /** What the operator should be told before the first event arrives. */
  readonly preflight: () => Promise<readonly string[]>;
}

export type LogFn = (line: string) => void;

/** The reply tool, as the planner sees it. */
const REPLY_TOOL_SCHEMA = {
  name: FEISHU_REPLY_TOOL,
  description: 'Reply in the Feishu conversation an event came from. Pass the event trace id as trace_id.',
  params: ['text', 'trace_id'],
};

export function createFeishuRuntime(config: Config, log: LogFn): FeishuRuntime {
  const db = openDb(config.dbPath);
  const store = new TrajectoryStore(db);
  const registry = new Registry(db);
  for (const scenario of config.scenarios) registry.saveScenario(scenario);

  const client = new AxBridgeClient({ binaryPath: config.axBridge.binaryPath, requestTimeoutMs: config.axBridge.requestTimeoutMs });
  const routes = new ChatRouteTable();
  const ledger = new SentLedger();
  const reader = new FeishuReader(client, {
    bundleId: config.feishu.bundleId,
    appPath: config.feishu.appPath,
    selfName: config.feishu.selfName,
  });

  // One action vocabulary over two drivers. The browser driver is offered
  // first because the accessibility driver claims every app: whatever wants
  // more specific handling has to be asked before the general one.
  const snapshots = new SnapshotStore();
  const wait = new AutoWait({ settleMs: config.actions.settleMs, maxWaitMs: config.actions.maxWaitMs, pollMs: config.actions.pollMs });

  // Filled in once the queue exists: the drivers and the health monitor are
  // built before it, and the queue needs the executors built on top of them.
  let noteActionError: (error: ActionError) => void = () => undefined;
  let noteHealth: (health: FeishuHealth) => void = () => undefined;

  const actions = new ActionRegistry(
    [
      new BrowserCdpDriver({ snapshots, wait, targets: config.actions.browsers }),
      new MacAxDriver({
        client,
        keyboard: bridgeKeyboardRoute(client),
        snapshots,
        wait,
        clipboard: systemClipboard,
        config: {
          treeMaxDepth: config.actions.treeMaxDepth,
          treeMaxNodes: config.actions.treeMaxNodes,
          treeTimeoutMs: config.actions.treeTimeoutMs,
          treePollMs: config.actions.treePollMs,
        },
      }),
    ],
    { onError: (error) => noteActionError(error) },
  );

  // The sender consults health *before* it touches a driver, so a locked
  // screen found there never reaches the action layer's error channel. This is
  // the same helper diagnosis either way — `health.ts` turns the bridge's
  // `SCREEN_LOCKED` into a state — so listening here adds a channel, not a
  // second source.
  const monitor = feishuHealthMonitor(client, reader, { onHealth: (health) => noteHealth(health) });
  let fatal: string | undefined;
  const perceiver = new FeishuPerceiver({
    client,
    reader,
    monitor,
    routes,
    ledger,
    onWarn: (message) => log(`[feishu] ${message}`),
    onFatal: (health) => {
      fatal = health.detail;
      log(`[feishu] ${health.detail}`);
    },
    config: {
      allowedChats: config.feishu.allowedChats,
      pollIntervalMs: config.feishu.pollIntervalMs,
      debounceMs: config.feishu.debounceMs,
      memory: 2_000,
    },
  });

  const feishu = new FeishuExecutor({
    actions,
    snapshots,
    reader,
    monitor,
    routes,
    // The durable half of "which conversation did this come from", for a reply
    // restored from the queue after a restart, when `routes` is empty.
    recordedChat: (traceId) => {
      const chat = store.get(traceId)?.payload['chat'];
      return typeof chat === 'string' && chat !== '' ? chat : undefined;
    },
    ledger,
    config: {
      app: config.feishu.bundleId,
      allowedChats: config.feishu.allowedChats,
      dedupeWindowMs: config.feishu.dedupeWindowMs,
      echoTimeoutMs: 5_000,
      echoIntervalMs: 400,
      maxTextLength: config.feishu.maxTextLength,
    },
  });

  const shell = new ShellExecutor(config.tools);
  const executors = [feishu, shell];
  // Screen-bound tools run one at a time: the daemon's loop and the queue's
  // drain are two async loops over this one runner, and they reach Feishu
  // through a single composer.
  const runner = serializeTools(toolRunner(executors), screenBoundTools(executors));

  // One sensor over two channels, both the helper's own verdict: the
  // `windowInfo` poll, which keeps answering while locked, and every
  // SCREEN_LOCKED the drivers throw. Nothing here reads a lock state itself.
  const { queue, gate, drainer, noteActionError: note, noteHealth: notedHealth } = createActionQueue({
    db,
    store,
    runner,
    executors,
    routes,
    config,
    screen: () => client.screenState(),
    openConversation: async () => {
      const snapshot = await reader.snapshot();
      return { title: snapshot.chatTitle, messageIds: snapshot.messages.map((message) => message.id) };
    },
    log,
  });
  noteActionError = note;
  noteHealth = notedHealth;

  const host = new ClaudeCodeHost({
    command: config.host.command,
    args: config.host.args,
    timeoutMs: config.host.timeoutMs,
    ...(config.host.cwd === undefined ? {} : { cwd: config.host.cwd }),
  });

  const apiKey = resolveApiKey();
  const lightModel =
    apiKey === undefined
      ? undefined
      : createLightModel({
          baseUrl: config.llm.baseUrl,
          model: config.llm.model,
          apiKey,
          timeoutMs: config.llm.timeoutMs,
          temperature: config.llm.temperature,
          maxTokens: config.llm.maxTokens,
        });

  const daemon = new Daemon({
    store,
    registry,
    runner,
    tools: [REPLY_TOOL_SCHEMA, ...config.tools.map((tool) => ({ name: tool.name, description: tool.description, params: tool.params }))],
    router: config.router,
    trust: config.trust,
    promotion: config.promotion,
    planner: config.planner,
    perceivers: [perceiver],
    ...(lightModel === undefined ? {} : { lightModel }),
    host,
    gate,
    responder: makeResponder({ config, runner, gate, routes, store, log }),
  });

  return {
    daemon,
    store,
    queue,
    drainer,
    fatal: () => fatal,
    // Both loops run for the life of the signal. The drainer is not a
    // perceiver and must not be one: it produces no events, it releases work
    // the daemon has already decided on.
    run: async (signal) => {
      await Promise.all([daemon.run(signal), drainer.run(signal)]);
    },
    stop: async () => {
      await perceiver.close();
      await client.stop();
    },
    preflight: () => preflight(config, client, monitor, apiKey !== undefined, log),
  };
}

interface ResponderDeps {
  readonly config: Config;
  /** The composed executors. The reply goes out the same door chains use. */
  readonly runner: ToolRunner;
  /** Omitted means a locked screen fails the send rather than queueing it. */
  readonly gate?: ExecutionGate | undefined;
  readonly routes: ChatRouteTable;
  readonly store: TrajectoryStore;
  readonly log: LogFn;
}

/** The write-back gate. See this file's header for why it is separate. */
export function makeResponder(deps: ResponderDeps): ResponderFn {
  return async ({ event, text }) => {
    const chat = deps.routes.lookup(event.traceId)?.chatTitle ?? asString(event.payload['chat']);
    if (chat === '') {
      deps.log(`[reply] ${event.traceId} produced an answer but no conversation to put it in; dropped`);
      return;
    }

    const watched = deps.config.feishu.allowedChats.includes(chat);
    const answerable = deps.config.trust.autoReplyChats.includes(chat);
    if (!watched || !answerable) {
      deps.log(`[pending] '${chat}' is not in trust.autoReplyChats — this reply was NOT sent:\n${text}\n`);
      deps.store.append(pendingRecord(event, chat, text));
      return;
    }

    // The same admission gate every chain passes: a reply decided on behind a
    // locked screen is queued, not attempted and not silently dropped.
    const vars = { text, trace_id: event.traceId };
    const admission = await deps.gate?.admit({ traceId: event.traceId, chain: FEISHU_REPLY_CHAIN, vars });
    if (admission !== undefined && !admission.admitted) {
      deps.log(`[reply] not sent to '${chat}' yet: ${admission.reason}`);
      return;
    }

    const result = await deps.runner(FEISHU_REPLY_TOOL, vars);
    if (result.ok) deps.log(`[reply] sent to '${chat}' (${result.durationMs}ms)`);
    else deps.log(`[reply] failed for '${chat}': ${result.error ?? 'unknown error'}`);
  };
}

function pendingRecord(event: Event, chat: string, text: string): Parameters<TrajectoryStore['append']>[0] {
  return {
    traceId: `${event.traceId}:pending`,
    ts: Date.now(),
    source: event.source,
    kind: 'reply.pending_confirm',
    text,
    payload: { chat, originTraceId: event.traceId },
    tier: 'pending_confirm',
    needsConfirmation: true,
    confirmed: null,
    score: 0,
    reason: `'${chat}' is watched but not in trust.autoReplyChats`,
    considered: [],
    llmCalls: 0,
    durationMs: 0,
    ok: true,
    steps: [],
  };
}

/** Report what would stop the loop working, before anything is observed. */
export async function preflight(
  config: Config,
  client: AxBridgeClient,
  monitor: FeishuHealthMonitor,
  hasLightModel: boolean,
  log: LogFn,
): Promise<readonly string[]> {
  const problems: string[] = [];
  if (config.feishu.allowedChats.length === 0) problems.push('feishu.allowedChats is empty: no conversation will produce an event');
  if (config.trust.autoReplyChats.length === 0) log('[preflight] trust.autoReplyChats is empty: every answer will be printed, not sent');
  if (!hasLightModel) log('[preflight] no API key in the environment: the fast tier will fall through to the slow host');

  try {
    client.start();
    if (!(await client.trusted())) {
      problems.push('the ax bridge has no accessibility permission; grant it to the app that starts this daemon');
      return problems;
    }
    const health = await monitor.check();
    // `no_window` is not a reason to refuse to start — the user may be about
    // to open Feishu — but `wedged` is: nothing will ever arrive.
    if (health.state === 'wedged') problems.push(health.detail);
    else log(`[preflight] ${health.detail}`);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return problems;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
