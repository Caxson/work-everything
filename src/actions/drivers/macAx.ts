/**
 * The macOS accessibility driver.
 *
 * Every action here is scoped to one application and delivered to that
 * application's process. That is the whole reason this works in the
 * background: there are no global-coordinate actions and no activation, so
 * the app being driven does not have to be the app in front of the person
 * using the Mac. It is also, per the symbol-level check in
 * `research/08-codex-computeruse.md` §3, how Codex does it — public
 * accessibility APIs and nothing private.
 *
 * Two measured facts shape everything below:
 *
 * 1. **Writing into web content needs the keyboard route.** `setValue` on a
 *    `contenteditable` returns success and produces no input event, so the
 *    page's own state never updates and the text that looks typed is not
 *    typed. Elements marked `web` go through `KeyboardRoute`; when that route
 *    is not available the call fails and says so, rather than falling back to
 *    the write that lies.
 * 2. **A CEF tree has to be waited for, not slept on.** `awaitTree` polls for
 *    a web area and errors on timeout; nothing here proceeds on a stub.
 */
import { z } from 'zod';
import type { AxBridgeClient } from '../../perception/macos/axBridge.js';
import { awaitTree } from '../../perception/macos/axAwait.js';
import type { ActionDriver } from '../driver.js';
import { ActionError, toActionError } from '../errors.js';
import type { KeyboardRoute } from '../keyboard.js';
import { parseKeySpec } from '../keys.js';
import { appKey, resolveApp, type RunningApp } from '../appTarget.js';
import type { Clock } from '../wait.js';
import type { AutoWait } from '../wait.js';
import { systemClock } from '../wait.js';
import type { SnapshotElement, SnapshotStore } from '../snapshot.js';
import { hasLoadingIndicator } from '../snapshot.js';
import { renderSnapshot } from '../render.js';
import { diffElements } from '../diff.js';
import { flattenAxTree } from './macAxTree.js';
import type { Clipboard } from '../clipboard.js';
import { withClipboard } from '../clipboard.js';
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

export interface MacAxConfig {
  readonly treeMaxDepth: number;
  readonly treeMaxNodes: number;
  readonly treeTimeoutMs: number;
  readonly treePollMs: number;
}

/**
 * Depth 45 and twelve thousand nodes because Feishu's message bodies sit at
 * depth 30–45; a shallower walk returns a shell of `AXGroup`s that looks
 * exactly like a broken tree.
 */
export const DEFAULT_MAC_AX_CONFIG: MacAxConfig = { treeMaxDepth: 45, treeMaxNodes: 12_000, treeTimeoutMs: 8_000, treePollMs: 250 };

export interface MacAxDriverDeps {
  readonly client: AxBridgeClient;
  /** The verified write path into web content. */
  readonly keyboard: KeyboardRoute;
  readonly snapshots: SnapshotStore;
  readonly wait: AutoWait;
  readonly clock?: Clock | undefined;
  readonly config?: Partial<MacAxConfig> | undefined;
  readonly clipboard?: Clipboard | undefined;
}

/** Clearing a field: the two keys that mean "select everything, delete it". */
const SELECT_ALL_KEY = 'a';
const DELETE_KEY = 'delete';
const COMMAND: readonly string[] = ['cmd'];

const ElementReferenceSchema = z.object({ nodeId: z.number().int() });

/** Direction → the accessibility action a scrollable element exposes. */
const SCROLL_ACTIONS: Readonly<Record<'up' | 'down' | 'left' | 'right', string>> = {
  up: 'AXScrollUpByPage',
  down: 'AXScrollDownByPage',
  left: 'AXScrollLeftByPage',
  right: 'AXScrollRightByPage',
};

interface Reading {
  readonly elements: readonly SnapshotElement[];
  readonly text: string;
}

export class MacAxDriver implements ActionDriver {
  readonly kind = 'mac_ax';
  private readonly config: MacAxConfig;
  private readonly clock: Clock;

  constructor(private readonly deps: MacAxDriverDeps) {
    this.config = { ...DEFAULT_MAC_AX_CONFIG, ...deps.config };
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Claims everything. This is the general driver, so it belongs last in the
   * registry's list: anything a more specific driver wants — a browser, say —
   * has to be offered that driver first.
   */
  supports(): boolean {
    return true;
  }

  async list_apps(): Promise<readonly App[]> {
    const apps = await this.guard('list_apps', () => this.deps.client.apps());
    return apps.map((app) => ({ id: app.bundleId, displayName: app.name, isRunning: true }));
  }

  async get_app_state(args: GetAppStateArgs): Promise<AppState> {
    const app = await this.resolve(args.app);
    const key = appKey(app);
    const previous = this.deps.snapshots.current(key);

    const reading = await this.deps.wait.settle<Reading>(key, {
      capture: () => this.read(app.pid),
      busy: (current) => hasLoadingIndicator(current.elements),
      same: (a, b) => a.text === b.text,
    });

    const snapshot = this.deps.snapshots.capture(key, reading.elements, this.clock.now());
    const diff = args.disableDiff !== true && previous !== undefined;
    return {
      app: key,
      screenshot: null,
      text: diff && previous !== undefined ? diffElements(previous.elements, reading.elements) : reading.text,
      snapshotId: snapshot.snapshotId,
      diff,
    };
  }

  async click(args: ClickArgs): Promise<void> {
    const app = await this.resolve(args.app);
    const button = args.mouse_button === undefined ? undefined : canonicalButton(args.mouse_button);
    const target =
      args.element_index === undefined
        ? { x: args.x, y: args.y }
        : { nodeId: this.element(app, args.snapshot_id ?? '', args.element_index).handle };
    await this.guard('click', () => this.deps.client.click({ ...target, button, clickCount: args.click_count }));
    this.deps.wait.mark(appKey(app));
  }

  /**
   * Not available through this bridge: it exposes a click, not a press-move-
   * release sequence. Reported rather than approximated — a drag simulated as
   * two clicks is a different gesture and would silently do something else.
   */
  async drag(args: DragArgs): Promise<void> {
    await this.resolve(args.app);
    throw new ActionError('UNSUPPORTED_ACTION', 'drag is not available through the we-ax bridge, which exposes clicks but no press-move-release sequence');
  }

  /**
   * Set an element's value.
   *
   * Native controls take `AXValue` and are written that way. Web content is
   * not: the same call reports success and produces no `beforeinput`, so the
   * page never learns anything was typed. Those go through the keyboard
   * route, which replaces the contents and types the new value as real key
   * events.
   */
  async set_value(args: SetValueArgs): Promise<void> {
    const app = await this.resolve(args.app);
    const element = this.element(app, args.snapshot_id, args.element_index);
    if (element.web) await this.replaceWebValue(app, element.handle, args.value);
    else await this.guard('set_value', () => this.deps.client.setValue(element.handle, args.value));
    this.deps.wait.mark(appKey(app));
  }

  /**
   * Replace a web element's contents.
   *
   * The keyboard route focuses and types; it does not clear, so the clearing
   * is done here with the two keys that mean it. The order is the point: the
   * empty focus-and-type comes first so that select-all and delete are sent
   * to an element that has been *confirmed* to hold focus. Sent before that,
   * they are a global select-all and a global delete in whatever window
   * happens to be listening.
   */
  private async replaceWebValue(app: RunningApp, nodeId: number, value: string): Promise<void> {
    await this.deps.keyboard.focusAndType({ pid: app.pid, nodeId, text: '' });
    await this.guard('set_value', () => this.deps.client.keystroke(app.pid, SELECT_ALL_KEY, COMMAND));
    await this.guard('set_value', () => this.deps.client.keystroke(app.pid, DELETE_KEY));
    if (value !== '') await this.deps.keyboard.focusAndType({ pid: app.pid, nodeId, text: value });
  }

  /** Type into whatever holds focus, as key events delivered to the process. */
  async type_text(args: TypeTextArgs): Promise<void> {
    const app = await this.resolve(args.app);
    const nodeId = await this.focusedNode(app.pid);
    await this.deps.keyboard.focusAndType({ pid: app.pid, nodeId, text: args.text });
    this.deps.wait.mark(appKey(app));
  }

  async press_key(args: PressKeyArgs): Promise<void> {
    const app = await this.resolve(args.app);
    const chord = parseKeySpec(args.key);
    await this.guard('press_key', () => this.deps.client.keystroke(app.pid, chord.key, chord.modifiers));
    this.deps.wait.mark(appKey(app));
  }

  async scroll(args: ScrollArgs): Promise<void> {
    const app = await this.resolve(args.app);
    const element = this.element(app, args.snapshot_id, args.element_index);
    const action = SCROLL_ACTIONS[canonicalDirection(args.direction)];
    const pages = Math.max(1, Math.ceil(args.pages ?? 1));
    for (let page = 0; page < pages; page += 1) {
      await this.guard('scroll', () => this.deps.client.press(element.handle, action));
    }
    this.deps.wait.mark(appKey(app));
  }

  /**
   * An accessibility action the element itself exposes — expanding a
   * disclosure row, showing a menu. The name is passed through untouched:
   * this layer does not invent action names, it performs the one it was given
   * and reports what the accessibility API said about it.
   */
  async perform_secondary_action(args: PerformSecondaryActionArgs): Promise<void> {
    const app = await this.resolve(args.app);
    const element = this.element(app, args.snapshot_id, args.element_index);
    await this.guard('perform_secondary_action', () => this.deps.client.press(element.handle, args.action));
    this.deps.wait.mark(appKey(app));
  }

  /**
   * Put text on the pasteboard, paste it into the focused element, and give
   * the clipboard back. `md` is pasted as its source text; `html` is refused,
   * because there is no rich-flavour write here and pasting the markup as
   * plain text would be a different result reported as the requested one.
   */
  async paste(args: PasteArgs): Promise<void> {
    const app = await this.resolve(args.app);
    if (args.format === 'html') {
      throw new ActionError('UNSUPPORTED_ACTION', "paste format 'html' needs a rich-flavour pasteboard write, which this driver does not have; use 'text'");
    }
    const clipboard = this.deps.clipboard;
    if (clipboard === undefined) throw new ActionError('UNSUPPORTED_ACTION', 'paste needs a clipboard; none was configured for this driver');
    await withClipboard(clipboard, args.text, () => this.guard('paste', () => this.deps.client.keystroke(app.pid, 'v', ['cmd'])));
    this.deps.wait.mark(appKey(app));
  }

  /**
   * Not available. Selecting inside web content is precisely what was
   * measured to report success and do nothing (`AXSelectedTextRange`,
   * `AXSelectedText`), and the bridge has no attribute write for the native
   * case. Refused rather than performed silently wrong.
   */
  async select_text(args: SelectTextArgs): Promise<void> {
    const app = await this.resolve(args.app);
    this.element(app, args.snapshot_id, args.element_index);
    throw new ActionError(
      'UNSUPPORTED_ACTION',
      'select_text has no verified path: AXSelectedTextRange and AXSelectedText both report success on web content and change nothing, ' +
        'and the bridge exposes no attribute write for native elements. Use set_value, which replaces the whole value.',
    );
  }

  // --- plumbing ------------------------------------------------------------

  /**
   * Resolved on every call rather than cached. An app that restarts comes
   * back with a new pid, and a cached one turns every later call into the
   * same permanent failure — a bug this project has already paid for once.
   */
  private async resolve(query: string): Promise<RunningApp> {
    const apps = await this.guard('list_apps', () => this.deps.client.apps());
    return resolveApp(query, apps);
  }

  private element(app: RunningApp, snapshotId: string, index: number): SnapshotElement {
    return this.deps.snapshots.resolve(appKey(app), snapshotId, index);
  }

  /**
   * The node that currently holds keyboard focus.
   *
   * `AXFocusedUIElement` is an application-level attribute and the helper
   * only hands out handles for elements it has walked, so the application
   * element is reached the one way it can be: as a window's `AXParent`.
   */
  private async focusedNode(pid: number): Promise<number> {
    const windows = await this.guard('type_text', () => this.deps.client.windows(pid));
    const window = windows[0];
    if (window === undefined) throw new ActionError('DRIVER_ERROR', `process ${pid} exposes no window to reach its focused element through`);
    const application =
      window.role === 'AXApplication' ? window.nodeId : this.reference(await this.guard('type_text', () => this.deps.client.attr(window.nodeId, 'AXParent')), 'AXParent');
    const focused = await this.guard('type_text', () => this.deps.client.attr(application, 'AXFocusedUIElement'));
    return this.reference(focused, 'AXFocusedUIElement');
  }

  private reference(value: unknown, attribute: string): number {
    const parsed = ElementReferenceSchema.safeParse(value);
    if (!parsed.success) throw new ActionError('DRIVER_ERROR', `${attribute} did not answer with an element this bridge can address`);
    return parsed.data.nodeId;
  }

  private async read(pid: number): Promise<Reading> {
    const tree = await this.guard('get_app_state', () =>
      awaitTree(this.deps.client, pid, {
        maxDepth: this.config.treeMaxDepth,
        maxNodes: this.config.treeMaxNodes,
        timeoutMs: this.config.treeTimeoutMs,
        pollMs: this.config.treePollMs,
        sleep: (ms) => this.clock.sleep(ms),
        now: () => this.clock.now(),
      }),
    );
    const elements = flattenAxTree(tree.roots);
    return { elements, text: renderSnapshot(elements) };
  }

  /** Every bridge call goes through here, so every failure arrives typed. */
  private async guard<T>(context: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw toActionError(error, `${this.kind}.${context}`);
    }
  }
}
