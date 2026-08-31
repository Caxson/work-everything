/**
 * A stand-in for `we-ax` that behaves like Feishu.
 *
 * It speaks the real NDJSON protocol over real pipes, so the sender under test
 * exercises its actual transport, and it models the Feishu behaviours the send
 * path depends on: the composer only takes text through `focusAndType`, which
 * refuses to type at all unless focus landed; Enter is the send key; and a sent
 * message appears in the conversation as `message-self`.
 *
 * Every request is echoed to stderr as `LOG <json>` so a test can assert on the
 * exact sequence of input operations — including that none were sent.
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
          // With no conversation open, Feishu still renders the list webview.
          title: process.env['FAKE_CHAT_CLOSED'] === '1' ? 'messenger' : 'messenger-chat',
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
    // A conversation that never renders the sent message back: the send
    // happened, the echo did not arrive.
    if (text !== '' && process.env['FAKE_NO_ECHO'] !== '1') {
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

/** How many elements a full traversal would walk. */
function countNodes() {
  let count = 0;
  const visit = (node) => {
    count += 1;
    for (const child of node.children ?? []) visit(child);
  };
  for (const root of buildTree()) visit(root);
  return count;
}

/**
 * The hybrid write route: focus, then type. Refuses to type a single
 * character unless focus landed — which is the guarantee the sender depends
 * on, and the reason the two are one operation rather than two.
 */
function focusAndType(params) {
  if (params.nodeId === undefined) {
    return { __error: { code: 'BAD_REQUEST', message: "focusAndType needs a 'nodeId'" } };
  }
  const landed = process.env['FAKE_FOCUS_FAILS'] !== '1' && params.nodeId === COMPOSER_NODE;
  if (!landed) {
    state.focused = false;
    // The helper's own shape: it verifies focus landed before typing, and says
    // so in a fact rather than in prose.
    return {
      __error: {
        code: 'FOCUS_FAILED',
        message:
          `could not put the caret in node ${params.nodeId}, so no keys were sent. Tried press, focused, click. ` +
          'press, focused reported success and the focus did not land on the element afterwards',
        details: { attempted: ['press', 'focused', 'click'], claimedSuccess: ['press', 'focused'], keysSent: 0 },
      },
    };
  }
  state.focused = true;
  const text = String(params.text ?? '');
  // A write that reports success and lands nothing: exactly what an
  // accessibility write does to a contenteditable.
  if (process.env['FAKE_SWALLOW_TEXT'] === '1') {
    return { ok: true, focused: { method: 'press', attempted: ['press'], verifiedBy: 'identity', focusedRole: 'AXTextArea' }, typed: { characters: 0 } };
  }
  if (text !== '') {
    const last = state.composer[state.composer.length - 1] ?? '';
    state.composer = [...state.composer.slice(0, -1), last + text];
    state.selectAll = false;
  }
  return { ok: true, focused: { method: 'press', attempted: ['press'], verifiedBy: 'AXDOMClassList', focusedRole: 'AXTextArea' }, typed: { characters: text.length } };
}

/**
 * The window reading. With `meta:true` the helper classifies why there are no
 * windows instead of answering an empty array — four different causes that
 * look identical from a count.
 */
function windows(request) {
  const diagnosis = process.env['FAKE_WINDOW_DIAGNOSIS'];
  if (diagnosis !== undefined) {
    const details = {
      SCREEN_LOCKED: undefined,
      NO_WINDOW: { cgWindows: 0, onScreen: 0, desktopOnScreen: 42, desktopOwnersOnScreen: 12 },
      DESKTOP_BLANK: { cgWindows: 3, onScreen: 0, desktopOnScreen: 8, desktopOwnersOnScreen: 1, scope: 'desktop' },
      // The measured screen-saver payload, verbatim: scope is "application"
      // and eight processes are still drawing, which is exactly why `scope`
      // cannot be what identifies a screen saver.
      NOT_DRAWN: {
        cgWindows: 5,
        onScreen: 0,
        desktopOnScreen: 25,
        desktopOwnersOnScreen: 8,
        scope: 'application',
        axWindows: { entries: 0, selfEqual: 0, real: 0, nonElement: 0 },
      },
    }[diagnosis];
    const code = diagnosis === 'DESKTOP_BLANK' || diagnosis === 'NOT_DRAWN' ? 'AX_SEES_NO_WINDOWS_BUT_CG_DOES' : diagnosis;
    const body = { code, message: `fake ${diagnosis}`, ...(details === undefined ? {} : { details }) };
    // A locked screen is refused by the dispatch gate, before the classifying
    // handler — so it arrives as a throw even with `meta`.
    if (code === 'SCREEN_LOCKED') return { __error: body };
    return request.meta === true ? { windows: [], diagnosis: body } : { __error: body };
  }
  if (process.env['FAKE_NO_WINDOW'] === '1') {
    const body = { code: 'NO_WINDOW', message: 'pid 4242 genuinely exposes no window', details: { cgWindows: 0, onScreen: 0 } };
    return request.meta === true ? { windows: [], diagnosis: body } : { __error: body };
  }
  const list = [{ index: 0, nodeId: WINDOW_NODE, role: 'AXWindow', title: '飞书', windowNumber: 7, resolvedBy: 'ax', addressable: true }];
  return request.meta === true ? { windows: list, diagnosis: { code: 'OK', addressable: 1 } } : list;
}

/** Readiness, judged the way the helper judges it: by web areas. */
function awaitTree() {
  const webAreas = process.env['FAKE_NO_WEB_AREA'] === '1' ? 0 : 1;
  if (webAreas === 0) {
    return { __error: { code: 'TREE_NOT_READY', message: 'no AXWebArea appeared; the menu bar alone is not the window' } };
  }
  return { ready: true, nodes: countNodes(), webAreas, truncated: false, polls: 1, elapsedMs: 1 };
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
      return windows(request);
    case 'tree':
      return buildTree();
    case 'find': {
      const hits = process.env['FAKE_NO_WEB_AREA'] === '1' ? [] : find(request);
      // `meta: true` asks for the traversal budget as well: that is how the
      // action layer tells a tree that is still being built from a finished one.
      return request.meta === true ? { nodes: hits, visited: countNodes(), truncated: false } : hits;
    }
    case 'attr':
      return attr(request);
    case 'click':
      state.focused = process.env['FAKE_FOCUS_FAILS'] === '1' ? false : request.nodeId === COMPOSER_NODE;
      return { ok: true };
    case 'keystroke':
      return keystroke(request);
    case 'focusAndType':
      return focusAndType(request);
    case 'scroll':
      return { ok: true, plan: { deltaX: request.deltaX ?? 0, deltaY: request.deltaY ?? 0, unit: request.unit ?? 'line' } };
    case 'awaitTree':
      return awaitTree();
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
  audit({ op: request.op, key: request.key, modifiers: request.modifiers, nodeId: request.nodeId, text: request.text, replace: request.replace });
  const result = handle(request);
  if (result === null) out({ id: request.id, ok: false, error: { code: 'BAD_REQUEST', message: `unsupported op '${request.op}'` } });
  else if (result !== undefined && result.__error !== undefined) out({ id: request.id, ok: false, error: result.__error });
  else out({ id: request.id, ok: true, result });
});
