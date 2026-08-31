import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AxBridgeClient } from '../src/perception/macos/axBridge.js';
import { FeishuReader, feishuHealthMonitor } from '../src/perception/feishu/reader.js';
import { ChatRouteTable } from '../src/perception/feishu/chatRoutes.js';
import { SentLedger } from '../src/perception/feishu/sentLedger.js';
import { FeishuExecutor, FEISHU_REPLY_TOOL } from '../src/execution/feishu/sender.js';
import type { ReplyOutcome } from '../src/execution/feishu/sender.js';
import { ActionRegistry } from '../src/actions/registry.js';
import { SnapshotStore } from '../src/actions/snapshot.js';
import { AutoWait } from '../src/actions/wait.js';
import { bridgeKeyboardRoute } from '../src/actions/keyboard.js';
import { MacAxDriver } from '../src/actions/drivers/macAx.js';

const helper = fileURLToPath(new URL('./fixtures/fakeFeishuAx.mjs', import.meta.url));
const SELF_CHAT = '曹良欢（Sion）';
const FEISHU = 'com.bytedance.macos.feishu';

interface LogEntry {
  op: string;
  key?: string;
  modifiers?: string[];
  nodeId?: number;
  text?: string;
  replace?: boolean;
}

interface Rig {
  readonly executor: FeishuExecutor;
  readonly routes: ChatRouteTable;
  readonly ledger: SentLedger;
  readonly client: AxBridgeClient;
  /** Every op the fake bridge was asked to perform, in order. */
  readonly log: LogEntry[];
  setNow: (ms: number) => void;
}

let open: AxBridgeClient | undefined;

afterEach(async () => {
  await open?.stop();
  open = undefined;
});

function rig(
  options: { env?: NodeJS.ProcessEnv; allowedChats?: readonly string[]; wedgedAfter?: number; realTime?: boolean; screenSaver?: boolean } = {},
): Rig {
  const log: LogEntry[] = [];
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
      for (const line of lines) if (line.startsWith('LOG ')) log.push(JSON.parse(line.slice(4)) as LogEntry);
    });
    return child;
  };

  const client = new AxBridgeClient({ binaryPath: '/nonexistent/we-ax', requestTimeoutMs: 4_000, spawnFn });
  client.start();
  open = client;

  let now = 1_000_000;
  const clock = { now: () => now, sleep: async (): Promise<void> => undefined };
  const reader = new FeishuReader(client, { bundleId: FEISHU, appPath: '/Applications/Lark.app', selfName: SELF_CHAT, now: () => now });
  const routes = new ChatRouteTable();
  const ledger = new SentLedger();
  const monitor = feishuHealthMonitor(client, reader, {
    config: { wedgedAfter: options.wedgedAfter ?? 3 },
    // Injected so a unit test never shells out, and never depends on whether
    // this machine happens to have a screen saver running.
    screenSaverRunning: async () => options.screenSaver === true,
  });

  const snapshots = new SnapshotStore();
  const actions = new ActionRegistry([
    new MacAxDriver({
      client,
      keyboard: bridgeKeyboardRoute(client),
      snapshots,
      wait: new AutoWait({ settleMs: 0, maxWaitMs: 0, pollMs: 0 }, clock),
      clock,
      config: { treeTimeoutMs: 200, treePollMs: 1 },
    }),
  ]);

  const executor = new FeishuExecutor({
    actions,
    snapshots,
    reader,
    monitor,
    routes,
    ledger,
    config: {
      app: FEISHU,
      allowedChats: options.allowedChats ?? [SELF_CHAT],
      dedupeWindowMs: 30_000,
      echoTimeoutMs: options.realTime === true ? 5 : 200,
      echoIntervalMs: options.realTime === true ? 1 : 10,
      maxTextLength: 2_000,
    },
    // Left on the real clock for the paths whose timing is the thing under
    // test; everything else is frozen so a test never waits.
    ...(options.realTime === true ? {} : { now: () => now, sleep: async (): Promise<void> => undefined }),
  });

  return { executor, routes, ledger, client, log, setNow: (ms) => (now = ms) };
}

/** Anything that could reach the app as input. Reads are not in here. */
const INPUT_OPS = new Set(['focusAndType', 'keystroke', 'click', 'setValue']);
const inputs = (log: readonly LogEntry[]): LogEntry[] => log.filter((entry) => INPUT_OPS.has(entry.op));

/** One readable line per input operation, for asserting on the whole sequence. */
function sequence(log: readonly LogEntry[]): string[] {
  return inputs(log).map((entry) => {
    if (entry.op === 'focusAndType') {
      return `type@${entry.nodeId ?? '?'} ${entry.text ?? ''}`;
    }
    if (entry.op === 'keystroke') return `key ${[...(entry.modifiers ?? []), entry.key].join('+')}`;
    return `${entry.op} ${entry.nodeId ?? ''}`;
  });
}

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

    // Focus and typing are one operation against the composer's own element,
    // and only then the send key. No accessibility write anywhere.
    expect(sequence(log)).toEqual(['type@400 ', 'key cmd+a', 'key delete', 'type@400 pong 2026-08-29T07:00:00Z', 'key return']);
  });

  it('never writes with setValue, which reports success on a contenteditable and types nothing', async () => {
    const { executor, log } = rig();
    await executor.run(FEISHU_REPLY_TOOL, { text: 'pong', chat: SELF_CHAT });
    expect(log.some((entry) => entry.op === 'setValue')).toBe(false);
    expect(log.some((entry) => entry.op === 'focusAndType')).toBe(true);
  });

  it('refuses a conversation that is not on the allowlist, and sends no input', async () => {
    const { executor, log } = rig({ allowedChats: [] });
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'hello', chat: '同事甲' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('feishu.allowedChats');
    expect(inputs(log)).toEqual([]);
  });

  it('refuses when the conversation on screen is not the one being answered', async () => {
    const { executor, log } = rig({ allowedChats: ['同事甲'], env: { FAKE_CHAT_TITLE: SELF_CHAT } });
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'hello', chat: '同事甲' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('refusing to send into the wrong chat');
    expect(inputs(log)).toEqual([]);
  });

  it('sends nothing at all when the caret cannot be confirmed inside the composer', async () => {
    // The helper verifies that focus actually landed rather than trusting the
    // call that claimed it did — on a contenteditable, setting AXFocused
    // returns success and does nothing. A claim that cannot be proven is a
    // refusal, and a refusal means no key was posted.
    const { executor, log } = rig({ env: { FAKE_FOCUS_FAILS: '1' } });
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'hello', chat: SELF_CHAT });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no keys were sent');
    expect(result.error).toContain('did not land on the element');
    // The very first thing done to the composer is the focus, and it refused.
    // Not one key followed it — including the select-all that would otherwise
    // have gone to whatever window was listening.
    expect(sequence(log)).toEqual(['type@400 ']);
  });

  it('reports the tray state instead of typing into a window that is not there', async () => {
    const { executor, log } = rig({ env: { FAKE_NO_WINDOW: '1' } });
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'hello', chat: SELF_CHAT });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no window');
    expect(inputs(log)).toEqual([]);
  });

  it('refuses to synthesize input into a wedged app, and says a human must restart it', async () => {
    // A window the helper can address, with no web content in it. That — not
    // an empty window list — is what a dead accessibility layer looks like.
    const { executor, log } = rig({ env: { FAKE_NO_WEB_AREA: '1' }, wedgedAfter: 1 });
    // The first read exhausts the monitor's patience.
    await executor.run(FEISHU_REPLY_TOOL, { text: 'first', chat: SELF_CHAT });
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'second', chat: SELF_CHAT });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('wedged');
    expect(result.error).toContain('restart Feishu');
    expect(inputs(log)).toEqual([]);
  });

  it('tells a person to unlock the Mac when that is what is wrong, and stops', async () => {
    const { executor, log } = rig({ env: { FAKE_WINDOW_DIAGNOSIS: 'SCREEN_LOCKED' } });
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'hello', chat: SELF_CHAT });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unlock');
    expect(result.error).not.toContain('restart');
    expect(inputs(log)).toEqual([]);
  });

  it('does not tell a person to unlock a Mac that is not locked', async () => {
    // A running screen saver takes accessibility windows away from every
    // application while the session stays unlocked. Reported as a lock, the
    // advice would be wrong and the person would go looking for a password.
    const { executor, log } = rig({ env: { FAKE_WINDOW_DIAGNOSIS: 'NOT_DRAWN' }, screenSaver: true });
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'hello', chat: SELF_CHAT });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('screen saver');
    expect(result.error).toContain('not locked');
    expect(result.error).toContain('25 on screen machine-wide across 8 process');
    expect(inputs(log)).toEqual([]);
  });

  it('still reports a desktop that is genuinely drawing nothing', async () => {
    const { executor } = rig({ env: { FAKE_WINDOW_DIAGNOSIS: 'DESKTOP_BLANK' } });
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'hello', chat: SELF_CHAT });
    expect(result.error).toContain('nothing on this machine is being drawn');
  });

  it('separates a screen saver from this app not being drawn, on the same reading', async () => {
    // Same helper answer both times — the measured one, scope "application".
    // What separates them is whether a screen saver is actually running, which
    // is the only direct evidence there is.
    const covered = rig({ env: { FAKE_WINDOW_DIAGNOSIS: 'NOT_DRAWN' }, screenSaver: true });
    const running = await covered.executor.run(FEISHU_REPLY_TOOL, { text: 'hello', chat: SELF_CHAT });
    expect(running.error).toContain('screen saver');
    expect(running.error).toContain('not locked');
    expect(inputs(covered.log)).toEqual([]);

    const plain = rig({ env: { FAKE_WINDOW_DIAGNOSIS: 'NOT_DRAWN' } });
    const idle = await plain.executor.run(FEISHU_REPLY_TOOL, { text: 'hello', chat: SELF_CHAT });
    expect(idle.error).toContain('another space');
    expect(idle.error).not.toContain('screen saver');
    expect(inputs(plain.log)).toEqual([]);
  });

  it('never asks the app to come to the front', async () => {
    const { executor, log } = rig({ env: { FAKE_NO_WINDOW: '1' } });
    await executor.run(FEISHU_REPLY_TOOL, { text: 'hello', chat: SELF_CHAT });
    // Nothing in the send path raises, activates or reopens anything.
    expect(log.map((entry) => entry.op)).not.toContain('activate');
    expect(inputs(log)).toEqual([]);
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
    const before = inputs(log).length;

    const second = await executor.run(FEISHU_REPLY_TOOL, { text: 'pong', chat: SELF_CHAT });
    expect(second.ok).toBe(true);
    expect(second.value as ReplyOutcome).toMatchObject({ sent: false, deduped: true });
    expect(inputs(log)).toHaveLength(before);
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
    expect(sequence(log)).toEqual([
      'type@400 ',
      'key cmd+a',
      'key delete',
      'type@400 line one',
      'key shift+return',
      'type@400 line two',
      'key return',
    ]);
  });

  it('records what it sent, so the perceiver does not read it back as a new instruction', async () => {
    const { executor, ledger } = rig();
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'pong 2026-08-29T07:00:00Z', chat: SELF_CHAT });
    const echoed = (result.value as ReplyOutcome).echoedMessageId as string;
    expect(ledger.wasSentByUs({ id: echoed, text: 'pong 2026-08-29T07:00:00Z' })).toBe(true);
    expect(ledger.wasSentByUs({ id: 'someone-else', text: 'we ping' })).toBe(false);
  });

  it('clears the composer and sends nothing when the text did not actually land', async () => {
    // The failure this whole path exists for: a write that reports success and
    // leaves the composer empty. Enter must never follow it.
    const { executor, log, ledger } = rig({ env: { FAKE_SWALLOW_TEXT: '1' } });
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'pong', chat: SELF_CHAT });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('nothing was sent');
    expect(sequence(log)).toEqual([
      'type@400 ',
      'key cmd+a',
      'key delete',
      'type@400 pong',
      // and the clear that follows, which is a focus and the same two keys
      'type@400 ',
      'key cmd+a',
      'key delete',
    ]);
    expect(log.some((entry) => entry.op === 'keystroke' && entry.key === 'return')).toBe(false);
    expect(ledger.wasSentByUs({ id: 'x', text: 'pong' })).toBe(false);
  });

  it('refuses when no conversation is open at all', async () => {
    const { executor, log } = rig({ env: { FAKE_CHAT_CLOSED: '1' } });
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'pong', chat: SELF_CHAT });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no Feishu conversation is open');
    expect(inputs(log)).toEqual([]);
  });

  it('reports the send even when the conversation never echoes it back', async () => {
    // The message left; the id did not come back. That is a send with an
    // unknown id, not a failure, and the ledger still has to know about it.
    const { executor, ledger, log } = rig({ env: { FAKE_NO_ECHO: '1' }, realTime: true });
    const result = await executor.run(FEISHU_REPLY_TOOL, { text: 'pong', chat: SELF_CHAT });
    expect(result.ok).toBe(true);
    expect(result.value as ReplyOutcome).toMatchObject({ sent: true, echoedMessageId: undefined });
    expect(ledger.wasSentByUs({ id: 'anything', text: 'pong' })).toBe(true);
    expect(sequence(log)).toEqual(['type@400 ', 'key cmd+a', 'key delete', 'type@400 pong', 'key return']);
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
    const typed = inputs(log)
      .map((entry) => entry.text ?? '')
      .find((text) => text.startsWith('xxx')) ?? '';
    expect(typed).toHaveLength(2_000);
    expect(typed.endsWith('…')).toBe(true);
  });
});
