import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { openDb } from '../src/memory/db.js';
import { TrajectoryStore } from '../src/memory/trajectory.js';
import { Registry } from '../src/memory/registry.js';
import { Daemon } from '../src/daemon.js';
import { ShellExecutor } from '../src/execution/shell.js';
import { toolRunner, ok, type Executor, type ToolResult } from '../src/execution/base.js';
import { makeResponder, preflight } from '../src/run/feishuRuntime.js';
import { AxBridgeClient } from '../src/perception/macos/axBridge.js';
import { FeishuReader, feishuHealthMonitor } from '../src/perception/feishu/reader.js';
import { ChatRouteTable } from '../src/perception/feishu/chatRoutes.js';
import { FEISHU_REPLY_TOOL, type FeishuExecutor } from '../src/execution/feishu/sender.js';
import type { Event } from '../src/core/events.js';
import type { SlowThinker } from '../src/hosts/base.js';

const CHAT = '曹良欢（Sion）';
const examplePath = fileURLToPath(new URL('../examples/feishu.config.json', import.meta.url));

/** The shipped example, with its placeholder resolved to a real chat title. */
function exampleConfig(): ReturnType<typeof parseConfig> {
  const raw = readFileSync(examplePath, 'utf8').replaceAll('REPLACE_WITH_YOUR_CHAT_TITLE', CHAT);
  return parseConfig(JSON.parse(raw));
}

function pingEvent(text = 'we ping'): Event {
  return { traceId: 'feishu-1', source: 'feishu', kind: 'message', ts: 1_700_000_000_000, payload: { text, chat: CHAT } };
}

/** Records what would have been sent, without touching Feishu. */
class RecordingReply implements Executor {
  readonly kind = 'feishu';
  readonly sent: { text: string; traceId: string }[] = [];

  supports(tool: string): boolean {
    return tool === FEISHU_REPLY_TOOL;
  }

  async run(_tool: string, args: Readonly<Record<string, string>>): Promise<ToolResult> {
    this.sent.push({ text: args['text'] ?? '', traceId: args['trace_id'] ?? '' });
    return ok({ sent: true, chat: CHAT, echoedMessageId: '7679345486104415421', deduped: false }, 1);
  }
}

const silentHost = (text: string): SlowThinker => ({
  name: 'stub',
  available: async () => true,
  think: async () => ({ ok: true, text, llmCalls: 1, durationMs: 5 }),
});

function daemonFor(config: ReturnType<typeof parseConfig>, reply: RecordingReply, host?: SlowThinker): Daemon {
  const db = openDb(':memory:');
  const registry = new Registry(db);
  for (const scenario of config.scenarios) registry.saveScenario(scenario);
  return new Daemon({
    store: new TrajectoryStore(db),
    registry,
    runner: toolRunner([reply, new ShellExecutor(config.tools)]),
    tools: [],
    router: config.router,
    trust: config.trust,
    promotion: config.promotion,
    planner: config.planner,
    ...(host === undefined ? {} : { host }),
  });
}

describe('the shipped example configuration', () => {
  it('parses, and keeps both permission lists separate', () => {
    const config = exampleConfig();
    expect(config.feishu.allowedChats).toEqual([CHAT]);
    expect(config.trust.autoReplyChats).toEqual([CHAT]);
    expect(config.scenarios.map((scenario) => scenario.id)).toEqual(['feishu-ping']);
  });

  it('defaults both lists to empty, so an unconfigured daemon watches and writes nothing', () => {
    const config = parseConfig({});
    expect(config.feishu.allowedChats).toEqual([]);
    expect(config.trust.autoReplyChats).toEqual([]);
    expect(config.scenarios).toEqual([]);
  });

  it("answers 'we ping' on the muscle tier, with no model call", async () => {
    const reply = new RecordingReply();
    const record = await daemonFor(exampleConfig(), reply).handle(pingEvent());

    expect(record.tier).toBe('muscle');
    expect(record.scenarioId).toBe('feishu-ping');
    expect(record.llmCalls).toBe(0);
    expect(record.ok).toBe(true);
    expect(record.steps.map((step) => step.tool)).toEqual(['clock.now', FEISHU_REPLY_TOOL]);
    expect(reply.sent).toHaveLength(1);
    expect(reply.sent[0]?.text).toMatch(/^pong \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // The reply is addressed by trace id, not by whatever chat is on screen.
    expect(reply.sent[0]?.traceId).toBe('feishu-1');
  });

  it('sends anything else to the slow host, and delivers its answer back', async () => {
    const reply = new RecordingReply();
    const delivered: string[] = [];
    const config = exampleConfig();
    const db = openDb(':memory:');
    const registry = new Registry(db);
    for (const scenario of config.scenarios) registry.saveScenario(scenario);

    const daemon = new Daemon({
      store: new TrajectoryStore(db),
      registry,
      runner: toolRunner([reply]),
      tools: [],
      router: config.router,
      trust: config.trust,
      promotion: config.promotion,
      planner: config.planner,
      host: silentHost('今天是星期六。'),
      responder: async ({ text }) => {
        delivered.push(text);
      },
    });

    const record = await daemon.handle({ ...pingEvent('用一句话告诉我今天是星期几'), traceId: 'feishu-2' });
    expect(record.tier).toBe('slow');
    expect(record.llmCalls).toBe(1);
    expect(delivered).toEqual(['今天是星期六。']);
  });
});

describe('the write-back gate', () => {
  function gate(options: { allowedChats: readonly string[]; autoReplyChats: readonly string[] }): {
    respond: ReturnType<typeof makeResponder>;
    sent: { text: string; traceId: string }[];
    lines: string[];
    store: TrajectoryStore;
  } {
    const config = parseConfig({ feishu: { allowedChats: options.allowedChats }, trust: { autoReplyChats: options.autoReplyChats } });
    const routes = new ChatRouteTable();
    routes.remember('feishu-1', { chatTitle: CHAT, messageId: '1', ts: 1 });
    const reply = new RecordingReply();
    const store = new TrajectoryStore(openDb(':memory:'));
    const lines: string[] = [];
    return {
      respond: makeResponder({ config, feishu: reply as unknown as FeishuExecutor, routes, store, log: (line) => lines.push(line) }),
      sent: reply.sent,
      lines,
      store,
    };
  }

  it('sends when the conversation is both watched and answerable', async () => {
    const { respond, sent } = gate({ allowedChats: [CHAT], autoReplyChats: [CHAT] });
    await respond({ event: pingEvent(), text: 'pong', tier: 'slow', ok: true });
    expect(sent).toEqual([{ text: 'pong', traceId: 'feishu-1' }]);
  });

  it('prints and records, but does not send, when the chat is watched only', async () => {
    const { respond, sent, lines, store } = gate({ allowedChats: [CHAT], autoReplyChats: [] });
    await respond({ event: pingEvent(), text: '这条不该发出去', tier: 'slow', ok: true });

    expect(sent).toEqual([]);
    expect(lines.join('\n')).toContain('这条不该发出去');
    const pending = store.pendingConfirmations();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.traceId).toBe('feishu-1:pending');
    expect(pending[0]?.confirmed).toBeNull();
    expect(pending[0]?.text).toBe('这条不该发出去');
  });

  it('drops an answer it cannot address rather than sending it somewhere', async () => {
    const { respond, sent, lines } = gate({ allowedChats: [CHAT], autoReplyChats: [CHAT] });
    await respond({ event: { ...pingEvent(), traceId: 'unknown', payload: { text: 'hi' } }, text: 'pong', tier: 'slow', ok: true });
    expect(sent).toEqual([]);
    expect(lines.join('\n')).toContain('no conversation to put it in');
  });
});

describe('preflight', () => {
  const helper = fileURLToPath(new URL('./fixtures/fakeFeishuAx.mjs', import.meta.url));

  function bridge(env: NodeJS.ProcessEnv): AxBridgeClient {
    return new AxBridgeClient({
      binaryPath: '/nonexistent/we-ax',
      requestTimeoutMs: 4_000,
      spawnFn: () => spawn(process.execPath, [helper], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } }),
    });
  }

  function monitorFor(client: AxBridgeClient, wedgedAfter = 3): ReturnType<typeof feishuHealthMonitor> {
    const reader = new FeishuReader(client, {
      bundleId: 'com.bytedance.macos.feishu',
      appPath: '/Applications/Lark.app',
      selfName: CHAT,
        });
    return feishuHealthMonitor(client, reader, { config: { wedgedAfter } });
  }

  it('passes, and reports the pid, when Feishu is showing a window', async () => {
    const client = bridge({});
    const lines: string[] = [];
    const config = parseConfig({ feishu: { allowedChats: [CHAT] }, trust: { autoReplyChats: [CHAT] } });
    try {
      expect(await preflight(config, client, monitorFor(client), true, (line) => lines.push(line))).toEqual([]);
      expect(lines.join('\n')).toContain('conversation open');
    } finally {
      await client.stop();
    }
  });

  it('lets a tray-closed Feishu through: the user may be about to open it', async () => {
    const client = bridge({ FAKE_NO_WINDOW: '1' });
    const config = parseConfig({ feishu: { allowedChats: [CHAT] } });
    const lines: string[] = [];
    try {
      expect(await preflight(config, client, monitorFor(client), false, (line) => lines.push(line))).toEqual([]);
      expect(lines.join(' ')).toContain('tray');
      expect(lines.join(' ')).not.toContain('wedged');
    } finally {
      await client.stop();
    }
  });

  it('refuses to start against a wedged Feishu, because nothing will ever arrive', async () => {
    // A window the helper can address, and no web content in it.
    const client = bridge({ FAKE_NO_WEB_AREA: '1' });
    const config = parseConfig({ feishu: { allowedChats: [CHAT] } });
    const monitor = monitorFor(client, 1);
    try {
      await monitor.check();
      const problems = await preflight(config, client, monitor, false, () => undefined);
      expect(problems.join(' ')).toContain('wedged');
      expect(problems.join(' ')).toContain('restart Feishu');
    } finally {
      await client.stop();
    }
  });

  it('stops at the missing accessibility grant, since nothing else can work without it', async () => {
    const client = bridge({ FAKE_UNTRUSTED: '1' });
    const config = parseConfig({ feishu: { allowedChats: [CHAT] } });
    try {
      const problems = await preflight(config, client, monitorFor(client), false, () => undefined);
      expect(problems.join(' ')).toContain('accessibility permission');
    } finally {
      await client.stop();
    }
  });

  it('refuses to run with an empty allowlist, because it would observe nothing', async () => {
    const client = bridge({});
    try {
      const problems = await preflight(parseConfig({}), client, monitorFor(client), false, () => undefined);
      expect(problems.join(' ')).toContain('feishu.allowedChats is empty');
    } finally {
      await client.stop();
    }
  });
});
