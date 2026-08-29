import { describe, expect, it } from 'vitest';
import { loadFeishuTree } from './fixtures/feishuTree.js';
import {
  composerContent,
  contentFingerprint,
  isSelfChat,
  openChatArea,
  parseChatTitle,
  parseComposer,
  parseSnapshot,
} from '../src/perception/feishu/messages.js';
import type { AxNode } from '../src/perception/macos/axProtocol.js';
import { findAll, hasDomClass, textOf, walk } from '../src/perception/macos/axTree.js';

const PARSE = { now: 1_700_000_000_000, selfName: '曹良欢（Sion）' };
const evidence = loadFeishuTree();

describe('the evidence fixture', () => {
  it('loads the real dump as a tree with DOM metadata intact', () => {
    const nodes = [...walk(evidence)];
    expect(nodes.length).toBeGreaterThan(700);
    expect(findAll(evidence, hasDomClass('js-message-item'))).toHaveLength(7);
    expect(findAll(evidence, hasDomClass('a11y_feed_card_item'))).toHaveLength(18);
  });
});

describe('parsing a conversation out of Feishu', () => {
  it('finds the open chat by its web area title, not by position', () => {
    const chat = openChatArea(evidence);
    expect(chat?.title).toBe('messenger-chat');
    expect(openChatArea([{ nodeId: 1, role: 'AXWebArea', title: 'messenger' }])).toBeUndefined();
  });

  it('reads the conversation title from the header hook class', () => {
    const chat = openChatArea(evidence);
    expect(chat).toBeDefined();
    expect(parseChatTitle(chat as AxNode)).toBe('曹良欢（Sion）');
  });

  it('recognises the self-chat by the composer placeholder, which is its only tell', () => {
    const chat = openChatArea(evidence) as AxNode;
    const composer = parseComposer(chat);
    expect(composer.nodeId).toBeGreaterThan(0);
    expect(isSelfChat(composer.placeholder)).toBe(true);
    expect(isSelfChat('发送给 某位同事')).toBe(false);
  });

  it('reads every rendered message with its real Feishu id, direction and kind', () => {
    const snapshot = parseSnapshot(evidence, PARSE);
    expect(snapshot.hasOpenChat).toBe(true);
    expect(snapshot.isSelfChat).toBe(true);
    expect(snapshot.messages).toHaveLength(7);

    const last = snapshot.messages[6];
    expect(last?.id).toBe('7679345486104415420');
    expect(last?.fingerprint).toBe('7679345486104415420');
    expect(last?.text).toBe('[work-everything spike] hello');
    expect(last?.isSelf).toBe(true);
    expect(last?.kind).toBe('text-message');
    expect(last?.sender).toBe('曹良欢（Sion）');
    expect(last?.ts).toBe(PARSE.now);

    expect(snapshot.messages.map((message) => message.kind)).toEqual([
      'text-message',
      'file-message',
      'file-message',
      'file-message',
      'file-message',
      'file-message',
      'text-message',
    ]);
  });

  it('reads the composer through its text leaves, because AXValue is only the placeholder', () => {
    const chat = openChatArea(evidence) as AxNode;
    expect(parseComposer(chat).placeholder).toContain('可以向自己发送文件或转发消息');
    // Nothing was typed when the dump was taken, so the leaves are the placeholder.
    expect(composerContent(chat)).toContain('可以向自己发送文件或转发消息');
  });

  it('reports no open chat rather than an empty one when the window is not showing', () => {
    const snapshot = parseSnapshot([{ nodeId: 1, role: 'AXApplication', title: '飞书' }], PARSE);
    expect(snapshot.hasOpenChat).toBe(false);
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.composerNodeId).toBeUndefined();
  });
});

describe('message identity', () => {
  const incoming: AxNode = {
    nodeId: 1,
    role: 'AXWebArea',
    title: 'messenger-chat',
    children: [
      { nodeId: 2, role: 'AXGroup', domClasses: ['chatWindow_chatName'], children: [{ nodeId: 3, role: 'AXStaticText', value: '同事甲' }] },
      {
        nodeId: 4,
        role: 'AXGroup',
        domClasses: ['js-message-item', 'message-not-self', 'message-is-p2p', 'text-message'],
        children: [{ nodeId: 5, role: 'AXGroup', domClasses: ['message-content-container'], children: [{ nodeId: 6, role: 'AXStaticText', value: '在吗' }] }],
      },
    ],
  };

  it('attributes a one-to-one message to the person the chat is named after', () => {
    const snapshot = parseSnapshot([incoming], PARSE);
    expect(snapshot.messages[0]).toMatchObject({ sender: '同事甲', isSelf: false, text: '在吗' });
  });

  it('falls back to a content fingerprint when Feishu exposes no message id', () => {
    const snapshot = parseSnapshot([incoming], PARSE);
    const message = snapshot.messages[0];
    expect(message?.fingerprint).toBe(contentFingerprint('同事甲', false, 'text-message', '在吗'));
    expect(message?.fingerprint).toHaveLength(32);
    expect(message?.id).toBe(message?.fingerprint);
  });

  it('leaves a group sender empty rather than guessing it from the group name', () => {
    const group: AxNode = {
      ...incoming,
      children: [
        incoming.children?.[0] as AxNode,
        { ...(incoming.children?.[1] as AxNode), domClasses: ['js-message-item', 'message-not-self', 'text-message'] },
      ],
    };
    expect(parseSnapshot([group], PARSE).messages[0]?.sender).toBe('');
  });
});

describe('tree helpers', () => {
  it('collects text from leaves in visual order and ignores containers', () => {
    const node: AxNode = {
      nodeId: 1,
      role: 'AXGroup',
      value: 'ignored, containers do not carry the words',
      children: [
        { nodeId: 2, role: 'AXStaticText', value: 'hello ' },
        { nodeId: 3, role: 'AXGroup', children: [{ nodeId: 4, role: 'AXStaticText', value: 'world' }] },
      ],
    };
    expect(textOf(node, 'AXStaticText')).toBe('hello world');
  });

  it('matches a DOM class only when every requested class is present', () => {
    const node: AxNode = { nodeId: 1, role: 'AXGroup', domClasses: ['a', 'b'] };
    expect(hasDomClass('a', 'b')(node)).toBe(true);
    expect(hasDomClass('a', 'c')(node)).toBe(false);
    expect(hasDomClass('a')({ nodeId: 2, role: 'AXGroup' })).toBe(false);
  });
});
