/**
 * Reading Feishu through the `we-ax` bridge.
 *
 * This is the only file that turns bridge calls into a `ChatSnapshot`; the
 * parsing itself lives in `messages.ts` and never sees a subprocess. Two
 * behaviours here are not obvious and are load-bearing:
 *
 * 1. Feishu spends most of its life with **zero windows** — closed to the tray,
 *    dismissed with Escape, or behind a locked screen. In that state every
 *    traversal returns nothing, which reads exactly like a broken
 *    accessibility tree. Telling those apart is `health.ts`'s job; this file
 *    only supplies the readings, and never diagnoses from one of them.
 * 2. The app element is not addressable directly, but it is a window's
 *    `AXParent`. That detour is how focus can be verified before a single
 *    keystroke is sent — see `sender.ts` for why that matters so much.
 */
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { AxBridgeClient } from '../macos/axBridge.js';
import { AxBridgeError } from '../macos/axBridge.js';
import type { AxNode } from '../macos/axProtocol.js';
import type { ChatSnapshot } from './messages.js';
import { parseSnapshot } from './messages.js';
import type { FeishuHealthConfig } from './health.js';
import { FeishuHealthMonitor } from './health.js';
import type { ScreenLockProbe } from '../macos/screenLock.js';
import { isScreenLocked } from '../macos/screenLock.js';
import { FEISHU_APP_PATH, FEISHU_BUNDLE_ID, MODAL_WINDOW_PREFIX, ROLE, TREE_MAX_DEPTH, TREE_MAX_NODES } from './selectors.js';

export interface FeishuReaderConfig {
  readonly bundleId: string;
  readonly appPath: string;
  /** Display name used to attribute the user's own messages. */
  readonly selfName: string;
  /** How long to wait for a reopened window to appear. */
  readonly windowTimeoutMs: number;
  /** Injectable so a test never shells out. */
  readonly reopen?: (appPath: string) => Promise<void>;
  readonly now?: () => number;
}

export const DEFAULT_FEISHU_READER_CONFIG: FeishuReaderConfig = {
  bundleId: FEISHU_BUNDLE_ID,
  appPath: FEISHU_APP_PATH,
  selfName: 'me',
  windowTimeoutMs: 8_000,
};

const ElementRefSchema = z.object({ nodeId: z.number().int() });

export class FeishuReader {
  private cachedPid: number | undefined;
  private cachedAppNode: { readonly pid: number; readonly nodeId: number } | undefined;

  constructor(
    private readonly client: AxBridgeClient,
    private readonly config: FeishuReaderConfig = DEFAULT_FEISHU_READER_CONFIG,
  ) {}

  private now(): number {
    return this.config.now?.() ?? Date.now();
  }

  /** Feishu's pid, resolved from the running application list and cached. */
  async pid(refresh = false): Promise<number> {
    if (!refresh && this.cachedPid !== undefined) return this.cachedPid;
    const apps = await this.client.apps();
    const app = apps.find((candidate) => candidate.bundleId === this.config.bundleId);
    if (app === undefined) throw new AxBridgeError(`Feishu (${this.config.bundleId}) is not running`, 'not_running');
    if (app.pid !== this.cachedPid) this.cachedAppNode = undefined;
    this.cachedPid = app.pid;
    return app.pid;
  }

  /**
   * Ask Feishu to show its window. One attempt, and it does not wait for a
   * verdict — deciding what an unchanged app means belongs to `health.ts`,
   * which is the only place that can tell a tray icon from a wedged one.
   */
  async requestWindow(): Promise<void> {
    await this.reopen();
  }

  /** Every web area the app exposes. Zero, with a window open, means trouble. */
  async webAreas(pid: number): Promise<readonly AxNode[]> {
    return await this.client.find(pid, { role: ROLE.webArea });
  }

  private async reopen(): Promise<void> {
    if (this.config.reopen !== undefined) {
      await this.config.reopen(this.config.appPath);
      return;
    }
    await new Promise<void>((resolve) => {
      const child = spawn('open', ['-a', this.config.appPath], { stdio: 'ignore' });
      child.on('error', () => resolve());
      child.on('close', () => setTimeout(resolve, Math.min(this.config.windowTimeoutMs, 1_500)));
    });
  }

  /** One read of the open conversation: title, composer and visible messages. */
  async snapshot(): Promise<ChatSnapshot> {
    const pid = await this.pid();
    const roots = await this.client.roots(pid, TREE_MAX_DEPTH, TREE_MAX_NODES);
    return parseSnapshot(roots, { now: this.now(), selfName: this.config.selfName });
  }

  /**
   * The application element's node handle, reached through a window's parent.
   * Needed because `AXFocusedUIElement` is an application-level attribute and
   * the bridge only hands out handles for things it has walked.
   */
  async appNode(): Promise<number> {
    const pid = await this.pid();
    if (this.cachedAppNode?.pid === pid) return this.cachedAppNode.nodeId;
    const windows = await this.client.windows(pid);
    const window = windows.find((candidate) => !(candidate.title ?? '').startsWith(MODAL_WINDOW_PREFIX));
    if (window === undefined) throw new AxBridgeError('Feishu exposes no window to resolve its application element from', 'ax_error');
    if (window.role === 'AXApplication') {
      this.cachedAppNode = { pid, nodeId: window.nodeId };
      return window.nodeId;
    }
    const parent = ElementRefSchema.safeParse(await this.client.attr(window.nodeId, 'AXParent'));
    if (!parent.success) throw new AxBridgeError('window has no addressable AXParent', 'ax_error');
    this.cachedAppNode = { pid, nodeId: parent.data.nodeId };
    return parent.data.nodeId;
  }

  /**
   * The DOM classes of whatever currently holds keyboard focus. Compared by
   * class list rather than element identity: Chromium hands back a different
   * `AXUIElement` object for the same element on every call, so `===` on
   * handles is always false.
   */
  async focusedDomClasses(): Promise<readonly string[]> {
    const app = await this.appNode();
    const focused = ElementRefSchema.safeParse(await this.client.attr(app, 'AXFocusedUIElement'));
    if (!focused.success) return [];
    const classes = z.array(z.string()).safeParse(await this.client.attr(focused.data.nodeId, 'AXDOMClassList'));
    return classes.success ? classes.data : [];
  }
}

/**
 * The health monitor for one bridge/reader pair. Built here so every caller —
 * the perceiver, the sender, `we run`'s preflight and the end-to-end check —
 * asks the same question the same way, and re-resolves the pid every time.
 */
export function feishuHealthMonitor(
  client: AxBridgeClient,
  reader: FeishuReader,
  options: { readonly screenLocked?: ScreenLockProbe; readonly config?: FeishuHealthConfig } = {},
): FeishuHealthMonitor {
  return new FeishuHealthMonitor({
    pid: () => reader.pid(true),
    windows: (pid) => client.windows(pid),
    webAreas: (pid) => reader.webAreas(pid),
    screenLocked: options.screenLocked ?? isScreenLocked,
    requestWindow: () => reader.requestWindow(),
    ...(options.config === undefined ? {} : { config: options.config }),
  });
}
