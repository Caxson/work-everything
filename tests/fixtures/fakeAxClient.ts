/**
 * A stand-in for `AxBridgeClient`, in process.
 *
 * The bridge subprocess is mocked here on purpose: these tests must never
 * touch a real application. Every call is recorded so a test can assert not
 * only what happened but what did *not* — "no keystroke was sent" is the
 * assertion that matters most in this codebase.
 */
import type { AxAwaitTreeRequest, AxBridgeClient, AxClickRequest, AxFindBudget, AxFocusAndTypeRequest, AxTreeReadiness } from '../../src/perception/macos/axBridge.js';
import { AxBridgeError } from '../../src/perception/macos/axBridge.js';
import type { AxApp, AxNode, AxSelector } from '../../src/perception/macos/axProtocol.js';

export interface FakeCall {
  readonly op: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface FakeAxOptions {
  readonly apps?: readonly AxApp[];
  /** Called per read, so a test can change the tree between readings. */
  readonly roots?: () => readonly AxNode[];
  /** Ops that fail, and with what. */
  readonly fail?: Readonly<Record<string, AxBridgeError>>;
  /** Web areas the probe reports. Defaults to what `roots` contains. */
  readonly webAreas?: () => number;
  /** What `attr` answers, by attribute name. */
  readonly attrs?: Readonly<Record<string, unknown>>;
}

export interface FakeAx {
  readonly client: AxBridgeClient;
  readonly calls: FakeCall[];
  ops(): readonly string[];
  callsTo(op: string): readonly FakeCall[];
}

export const FAKE_APP: AxApp = { pid: 4242, name: '飞书', bundleId: 'com.bytedance.macos.feishu', activationPolicy: 'regular' };

function countRole(nodes: readonly AxNode[], role: string): number {
  return nodes.reduce((total, node) => total + (node.role === role ? 1 : 0) + countRole(node.children ?? [], role), 0);
}

function countAll(nodes: readonly AxNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countAll(node.children ?? []), 0);
}

export function fakeAx(options: FakeAxOptions = {}): FakeAx {
  const calls: FakeCall[] = [];
  const roots = options.roots ?? ((): readonly AxNode[] => []);
  const record = (op: string, args: Readonly<Record<string, unknown>>): void => {
    calls.push({ op, args });
    const failure = options.fail?.[op];
    if (failure !== undefined) throw failure;
  };

  const client = {
    apps: async (): Promise<readonly AxApp[]> => {
      record('apps', {});
      return options.apps ?? [FAKE_APP];
    },
    findWithBudget: async (pid: number, selector: AxSelector): Promise<AxFindBudget> => {
      record('findWithBudget', { pid, selector });
      const tree = roots();
      const found = options.webAreas?.() ?? countRole(tree, 'AXWebArea');
      return { nodes: Array.from({ length: found }, (): AxNode => ({ nodeId: -1, role: 'AXWebArea' })), visited: countAll(tree) };
    },
    roots: async (pid: number): Promise<readonly AxNode[]> => {
      record('roots', { pid });
      return roots();
    },
    awaitTree: async (request: AxAwaitTreeRequest): Promise<AxTreeReadiness> => {
      record('awaitTree', { ...request });
      const tree = roots();
      const webAreas = options.webAreas?.() ?? countRole(tree, 'AXWebArea');
      if (webAreas === 0) throw new AxBridgeError('no AXWebArea appeared', 'TREE_NOT_READY');
      return { ready: true, nodes: countAll(tree), webAreas, polls: 1 };
    },
    windows: async (pid: number): Promise<readonly AxNode[]> => {
      record('windows', { pid });
      return roots().map((node) => ({ nodeId: node.nodeId, role: node.role, title: node.title }));
    },
    attr: async (nodeId: number, name: string): Promise<unknown> => {
      record('attr', { nodeId, name });
      return options.attrs?.[name] ?? { nodeId: nodeId + 1_000 };
    },
    click: async (request: AxClickRequest): Promise<void> => {
      record('click', { ...request });
    },
    setValue: async (nodeId: number, value: string): Promise<void> => {
      record('setValue', { nodeId, value });
    },
    press: async (nodeId: number, action?: string): Promise<void> => {
      record('press', { nodeId, action });
    },
    keystroke: async (pid: number, key: string, modifiers: readonly string[] = []): Promise<void> => {
      record('keystroke', { pid, key, modifiers });
    },
    focusAndType: async (request: AxFocusAndTypeRequest): Promise<{ focused: boolean }> => {
      record('focusAndType', { ...request });
      return { focused: true };
    },
  };

  return {
    client: client as unknown as AxBridgeClient,
    calls,
    ops: () => calls.map((call) => call.op),
    callsTo: (op) => calls.filter((call) => call.op === op),
  };
}

/** A window with one web area in it, the shape every CEF app has. */
export function webTree(composerValue = ''): readonly AxNode[] {
  return [
    {
      nodeId: 1,
      role: 'AXWindow',
      title: 'app',
      children: [
        {
          nodeId: 2,
          role: 'AXWebArea',
          title: 'messenger-chat',
          children: [
            { nodeId: 3, role: 'AXGroup', domClasses: ['chatWindow_chatName'], children: [{ nodeId: 4, role: 'AXStaticText', value: 'Ada' }] },
            {
              nodeId: 5,
              role: 'AXTextArea',
              value: 'placeholder',
              domClasses: ['zone-container', 'editor-kit-container'],
              children: composerValue === '' ? [] : [{ nodeId: 6, role: 'AXStaticText', value: composerValue }],
            },
          ],
        },
      ],
    },
  ];
}

/** A plain Cocoa window: no web content anywhere. */
export function nativeTree(): readonly AxNode[] {
  return [
    {
      nodeId: 1,
      role: 'AXWindow',
      title: 'Notes',
      children: [
        { nodeId: 2, role: 'AXTextField', value: 'hello', title: 'Title' },
        { nodeId: 3, role: 'AXButton', title: 'Send' },
      ],
    },
  ];
}
