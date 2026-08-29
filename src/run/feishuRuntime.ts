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
 */
import { openDb } from '../memory/db.js';
import { TrajectoryStore } from '../memory/trajectory.js';
import { Registry } from '../memory/registry.js';
import { Daemon, type ResponderFn } from '../daemon.js';
import type { Config } from '../config.js';
import { ShellExecutor } from '../execution/shell.js';
import { toolRunner } from '../execution/base.js';
import { FeishuExecutor, FEISHU_REPLY_TOOL } from '../execution/feishu/sender.js';
import { AxBridgeClient } from '../perception/macos/axBridge.js';
import { FeishuReader } from '../perception/feishu/reader.js';
import { FeishuPerceiver } from '../perception/feishu/perceiver.js';
import { ChatRouteTable } from '../perception/feishu/chatRoutes.js';
import { SentLedger } from '../perception/feishu/sentLedger.js';
import { ClaudeCodeHost } from '../hosts/claudeCode.js';
import { createLightModel, resolveApiKey } from '../llm/openaiCompatible.js';
import type { Event } from '../core/events.js';

export interface FeishuRuntime {
  readonly daemon: Daemon;
  readonly store: TrajectoryStore;
  readonly run: (signal: AbortSignal) => Promise<void>;
  readonly stop: () => Promise<void>;
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
    windowTimeoutMs: config.feishu.windowTimeoutMs,
  });

  const perceiver = new FeishuPerceiver({
    client,
    reader,
    routes,
    ledger,
    config: {
      allowedChats: config.feishu.allowedChats,
      pollIntervalMs: config.feishu.pollIntervalMs,
      debounceMs: config.feishu.debounceMs,
      memory: 2_000,
    },
  });

  const feishu = new FeishuExecutor({
    client,
    reader,
    routes,
    ledger,
    config: {
      allowedChats: config.feishu.allowedChats,
      dedupeWindowMs: config.feishu.dedupeWindowMs,
      focusAttempts: 3,
      focusSettleMs: 600,
      typeSettleMs: 300,
      echoTimeoutMs: 5_000,
      echoIntervalMs: 400,
      maxTextLength: config.feishu.maxTextLength,
    },
  });

  const shell = new ShellExecutor(config.tools);
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
    runner: toolRunner([feishu, shell]),
    tools: [REPLY_TOOL_SCHEMA, ...config.tools.map((tool) => ({ name: tool.name, description: tool.description, params: tool.params }))],
    router: config.router,
    trust: config.trust,
    promotion: config.promotion,
    planner: config.planner,
    perceivers: [perceiver],
    ...(lightModel === undefined ? {} : { lightModel }),
    host,
    responder: makeResponder({ config, feishu, routes, store, log }),
  });

  return {
    daemon,
    store,
    run: (signal) => daemon.run(signal),
    stop: async () => {
      await perceiver.close();
      await client.stop();
    },
    preflight: () => preflight(config, client, reader, apiKey !== undefined, log),
  };
}

interface ResponderDeps {
  readonly config: Config;
  readonly feishu: FeishuExecutor;
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

    const result = await deps.feishu.run(FEISHU_REPLY_TOOL, { text, trace_id: event.traceId });
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
  reader: FeishuReader,
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
    const window = await reader.ensureWindow();
    if (!window.ok) problems.push(window.reason);
    else log(`[preflight] Feishu pid ${window.pid}, window visible`);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return problems;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
