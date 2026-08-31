import { describe, expect, it } from 'vitest';
import { parseScenario } from '../src/core/scenario.js';
import type { Scenario } from '../src/core/scenario.js';
import { ChatRouteTable } from '../src/perception/feishu/chatRoutes.js';
import { FEISHU_REPLY_CHAIN, FEISHU_REPLY_TOOL } from '../src/execution/feishu/sender.js';
import {
  FEISHU_REPLY_PREMISE,
  feishuReplyCapture,
  feishuReplyChecker,
  type OpenConversation,
  type ReplyPremiseDeps,
} from '../src/execution/feishu/replyPremise.js';

const CHAT = 'Ops';
const OTHER = 'Someone Else';

function routes(entries: readonly (readonly [string, string, string])[] = [['feishu-1', CHAT, 'msg-1']]): ChatRouteTable {
  const table = new ChatRouteTable();
  for (const [traceId, chatTitle, messageId] of entries) table.remember(traceId, { chatTitle, messageId, ts: 1 });
  return table;
}

const chainOf = (...steps: readonly { tool: string; args: Record<string, string> }[]): Scenario =>
  parseScenario({ id: 'reply', name: 'reply', chain: steps });

describe('capturing what a queued reply assumed', () => {
  it('pins the conversation from the event, not from whatever is on screen', () => {
    const capture = feishuReplyCapture({ routes: routes() })({
      traceId: 'feishu-1',
      chain: FEISHU_REPLY_CHAIN,
      vars: { text: 'pong', trace_id: 'feishu-1' },
    });

    expect(capture?.precondition.kind).toBe(FEISHU_REPLY_PREMISE);
    expect(capture?.precondition.facts).toEqual({ chat: CHAT, originTraceId: 'feishu-1', originMessageId: 'msg-1', targetFrom: 'origin' });
    expect(capture?.purpose).toBe("reply in 'Ops' to feishu-1: pong");
  });

  it('prefers an explicitly named chat over the routed one', () => {
    const capture = feishuReplyCapture({ routes: routes() })({
      traceId: 'feishu-1',
      chain: chainOf({ tool: FEISHU_REPLY_TOOL, args: { text: '$text', chat: 'Named Chat' } }),
      vars: { text: 'pong' },
    });
    expect(capture?.precondition.facts['chat']).toBe('Named Chat');
    // Recorded as explicit, because a chain that names its own conversation was
    // never answering the sender of the event.
    expect(capture?.precondition.facts['targetFrom']).toBe('explicit');
  });

  it('shortens a long reply in the purpose so `we queue` stays readable', () => {
    const capture = feishuReplyCapture({ routes: routes() })({
      traceId: 'feishu-1',
      chain: FEISHU_REPLY_CHAIN,
      vars: { text: 'x'.repeat(200), trace_id: 'feishu-1' },
    });
    expect(capture?.purpose.endsWith('…')).toBe(true);
    expect(capture?.purpose.length).toBeLessThan(120);
  });

  it('declines a chain that sends no reply', () => {
    const capture = feishuReplyCapture({ routes: routes() })({
      traceId: 'a',
      chain: chainOf({ tool: 'clock.now', args: {} }),
      vars: {},
    });
    expect(capture).toBeUndefined();
  });

  it('declines a chain with two replies, whose target would be a guess', () => {
    const capture = feishuReplyCapture({ routes: routes() })({
      traceId: 'feishu-1',
      chain: chainOf(
        { tool: FEISHU_REPLY_TOOL, args: { text: 'one', trace_id: '$trace_id' } },
        { tool: FEISHU_REPLY_TOOL, args: { text: 'two', trace_id: '$trace_id' } },
      ),
      vars: { trace_id: 'feishu-1' },
    });
    expect(capture).toBeUndefined();
  });

  it('declines when the target is still a template an earlier step has to produce', () => {
    // Pinning `$chat` now would pin the literal, not the conversation.
    const capture = feishuReplyCapture({ routes: routes() })({
      traceId: 'feishu-1',
      chain: chainOf({ tool: FEISHU_REPLY_TOOL, args: { text: 'pong', chat: '$chat' } }),
      vars: {},
    });
    expect(capture).toBeUndefined();
  });

  it('declines when nothing knows which conversation the event came from', () => {
    const capture = feishuReplyCapture({ routes: routes([]) })({
      traceId: 'feishu-1',
      chain: FEISHU_REPLY_CHAIN,
      vars: { text: 'pong', trace_id: 'feishu-1' },
    });
    expect(capture).toBeUndefined();
  });
});

describe("re-checking a queued reply's premise", () => {
  function deps(over: Partial<ReplyPremiseDeps> = {}): ReplyPremiseDeps {
    const open: OpenConversation = { title: CHAT, messageIds: ['msg-1', 'msg-2'] };
    return {
      allowedChats: () => [CHAT],
      routes: routes(),
      recordedChat: () => undefined,
      openConversation: async () => open,
      ...over,
    };
  }

  const facts = (over: Record<string, string> = {}): Record<string, string> => ({
    chat: CHAT,
    originTraceId: 'feishu-1',
    originMessageId: 'msg-1',
    ...over,
  });

  it('holds when the conversation is the one it was aimed at and the message is still there', async () => {
    const verdict = await feishuReplyChecker(deps())(facts());
    expect(verdict.state).toBe('holds');
    expect(verdict.detail).toContain("'Ops' is open");
  });

  it('breaks when the target has left the allowlist while the daemon waited', async () => {
    const verdict = await feishuReplyChecker(deps({ allowedChats: () => [] }))(facts());
    expect(verdict.state).toBe('broken');
    expect(verdict.detail).toContain('no longer in feishu.allowedChats');
  });

  it('breaks when the event turns out to have come from a different conversation', async () => {
    // The failure that actually matters: a reply going to the wrong person.
    const verdict = await feishuReplyChecker(deps({ routes: routes([['feishu-1', OTHER, 'msg-9']]) }))(facts());
    expect(verdict.state).toBe('broken');
    expect(verdict.detail).toContain("came from 'Someone Else'");
  });

  it('breaks when the conversation the reply answers can no longer be identified', async () => {
    const verdict = await feishuReplyChecker(deps({ routes: routes([]) }))(facts());
    expect(verdict.state).toBe('broken');
    expect(verdict.detail).toContain('can no longer be identified');
  });

  it('falls back to the trajectory after a restart, when the route table is empty', async () => {
    // The route table is in-memory and bounded; the origin event's own record
    // is what survives, and it is what makes a restored queue usable at all.
    const verdict = await feishuReplyChecker(deps({ routes: routes([]), recordedChat: () => CHAT }))(facts());
    expect(verdict.state).toBe('holds');
  });

  it('breaks when the durable record disagrees with the queued target', async () => {
    const verdict = await feishuReplyChecker(deps({ routes: routes([]), recordedChat: () => OTHER }))(facts());
    expect(verdict.state).toBe('broken');
    expect(verdict.detail).toContain("came from 'Someone Else'");
  });

  it('breaks on a queued reply that names no conversation at all', async () => {
    const verdict = await feishuReplyChecker(deps())(facts({ chat: '' }));
    expect(verdict.state).toBe('broken');
    expect(verdict.detail).toContain('names no conversation');
  });

  it('waits when the target is not the conversation on screen', async () => {
    // Recoverable, so it waits: this daemon never switches conversations by
    // itself, and dropping the reply would punish it for the user scrolling.
    const verdict = await feishuReplyChecker(deps({ openConversation: async () => ({ title: OTHER, messageIds: [] }) }))(facts());
    expect(verdict.state).toBe('not_yet');
    expect(verdict.detail).toContain("'Someone Else' is");
  });

  it('waits, and says so plainly, when no conversation is open', async () => {
    const verdict = await feishuReplyChecker(deps({ openConversation: async () => ({ title: '', messageIds: [] }) }))(facts());
    expect(verdict.state).toBe('not_yet');
    expect(verdict.detail).toContain('no conversation is open');
  });

  it('waits when the message being answered is not visible in the conversation', async () => {
    const verdict = await feishuReplyChecker(deps({ openConversation: async () => ({ title: CHAT, messageIds: ['msg-7'] }) }))(facts());
    expect(verdict.state).toBe('not_yet');
    expect(verdict.detail).toContain('msg-1');
  });

  it('does not demand a message id it was never given', async () => {
    const verdict = await feishuReplyChecker(deps({ openConversation: async () => ({ title: CHAT, messageIds: [] }) }))(
      facts({ originMessageId: '' }),
    );
    expect(verdict.state).toBe('holds');
  });

  it('waits when the conversation cannot be read at all', async () => {
    const verdict = await feishuReplyChecker(
      deps({
        openConversation: async () => {
          throw new Error('the ax bridge is not running');
        },
      }),
    )(facts());
    expect(verdict.state).toBe('not_yet');
    expect(verdict.detail).toContain('the ax bridge is not running');
  });

  it('checks the target before it reads the screen, so a wrong recipient never costs a read', async () => {
    let reads = 0;
    const verdict = await feishuReplyChecker(
      deps({
        allowedChats: () => [],
        openConversation: async () => {
          reads += 1;
          return { title: CHAT, messageIds: [] };
        },
      }),
    )(facts());
    expect(verdict.state).toBe('broken');
    expect(reads).toBe(0);
  });
});
