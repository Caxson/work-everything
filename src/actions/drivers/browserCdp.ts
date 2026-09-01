/**
 * The browser driver: the same eleven actions, delivered over the Chrome
 * DevTools Protocol instead of accessibility.
 *
 * A browser is the one application where the accessibility route is the wrong
 * one, and the evidence is OpenAI's own (`research/08-codex-computeruse.md`
 * §5): three weeks after shipping macOS computer use they shipped a separate
 * Chrome extension with a `full_cdp_access` flag, and their documentation
 * says to prefer it whenever the task lives in a browser. Through
 * accessibility a page has no URL, no DOM, and addressing that survives a
 * scroll; through CDP it has all three.
 *
 * The transport is injectable and, today, usually absent: this driver knows
 * exactly which CDP calls each action is, and says it is not connected rather
 * than pretending otherwise. Wiring a real socket to it changes nothing above
 * this line.
 */
import type { ActionDriver } from '../driver.js';
import { SCROLL_PAGE_PIXELS } from '../driver.js';
import { ActionError, toActionError } from '../errors.js';
import { parseKeySpec } from '../keys.js';
import type { SnapshotElement, SnapshotStore } from '../snapshot.js';
import { hasLoadingIndicator } from '../snapshot.js';
import { renderSnapshot } from '../render.js';
import { diffElements } from '../diff.js';
import type { Clock } from '../wait.js';
import type { AutoWait } from '../wait.js';
import { systemClock } from '../wait.js';
import type {
  App,
  AppState,
  ClickArgs,
  DragArgs,
  GetAppStateArgs,
  PasteArgs,
  PerformSecondaryActionArgs,
  PressKeyArgs,
  ScrollArgs,
  SelectTextArgs,
  SetValueArgs,
  TypeTextArgs,
} from '../types.js';
import { canonicalButton, canonicalDirection } from '../types.js';

/** One CDP command. A real connection and a test double are the same shape. */
export interface CdpTransport {
  send(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/** Apps this driver claims, by display name or bundle identifier. */
export const DEFAULT_BROWSER_TARGETS: readonly string[] = [
  'com.google.Chrome',
  'com.google.Chrome.canary',
  'Google Chrome',
  'com.microsoft.edgemac',
  'Microsoft Edge',
  'com.brave.Browser',
  'Brave Browser',
  'org.chromium.Chromium',
  'Chromium',
];

export interface BrowserCdpDeps {
  readonly transport?: CdpTransport | undefined;
  readonly targets?: readonly string[] | undefined;
  readonly snapshots: SnapshotStore;
  readonly wait: AutoWait;
  readonly clock?: Clock | undefined;
}

const MODIFIER_BITS: Readonly<Record<string, number>> = { alt: 1, ctrl: 2, cmd: 4, shift: 8, fn: 0 };

/** Bridge key names → DOM `key` values, for `Input.dispatchKeyEvent`. */
const DOM_KEYS: Readonly<Record<string, string>> = {
  return: 'Enter',
  tab: 'Tab',
  space: ' ',
  delete: 'Backspace',
  forwarddelete: 'Delete',
  escape: 'Escape',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
};

interface AxTreeNode {
  readonly nodeId?: unknown;
  readonly backendDOMNodeId?: unknown;
  readonly role?: { readonly value?: unknown };
  readonly name?: { readonly value?: unknown };
  readonly description?: { readonly value?: unknown };
  readonly value?: { readonly value?: unknown };
  readonly childIds?: unknown;
}

const asText = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

export class BrowserCdpDriver implements ActionDriver {
  readonly kind = 'browser_cdp';
  private readonly targets: readonly string[];
  private readonly clock: Clock;

  constructor(private readonly deps: BrowserCdpDeps) {
    this.targets = deps.targets ?? DEFAULT_BROWSER_TARGETS;
    this.clock = deps.clock ?? systemClock;
  }

  supports(app: string): boolean {
    return this.targets.some((target) => target.toLowerCase() === app.toLowerCase());
  }

  async list_apps(): Promise<readonly App[]> {
    if (this.deps.transport === undefined) return [];
    const version = await this.send('Browser.getVersion');
    const product = (version as { product?: unknown } | null)?.product;
    const id = this.targets[0] ?? 'browser';
    return [{ id, displayName: typeof product === 'string' ? product : id, isRunning: true }];
  }

  async get_app_state(args: GetAppStateArgs): Promise<AppState> {
    const key = args.app;
    const previous = this.deps.snapshots.current(key);
    const reading = await this.deps.wait.settle(key, {
      capture: () => this.read(),
      busy: (current) => hasLoadingIndicator(current),
      same: (a, b) => renderSnapshot(a) === renderSnapshot(b),
    });
    const snapshot = this.deps.snapshots.capture(key, reading, this.clock.now());
    const diff = args.disableDiff !== true && previous !== undefined;
    return {
      app: key,
      screenshot: null,
      text: diff && previous !== undefined ? diffElements(previous.elements, reading) : renderSnapshot(reading),
      snapshotId: snapshot.snapshotId,
      diff,
    };
  }

  async click(args: ClickArgs): Promise<void> {
    const point =
      args.element_index === undefined
        ? { x: args.x ?? 0, y: args.y ?? 0 }
        : await this.centreOf(this.element(args.app, args.snapshot_id ?? '', args.element_index));
    const button = args.mouse_button === undefined ? 'left' : canonicalButton(args.mouse_button);
    const clickCount = args.click_count ?? 1;
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button, clickCount, ...point });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button, clickCount, ...point });
    this.deps.wait.mark(args.app);
  }

  async drag(args: DragArgs): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: args.from_x, y: args.from_y });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', x: args.to_x, y: args.to_y });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: args.to_x, y: args.to_y });
    this.deps.wait.mark(args.app);
  }

  async set_value(args: SetValueArgs): Promise<void> {
    const element = this.element(args.app, args.snapshot_id, args.element_index);
    await this.send('DOM.focus', { backendNodeId: element.handle });
    await this.key({ key: 'a', modifiers: ['cmd'] });
    await this.send('Input.insertText', { text: args.value });
    this.deps.wait.mark(args.app);
  }

  async type_text(args: TypeTextArgs): Promise<void> {
    await this.send('Input.insertText', { text: args.text });
    this.deps.wait.mark(args.app);
  }

  async press_key(args: PressKeyArgs): Promise<void> {
    await this.key(parseKeySpec(args.key));
    this.deps.wait.mark(args.app);
  }

  async scroll(args: ScrollArgs): Promise<void> {
    const point = await this.centreOf(this.element(args.app, args.snapshot_id, args.element_index));
    const distance = SCROLL_PAGE_PIXELS * Math.max(1, args.pages ?? 1);
    const direction = canonicalDirection(args.direction);
    const deltaX = direction === 'left' ? -distance : direction === 'right' ? distance : 0;
    const deltaY = direction === 'up' ? -distance : direction === 'down' ? distance : 0;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX, deltaY });
    this.deps.wait.mark(args.app);
  }

  /** CDP has no pasteboard; the text is inserted, which is what paste means here. */
  async paste(args: PasteArgs): Promise<void> {
    if (args.format === 'html') {
      throw new ActionError('UNSUPPORTED_ACTION', "paste format 'html' is not implemented for the CDP driver; use 'text'");
    }
    await this.send('Input.insertText', { text: args.text });
    this.deps.wait.mark(args.app);
  }

  select_text(_args: SelectTextArgs): Promise<void> {
    return Promise.reject(new ActionError('UNSUPPORTED_ACTION', 'select_text is not implemented for the CDP driver yet'));
  }

  perform_secondary_action(_args: PerformSecondaryActionArgs): Promise<void> {
    return Promise.reject(
      new ActionError('UNSUPPORTED_ACTION', 'perform_secondary_action has no CDP equivalent: accessibility actions are not exposed over the protocol'),
    );
  }

  // --- plumbing ------------------------------------------------------------

  private element(app: string, snapshotId: string, index: number): SnapshotElement {
    return this.deps.snapshots.resolve(app, snapshotId, index);
  }

  private async send(method: string, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    const transport = this.deps.transport;
    if (transport === undefined) {
      throw new ActionError('NOT_CONNECTED', `${this.kind} has no CDP connection; ${method} was not sent. Attach a transport to drive a browser.`);
    }
    try {
      return await transport.send(method, params);
    } catch (error) {
      throw toActionError(error, `${this.kind}.${method}`);
    }
  }

  private async key(chord: { readonly key: string; readonly modifiers: readonly string[] }): Promise<void> {
    const modifiers = chord.modifiers.reduce((bits, name) => bits | (MODIFIER_BITS[name] ?? 0), 0);
    const key = DOM_KEYS[chord.key] ?? chord.key;
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, modifiers, text: key.length === 1 ? key : undefined });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers });
  }

  /** The centre of an element's box, which is where a click goes. */
  private async centreOf(element: SnapshotElement): Promise<{ readonly x: number; readonly y: number }> {
    const box = await this.send('DOM.getBoxModel', { backendNodeId: element.handle });
    const content = (box as { model?: { content?: unknown } } | null)?.model?.content;
    if (!Array.isArray(content) || content.length < 8) {
      throw new ActionError('DRIVER_ERROR', `element ${element.index} has no box to click; it may be off-screen or display:none`);
    }
    const xs = [content[0], content[2], content[4], content[6]].map(Number);
    const ys = [content[1], content[3], content[5], content[7]].map(Number);
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  }

  /** One accessibility reading of the page, flattened in document order. */
  private async read(): Promise<readonly SnapshotElement[]> {
    const tree = await this.send('Accessibility.getFullAXTree');
    const nodes = (tree as { nodes?: unknown } | null)?.nodes;
    if (!Array.isArray(nodes)) throw new ActionError('DRIVER_ERROR', 'Accessibility.getFullAXTree returned no nodes');
    return flattenCdpTree(nodes as readonly AxTreeNode[]);
  }
}

/**
 * CDP hands back a flat node list plus `childIds`; document order and depth
 * have to be recovered by walking it from the root.
 */
export function flattenCdpTree(nodes: readonly AxTreeNode[]): readonly SnapshotElement[] {
  const byId = new Map<string, AxTreeNode>();
  const children = new Set<string>();
  for (const node of nodes) {
    const id = String(node.nodeId ?? '');
    if (id !== '') byId.set(id, node);
    for (const child of Array.isArray(node.childIds) ? node.childIds : []) children.add(String(child));
  }

  const elements: SnapshotElement[] = [];
  const visit = (node: AxTreeNode, depth: number): void => {
    elements.push({
      index: elements.length,
      depth,
      role: asText(node.role?.value) ?? 'unknown',
      title: asText(node.name?.value),
      value: asText(node.value?.value),
      description: asText(node.description?.value),
      web: true,
      handle: Number(node.backendDOMNodeId ?? 0),
    });
    for (const childId of Array.isArray(node.childIds) ? node.childIds : []) {
      const child = byId.get(String(childId));
      if (child !== undefined) visit(child, depth + 1);
    }
  };

  for (const node of nodes) {
    const id = String(node.nodeId ?? '');
    if (!children.has(id)) visit(node, 0);
  }
  return elements;
}
