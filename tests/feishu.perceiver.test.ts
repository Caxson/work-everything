import { describe, expect, it } from 'vitest';
import { FeishuPerceiver } from '../src/perception/feishu/perceiver.js';
import { ChatRouteTable } from '../src/perception/feishu/chatRoutes.js';
import { SentLedger } from '../src/perception/feishu/sentLedger.js';
import { FeishuHealthMonitor, type FeishuHealth } from '../src/perception/feishu/health.js';
import type { ChatSnapshot, FeishuMessage } from '../src/perception/feishu/messages.js';
import type { FeishuReader } from '../src/perception/feishu/reader.js';
import type { AxBridgeClient } from '../src/perception/macos/axBridge.js';
import type { Event } from '../src/core/events.js';

const SELF_CHAT = '曹良欢（Sion）';

function message(overrides: Partial<FeishuMessage>): FeishuMessage {
  return {
    id: 'm1',
    fingerprint: 'm1',
    chatTitle: SELF_CHAT,
    sender: '曹良欢（Sion）',
    text: 'we ping',
    ts: 1_700_000_000_000,
    isSelf: false,
    kind: 'text-message',
    ...overrides,
  };
}

function snapshot(chatTitle: string, messages: readonly FeishuMessage[], isSelfChat = true): ChatSnapshot {
  return { hasOpenChat: true, chatTitle, isSelfChat, composerNodeId: 400, composerText: '', messages };
}

/** A bridge that answers just enough for the perceiver to subscribe. */
function fakeClient(): AxBridgeClient {
  return {
    start: () => undefined,
    trusted: async () => true,
    enableAX: async () => undefined,
    observe: async () => 1,
    unobserve: async () => undefined,
    onNotification: () => () => undefined,
  } as unknown as AxBridgeClient;
}

/** A monitor that always reports the app as readable. */
function healthyMonitor(pid = 4242): FeishuHealthMonitor {
  return new FeishuHealthMonitor({
    pid: async () => pid,
    windows: async () => [{ nodeId: 1, role: 'AXWindow', title: '飞书' }],
    webAreas: async () => [{ nodeId: 2, role: 'AXWebArea', title: 'messenger-chat' }],
    screenLocked: async () => false,
    requestWindow: async () => undefined,
  });
}

/** A reader that hands back a scripted sequence of snapshots. */
function fakeReader(script: readonly ChatSnapshot[]): FeishuReader {
  let index = 0;
  return {
    pid: async () => 4242,
    snapshot: async () => script[Math.min(index++, script.length - 1)] as ChatSnapshot,
  } as unknown as FeishuReader;
}

async function collect(perceiver: FeishuPerceiver, timeoutMs = 300): Promise<readonly Event[]> {
  const controller = new AbortController();
  const events: Event[] = [];
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for await (const event of perceiver.events(controller.signal)) events.push(event);
  } finally {
    clearTimeout(timer);
    await perceiver.close();
  }
  return events;
}

function build(
  script: readonly ChatSnapshot[],
  allowedChats: readonly string[],
  ledger = new SentLedger(),
): { perceiver: FeishuPerceiver; routes: ChatRouteTable; ledger: SentLedger } {
  const routes = new ChatRouteTable();
  const perceiver = new FeishuPerceiver({
    client: fakeClient(),
    reader: fakeReader(script),
    monitor: healthyMonitor(),
    routes,
    ledger,
    config: { allowedChats, pollIntervalMs: 5, debounceMs: 0, memory: 100 },
    onWarn: () => undefined,
  });
  return { perceiver, routes, ledger };
}

describe('the Feishu perceiver', () => {
  it('treats the conversation it finds on screen as history, not as news', async () => {
    const history = snapshot(SELF_CHAT, [message({ id: 'old', fingerprint: 'old', isSelf: false })]);
    const { perceiver } = build([history], [SELF_CHAT]);
    expect(await collect(perceiver, 120)).toEqual([]);
  });

  it('emits a message that arrives after priming, in an allowed conversation', async () => {
    const first = snapshot(SELF_CHAT, [message({ id: 'old', fingerprint: 'old' })]);
    const second = snapshot(SELF_CHAT, [message({ id: 'old', fingerprint: 'old' }), message({ id: 'new', fingerprint: 'new', text: 'we ping' })]);
    const { perceiver, routes } = build([first, second], [SELF_CHAT]);

    const events = await collect(perceiver, 200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: 'feishu', kind: 'message', traceId: 'feishu-new' });
    expect(events[0]?.payload).toMatchObject({ text: 'we ping', chat: SELF_CHAT, messageId: 'new', isSelf: false });
    expect(routes.lookup('feishu-new')).toMatchObject({ chatTitle: SELF_CHAT, messageId: 'new' });
  });

  it('never emits a message this daemon sent, which is what stops it answering itself', async () => {
    const ledger = new SentLedger();
    ledger.record('pong 2026-08-29T00:00:00Z');
    const first = snapshot(SELF_CHAT, [message({ id: 'old', fingerprint: 'old' })]);
    const second = snapshot(SELF_CHAT, [
      message({ id: 'old', fingerprint: 'old' }),
      message({ id: 'mine', fingerprint: 'mine', isSelf: true, text: 'pong 2026-08-29T00:00:00Z' }),
    ]);
    const { perceiver } = build([first, second], [SELF_CHAT], ledger);
    expect(await collect(perceiver, 200)).toEqual([]);
  });

  it('reacts to what the user types in a chat with themselves, where every message is theirs', async () => {
    const first = snapshot(SELF_CHAT, []);
    const second = snapshot(SELF_CHAT, [message({ id: 'cmd', fingerprint: 'cmd', isSelf: true, text: 'we ping' })]);
    const { perceiver } = build([first, second], [SELF_CHAT]);

    const events = await collect(perceiver, 200);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ text: 'we ping', isSelf: true });
  });

  it('ignores what the user says to a colleague: that is a conversation, not a command', async () => {
    const first = snapshot('同事甲', [], false);
    const second = snapshot('同事甲', [message({ id: 'mine', fingerprint: 'mine', chatTitle: '同事甲', isSelf: true, text: '好的' })], false);
    const { perceiver } = build([first, second], ['同事甲']);
    expect(await collect(perceiver, 200)).toEqual([]);
  });

  it('still reacts to the colleague’s own messages in that same conversation', async () => {
    const first = snapshot('同事甲', [], false);
    const second = snapshot('同事甲', [message({ id: 'theirs', fingerprint: 'theirs', chatTitle: '同事甲', isSelf: false, text: '在吗' })], false);
    const { perceiver } = build([first, second], ['同事甲']);
    expect(await collect(perceiver, 200)).toHaveLength(1);
  });

  it('emits nothing for a conversation that is not on the allowlist', async () => {
    const first = snapshot('同事甲', [message({ id: 'old', fingerprint: 'old', chatTitle: '同事甲' })]);
    const second = snapshot('同事甲', [
      message({ id: 'old', fingerprint: 'old', chatTitle: '同事甲' }),
      message({ id: 'new', fingerprint: 'new', chatTitle: '同事甲', text: '在吗' }),
    ]);
    const { perceiver } = build([first, second], [SELF_CHAT]);
    expect(await collect(perceiver, 200)).toEqual([]);
  });

  it('emits nothing at all when the allowlist is empty, which is the default', async () => {
    const first = snapshot(SELF_CHAT, []);
    const second = snapshot(SELF_CHAT, [message({ id: 'new', fingerprint: 'new' })]);
    const { perceiver } = build([first, second], []);
    expect(await collect(perceiver, 200)).toEqual([]);
  });

  it('emits a given message once, however many times it is read', async () => {
    const first = snapshot(SELF_CHAT, []);
    const withMessage = snapshot(SELF_CHAT, [message({ id: 'new', fingerprint: 'new' })]);
    const { perceiver } = build([first, withMessage, withMessage, withMessage, withMessage], [SELF_CHAT]);
    expect(await collect(perceiver, 250)).toHaveLength(1);
  });

  it('ignores an empty message rather than routing a blank request', async () => {
    const first = snapshot(SELF_CHAT, []);
    const second = snapshot(SELF_CHAT, [message({ id: 'blank', fingerprint: 'blank', text: '   ' })]);
    const { perceiver } = build([first, second], [SELF_CHAT]);
    expect(await collect(perceiver, 200)).toEqual([]);
  });

  it('survives a read that throws instead of taking the daemon down with it', async () => {
    const routes = new ChatRouteTable();
    const warnings: string[] = [];
    let calls = 0;
    const reader = {
      pid: async () => 4242,
      snapshot: async () => {
        calls += 1;
        if (calls === 1) throw new Error('Feishu shows no window');
        return snapshot(SELF_CHAT, []);
      },
    } as unknown as FeishuReader;

    const perceiver = new FeishuPerceiver({
      client: fakeClient(),
      reader,
      monitor: healthyMonitor(),
      routes,
      ledger: new SentLedger(),
      config: { allowedChats: [SELF_CHAT], pollIntervalMs: 5, debounceMs: 0, memory: 100 },
      onWarn: (message_) => warnings.push(message_),
    });

    expect(await collect(perceiver, 150)).toEqual([]);
    expect(warnings.join('\n')).toContain('no window');
    expect(calls).toBeGreaterThan(1);
  });
});

describe('the chat route table', () => {
  it('remembers where an event came from and forgets the oldest first', () => {
    const routes = new ChatRouteTable(2);
    routes.remember('a', { chatTitle: 'A', messageId: '1', ts: 1 });
    routes.remember('b', { chatTitle: 'B', messageId: '2', ts: 2 });
    routes.remember('c', { chatTitle: 'C', messageId: '3', ts: 3 });
    expect(routes.size).toBe(2);
    expect(routes.lookup('a')).toBeUndefined();
    expect(routes.lookup('c')?.chatTitle).toBe('C');
  });
});

describe('the perceiver’s health gate', () => {
  function withMonitor(monitor: FeishuHealthMonitor): { perceiver: FeishuPerceiver; warnings: string[]; fatal: FeishuHealth[]; reads: () => number } {
    let reads = 0;
    const reader = {
      pid: async () => 4242,
      snapshot: async () => {
        reads += 1;
        return snapshot(SELF_CHAT, [message({ id: 'x', fingerprint: 'x' })]);
      },
    } as unknown as FeishuReader;
    const warnings: string[] = [];
    const fatal: FeishuHealth[] = [];
    const perceiver = new FeishuPerceiver({
      client: fakeClient(),
      reader,
      monitor,
      routes: new ChatRouteTable(),
      ledger: new SentLedger(),
      config: { allowedChats: [SELF_CHAT], pollIntervalMs: 5, debounceMs: 0, memory: 100 },
      onWarn: (line) => warnings.push(line),
      onFatal: (health) => fatal.push(health),
    });
    return { perceiver, warnings, fatal, reads: () => reads };
  }

  const trayed = (wedgedAfter: number): FeishuHealthMonitor =>
    new FeishuHealthMonitor({
      pid: async () => 4242,
      windows: async () => [],
      webAreas: async () => [],
      screenLocked: async () => false,
      requestWindow: async () => undefined,
      config: { wedgedAfter },
    });

  it('does not read Feishu at all while it has no window', async () => {
    const { perceiver, warnings, reads } = withMonitor(trayed(1_000));
    expect(await collect(perceiver, 120)).toEqual([]);
    expect(reads()).toBe(0);
    expect(warnings.join('\n')).toContain('tray');
  });

  it('ends the stream on a wedged app instead of retrying it forever', async () => {
    const { perceiver, fatal, warnings } = withMonitor(trayed(1));
    expect(await collect(perceiver, 300)).toEqual([]);
    expect(fatal).toHaveLength(1);
    expect(fatal[0]?.state).toBe('wedged');
    expect(warnings.join('\n')).toContain('restart Feishu');
  });

  it('says a locked screen out loud once, not on every poll', async () => {
    const locked = new FeishuHealthMonitor({
      pid: async () => 4242,
      windows: async () => [],
      webAreas: async () => [],
      screenLocked: async () => true,
      requestWindow: async () => undefined,
    });
    const { perceiver, warnings, fatal } = withMonitor(locked);
    expect(await collect(perceiver, 200)).toEqual([]);
    expect(warnings.filter((line) => line.includes('screen is locked'))).toHaveLength(1);
    expect(fatal).toEqual([]);
  });
});

describe('the sent ledger', () => {
  it('recognises its own message by the id read back after sending', () => {
    const ledger = new SentLedger();
    ledger.record('pong 1', '76001');
    expect(ledger.wasSentByUs({ id: '76001', text: 'anything at all' })).toBe(true);
  });

  it('falls back to the text when the read-back never resolved', () => {
    const ledger = new SentLedger();
    ledger.record('pong 2026-08-29T07:00:00Z');
    expect(ledger.wasSentByUs({ id: 'unknown', text: 'pong 2026-08-29T07:00:00Z' })).toBe(true);
    expect(ledger.wasSentByUs({ id: 'unknown', text: 'we ping' })).toBe(false);
  });

  it('stops suppressing a text once the window has passed, so a real repeat still counts', () => {
    let now = 1_000;
    const ledger = new SentLedger({ windowMs: 1_000, capacity: 10 }, () => now);
    ledger.record('pong');
    expect(ledger.wasSentByUs({ id: 'x', text: 'pong' })).toBe(true);
    now += 1_001;
    expect(ledger.wasSentByUs({ id: 'x', text: 'pong' })).toBe(false);
  });

  it('never claims an empty message as its own', () => {
    const ledger = new SentLedger();
    ledger.record('');
    expect(ledger.wasSentByUs({ id: 'x', text: '   ' })).toBe(false);
  });
});
