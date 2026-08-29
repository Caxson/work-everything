import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AxBridgeClient } from '../src/perception/macos/axBridge.js';
import { FeishuReader, feishuHealthMonitor } from '../src/perception/feishu/reader.js';
import { ChatRouteTable } from '../src/perception/feishu/chatRoutes.js';
import { SentLedger } from '../src/perception/feishu/sentLedger.js';
import { FeishuExecutor, FEISHU_REPLY_TOOL } from '../src/execution/feishu/sender.js';
import type { ReplyOutcome } from '../src/execution/feishu/sender.js';

const helper = fileURLToPath(new URL('./fixtures/fakeFeishuAx.mjs', import.meta.url));
const SELF_CHAT = '曹良欢（Sion）';

interface Rig {
  readonly executor: FeishuExecutor;
  readonly routes: ChatRouteTable;
  readonly ledger: SentLedger;
  readonly client: AxBridgeClient;
  /** Every op the fake bridge was asked to perform, in order. */
  readonly log: { op: string; key?: string; modifiers?: string[]; nodeId?: number }[];
  setNow: (ms: number) => void;
}

let open: AxBridgeClient | undefined;

afterEach(async () => {
  await open?.stop();
  open = undefined;
});

function rig(options: { env?: NodeJS.ProcessEnv; allowedChats?: readonly string[]; wedgedAfter?: number } = {}): Rig {
  const log: Rig['log'] = [];
  const spawnFn = (): ChildProcessWithoutNullStreams => {
    const child = spawn(process.execPath, [helper], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
    });
    child.stderr.setEncoding('utf8');
    let buffer = '';
    child.stderr.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.startsWith('LOG ')) log.push(JSON.parse(line.slice(4)) as Rig['log'][number]);
    });
    return child;
  };

  const client = new AxBridgeClient({ binaryPath: '/nonexistent/we-ax', requestTimeoutMs: 4_000, spawnFn });
  client.start();
  open = client;

  let now = 1_000_000;
  const reader = new FeishuReader(client, {
    bundleId: 'com.bytedance.macos.feishu',
    appPath: '/Applications/Lark.app',
    selfName: SELF_CHAT,
    windowTimeoutMs: 50,
    reopen: async () => undefined,
    now: () => now,
  });
  const routes = new ChatRouteTable();
  const ledger = new SentLedger();
  // The host's real lock state must not leak into a unit test.
  const monitor = feishuHealthMonitor(client, reader, {
    screenLocked: async () => false,
    config: { wedgedAfter: options.wedgedAfter ?? 3 },
  });
  const executor = new FeishuExecutor({
    client,
    reader,
    monitor,
    routes,
    ledger,
    config: {
      allowedChats: options.allowedChats ?? [SELF_CHAT],
      dedupeWindowMs: 30_000,
      focusAttempts: 2,
      focusSettleMs: 0,
      typeSettleMs: 0,
      echoTimeoutMs: 200,
      echoIntervalMs: 10,
      maxTextLength: 2_000,
    },
    now: () => now,
    sleep: async () => undefined,
  });

  return { executor, routes, ledger, client, log, setNow: (ms) => (now = ms) };
}

const keystrokes = (log: Rig['log']): Rig['log'] => log.filter((entry) => entry.op === 'keystroke');

describe('feishu.reply', () => {
  it('sends into the conversation the event came from and reads the message back', async () => {
    const { executor, routes, log } = rig();
    routes.remember('feishu-1', { chatTitle: SELF_CHAT, messageId: '1', ts: 1 });

    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'pong 2026-08-29T07:00:00Z', trace_id: 'feishu-1' });
    expect(result.ok).toBe(true);
    const outcome = result.value as ReplyOutcome;
    expect(outcome.sent).toBe(true);
    expect(outcome.chat).toBe(SELF_CHAT);
    expect(outcome.echoedMessageId).toMatch(/^\d+$/);
    expect(outcome.deduped).toBe(false);

    // Clicked to focus, cleared, typed, then Enter — in that order.
    expect(log.some((entry) => entry.op === 'click')).toBe(true);
    expect(keystrokes(log).map((entry) => entry.key)).toEqual(['a', 'delete', 'pong 2026-08-29T07:00:00Z', 'return']);
  });

  it('refuses a conversation that is not on the allowlist, and sends no keystroke', async () => {
    const { executor, log } = rig({ allowedChats: [] });
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'hello', chat: '同事甲' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('feishu.allowedChats');
    expect(keystrokes(log)).toEqual([]);
  });

  it('refuses when the conversation on screen is not the one being answered', async () => {
    const { executor, log } = rig({ allowedChats: ['同事甲'], env: { FAKE_CHAT_TITLE: SELF_CHAT } });
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'hello', chat: '同事甲' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('refusing to send into the wrong chat');
    expect(keystrokes(log)).toEqual([]);
  });

  it('sends nothing at all when the caret cannot be confirmed inside the composer', async () => {
    const { executor, log } = rig({ env: { FAKE_FOCUS_FAILS: '1' } });
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'hello', chat: SELF_CHAT });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('sent no keystrokes');
    expect(keystrokes(log)).toEqual([]);
  });

  it('reports the tray state instead of typing into a window that is not there', async () => {
    const { executor, log } = rig({ env: { FAKE_NO_WINDOW: '1' } });
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'hello', chat: SELF_CHAT });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no window');
    expect(keystrokes(log)).toEqual([]);
  });

  it('refuses to synthesize input into a wedged app, and says a human must restart it', async () => {
    const { executor, log } = rig({ env: { FAKE_NO_WINDOW: '1' }, wedgedAfter: 1 });
    // The first read exhausts the monitor's patience.
    await executor.run(FEISHU_REPLY_TOOL, { text: 'first', chat: SELF_CHAT });
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'second', chat: SELF_CHAT });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('wedged');
    expect(result.error).toContain('restart Feishu');
    expect(keystrokes(log)).toEqual([]);
  });

  it('needs a target: no chat and no usable trace id is an error, not a guess', async () => {
    const { executor } = rig();
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'hello', trace_id: 'feishu-unknown' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('has no target');
  });

  it('rejects an empty reply', async () => {
    const { executor } = rig();
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: '', chat: SELF_CHAT });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('must not be empty');
  });

  it('does not repeat the same text to the same chat inside the dedupe window', async () => {
    const { executor, log } = rig();
    const first = await executor.run(FEISHU_REPLY_TOOL, { text: 'pong', chat: SELF_CHAT });
    expect((first.value as ReplyOutcome).sent).toBe(true);
    const before = keystrokes(log).length;

    const second = await executor.run(FEISHU_REPLY_TOOL, { text: 'pong', chat: SELF_CHAT });
    expect(second.ok).toBe(true);
    expect(second.value as ReplyOutcome).toMatchObject({ sent: false, deduped: true });
    expect(keystrokes(log)).toHaveLength(before);
  });

  it('sends the same text again once the window has passed', async () => {
    const { executor, setNow } = rig();
    await executor.run(FEISHU_REPLY_TOOL, { text: 'pong', chat: SELF_CHAT });
    setNow(1_000_000 + 30_001);
    const again = await executor.run(FEISHU_REPLY_TOOL, { text: 'pong', chat: SELF_CHAT });
    expect(again.value as ReplyOutcome).toMatchObject({ sent: true, deduped: false });
  });

  it('breaks lines with Shift+Enter, because a bare Enter would send half the reply', async () => {
    const { executor, log } = rig();
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'line one\nline two', chat: SELF_CHAT });
    expect(result.ok).toBe(true);
    expect(keystrokes(log).map((entry) => `${entry.key}${(entry.modifiers ?? []).join('+')}`)).toEqual([
      'acmd',
      'delete',
      'line one',
      'returnshift',
      'line two',
      'return',
    ]);
  });

  it('records what it sent, so the perceiver does not read it back as a new instruction', async () => {
    const { executor, ledger } = rig();
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'pong 2026-08-29T07:00:00Z', chat: SELF_CHAT });
    const echoed = (result.value as ReplyOutcome).echoedMessageId as string;
    expect(ledger.wasSentByUs({ id: echoed, text: 'pong 2026-08-29T07:00:00Z' })).toBe(true);
    expect(ledger.wasSentByUs({ id: 'someone-else', text: 'we ping' })).toBe(false);
  });

  it('claims only its own tool', () => {
    const { executor } = rig();
    expect(executor.supports(FEISHU_REPLY_TOOL)).toBe(true);
    expect(executor.supports('shell.date')).toBe(false);
    expect(executor.names()).toEqual([FEISHU_REPLY_TOOL]);
  });
});

describe('feishu.reply, awkward inputs', () => {
  it('rejects a reply that is only whitespace before touching Feishu', async () => {
    const { executor, log } = rig();
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: '   \n  ', chat: SELF_CHAT });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('must not be empty');
    expect(log).toEqual([]);
  });

  it('truncates an over-long reply rather than refusing to answer at all', async () => {
    const { executor, log } = rig();
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'x'.repeat(3_000), chat: SELF_CHAT });
    expect(result.ok).toBe(true);
    const typed = keystrokes(log).map((entry) => entry.key ?? '').find((key) => key.startsWith('xxx')) ?? '';
    expect(typed).toHaveLength(2_000);
    expect(typed.endsWith('…')).toBe(true);
  });
});
