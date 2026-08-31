import { describe, expect, it } from 'vitest';
import { locateOpenChat } from '../src/perception/feishu/elements.js';
import { flattenAxTree } from '../src/actions/drivers/macAxTree.js';
import { subtreeText } from '../src/actions/snapshot.js';
import { loadFeishuTree } from './fixtures/feishuTree.js';
import type { AxNode } from '../src/perception/macos/axProtocol.js';

/** The real tree dumped out of Feishu during the spike. */
const REAL = flattenAxTree(loadFeishuTree());

describe('locating Feishu inside an action reading', () => {
  it('finds the open conversation in the tree that was actually captured', () => {
    const chat = locateOpenChat(REAL);
    expect(chat).toBeDefined();
    expect(chat?.chatTitle).not.toBe('');
    expect(chat?.composerIndex).toBeGreaterThan(0);
  });

  it('addresses the composer by an index that resolves back to the composer', () => {
    const chat = locateOpenChat(REAL);
    const composer = REAL[chat?.composerIndex ?? -1];
    expect(composer?.role).toBe('AXTextArea');
    expect(composer?.domClasses).toContain('editor-kit-container');
    // The element the index names is web content, which is what decides the
    // write path.
    expect(composer?.web).toBe(true);
  });

  it('reads the composer contents from its text leaves, exactly as the message parser does', () => {
    const chat = locateOpenChat(REAL);
    const composer = REAL[chat?.composerIndex ?? -1];
    expect(chat?.composerText).toBe(subtreeText(REAL, composer?.index ?? -1));
    // In the captured tree the placeholder is itself a text leaf, padded with
    // three zero-width characters. That is why anything comparing typed text
    // against what is on screen has to ignore the invisibles.
    expect(chat?.composerText).toContain('可以向自己发送文件或转发消息');
    expect(/[\u200B-\u200D\uFEFF]/u.test(chat?.composerText ?? '')).toBe(true);
  });

  it('reports nothing when no conversation is on screen', () => {
    const listOnly: readonly AxNode[] = [{ nodeId: 1, role: 'AXWindow', children: [{ nodeId: 2, role: 'AXWebArea', title: 'messenger' }] }];
    expect(locateOpenChat(flattenAxTree(listOnly))).toBeUndefined();
    expect(locateOpenChat([])).toBeUndefined();
  });

  it('ignores the conversation list webview, which carries matching elements too', () => {
    const both: readonly AxNode[] = [
      {
        nodeId: 1,
        role: 'AXWindow',
        children: [
          {
            nodeId: 2,
            role: 'AXWebArea',
            title: 'messenger',
            children: [
              { nodeId: 3, role: 'AXGroup', domClasses: ['chatWindow_chatName'], children: [{ nodeId: 4, role: 'AXStaticText', value: 'wrong' }] },
            ],
          },
          {
            nodeId: 5,
            role: 'AXWebArea',
            title: 'messenger-chat',
            children: [
              { nodeId: 6, role: 'AXGroup', domClasses: ['chatWindow_chatName'], children: [{ nodeId: 7, role: 'AXStaticText', value: 'right' }] },
            ],
          },
        ],
      },
    ];
    expect(locateOpenChat(flattenAxTree(both))?.chatTitle).toBe('right');
  });

  it('reports a conversation with no composer rather than guessing an index', () => {
    const noComposer: readonly AxNode[] = [
      {
        nodeId: 1,
        role: 'AXWindow',
        children: [
          {
            nodeId: 2,
            role: 'AXWebArea',
            title: 'messenger-chat',
            children: [
              { nodeId: 3, role: 'AXGroup', domClasses: ['chatWindow_chatName'], children: [{ nodeId: 4, role: 'AXStaticText', value: 'Ada' }] },
            ],
          },
        ],
      },
    ];
    const chat = locateOpenChat(flattenAxTree(noComposer));
    expect(chat?.chatTitle).toBe('Ada');
    expect(chat?.composerIndex).toBeUndefined();
    expect(chat?.composerText).toBe('');
  });
});
