/**
 * A stand-in for `we-ax` that behaves like Feishu.
 *
 * It speaks the real NDJSON protocol over real pipes, so the sender under test
 * exercises its actual transport, and it models the three Feishu behaviours the
 * send path depends on: the composer only takes focus from a click, Enter is
 * the send key, and a sent message appears in the conversation as `message-self`.
 *
 * Every request is echoed to stderr as `LOG <json>` so a test can assert on the
 * exact sequence of clicks and keystrokes — including that none were sent.
 */
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const PID = 4242;
const APP_NODE = 1;
const WINDOW_NODE = 100;
const COMPOSER_NODE = 400;
const ELSEWHERE_NODE = 999;
const PLACEHOLDER = '可以向自己发送文件或转发消息';
const CHAT_TITLE = process.env['FAKE_CHAT_TITLE'] ?? '曹良欢（Sion）';
const COMPOSER_CLASSES = ['zone-container', 'editor-kit-container', 'innerdocbody'];

const state = {
  focused: false,
  selectAll: false,
  composer: [''],
  nextId: 7_600_000_000_000_000_000n,
  messages: [{ id: '7679345486104415420', self: true, kind: 'text-message', text: '[work-everything spike] hello' }],
};

const subscriptions = new Set();
const auditPath = process.env['FAKE_LOG'];
const audit = (entry) => {
  process.stderr.write(`LOG ${JSON.stringify(entry)}\n`);
  if (auditPath !== undefined) appendFileSync(auditPath, `${JSON.stringify(entry)}\n`);
};

/**
 * Deliver an inbound message after a delay, the way a person would, and fire
 * the accessibility notification Feishu fires when one lands. Used by the
 * offline end-to-end check, which drives the real daemon against this file.
 */
const injectAfter = Number(process.env['FAKE_INJECT_AFTER_MS'] ?? '0');
if (injectAfter > 0) {
  setTimeout(() => {
    state.nextId += 1n;
    state.messages = [
      ...state.messages,
      { id: String(state.nextId), self: false, kind: 'text-message', text: process.env['FAKE_INJECT_TEXT'] ?? 'we ping' },
    ];
    audit({ op: 'inject', text: process.env['FAKE_INJECT_TEXT'] ?? 'we ping' });
    for (const subscription of subscriptions) {
      out({ event: 'ax', subscription, notification: 'AXValueChanged', nodeId: 200, pid: PID });
    }
  }, injectAfter).unref?.();
}

let nextNode = 1000;
const node = (role, extra = {}) => ({ nodeId: nextNode++, role, ...extra });

function messageNode(message) {
  return node('AXGroup', {
    domId: message.id,
    domClasses: ['js-message-item', 'message-item', message.self ? 'message-self' : 'message-not-self', 'message-is-p2p', message.kind],
    children: [
      node('AXGroup', {
        domClasses: ['message-content-container'],
        children: [node('AXStaticText', { value: message.text })],
      }),
    ],
  });
}

function buildTree() {
  nextNode = 1000;
  return [
    {
      nodeId: WINDOW_NODE,
      role: 'AXWindow',
      title: '飞书',
      children: [
        {
          nodeId: 200,
          role: 'AXWebArea',
          title: 'messenger-chat',
          children: [
            node('AXGroup', { domClasses: ['chatWindow_chatName'], children: [node('AXStaticText', { value: CHAT_TITLE })] }),
            node('AXGroup', { domClasses: ['chatMessages'], children: state.messages.map(messageNode) }),
            {
              nodeId: COMPOSER_NODE,
              role: 'AXTextArea',
              value: PLACEHOLDER,
              domClasses: COMPOSER_CLASSES,
              children: state.composer.filter((line) => line !== '').map((line) => node('AXStaticText', { value: line })),
            },
          ],
        },
      ],
    },
  ];
}

function keystroke(params) {
  const key = String(params.key ?? '');
  const modifiers = params.modifiers ?? [];
  if (key === 'a' && modifiers.includes('cmd')) {
    state.selectAll = true;
    return { ok: true, mode: 'keycode' };
  }
  if (key === 'delete') {
    if (state.selectAll) state.composer = [''];
    state.selectAll = false;
    return { ok: true, mode: 'keycode' };
  }
  if (key === 'return' && modifiers.includes('shift')) {
    state.composer = [...state.composer, ''];
    return { ok: true, mode: 'keycode' };
  }
  if (key === 'return') {
    const text = state.composer.join('\n').trim();
    if (text !== '') {
      state.nextId += 1n;
      state.messages = [...state.messages, { id: String(state.nextId), self: true, kind: 'text-message', text }];
    }
    state.composer = [''];
    return { ok: true, mode: 'keycode' };
  }
  if (!state.focused) return { ok: true, mode: 'dropped' };
  const last = state.composer[state.composer.length - 1] ?? '';
  state.composer = [...state.composer.slice(0, -1), last + key];
  state.selectAll = false;
  return { ok: true, mode: 'unicode' };
}

/** The `find` op: a flat, pre-order scan matching every supplied selector field. */
function find(params) {
  const selector = params.selector ?? {};
  const hits = [];
  const limit = selector.maxResults ?? 30;
  const visit = (node, depth) => {
    if (hits.length >= limit) return;
    const classes = node.domClasses ?? [];
    const matches =
      (selector.role === undefined || node.role === selector.role) &&
      (selector.title === undefined || node.title === selector.title) &&
      (selector.domId === undefined || node.domId === selector.domId) &&
      (selector.domClass === undefined || classes.includes(selector.domClass));
    if (matches) {
      // `find` results are flat: they carry a depth instead of children.
      const flat = { ...node, depth };
      delete flat.children;
      hits.push(flat);
    }
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  for (const root of buildTree()) visit(root, 0);
  return hits;
}

function attr(params) {
  if (params.nodeId === WINDOW_NODE && params.name === 'AXParent') return { nodeId: APP_NODE };
  if (params.nodeId === APP_NODE && params.name === 'AXFocusedUIElement') {
    return { nodeId: state.focused ? COMPOSER_NODE : ELSEWHERE_NODE };
  }
  if (params.name === 'AXDOMClassList') return params.nodeId === COMPOSER_NODE ? COMPOSER_CLASSES : ['some-other-thing'];
  return null;
}

function handle(request) {
  switch (request.op) {
    case 'trusted':
      return { trusted: process.env['FAKE_UNTRUSTED'] !== '1' };
    case 'apps':
      return [{ pid: PID, name: '飞书', bundleId: 'com.bytedance.macos.feishu', activationPolicy: 'regular' }];
    case 'enableAX':
      return {};
    case 'windows':
      return process.env['FAKE_NO_WINDOW'] === '1' ? [] : [{ index: 0, nodeId: WINDOW_NODE, role: 'AXWindow', title: '飞书' }];
    case 'tree':
      return buildTree();
    case 'find':
      return process.env['FAKE_NO_WEB_AREA'] === '1' ? [] : find(request);
    case 'attr':
      return attr(request);
    case 'click':
      state.focused = process.env['FAKE_FOCUS_FAILS'] === '1' ? false : request.nodeId === COMPOSER_NODE;
      return { ok: true };
    case 'keystroke':
      return keystroke(request);
    case 'observe':
      subscriptions.add(1);
      return { subscription: 1, registered: 3, failed: [] };
    case 'unobserve':
      subscriptions.delete(request.subscription);
      return { subscription: request.subscription, ok: true };
    default:
      return null;
  }
}

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    out({ id: -1, ok: false, error: { code: 'BAD_REQUEST', message: 'not JSON' } });
    return;
  }
  audit({ op: request.op, key: request.key, modifiers: request.modifiers, nodeId: request.nodeId });
  const result = handle(request);
  if (result === null) out({ id: request.id, ok: false, error: { code: 'BAD_REQUEST', message: `unsupported op '${request.op}'` } });
  else out({ id: request.id, ok: true, result });
});
