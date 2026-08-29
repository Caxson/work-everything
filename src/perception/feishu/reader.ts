/**
 * Reading Feishu through the `we-ax` bridge.
 *
 * This is the only file that turns bridge calls into a `ChatSnapshot`; the
 * parsing itself lives in `messages.ts` and never sees a subprocess. Two
 * behaviours here are not obvious and are load-bearing:
 *
 * 1. Feishu spends most of its life with **zero windows** — closed to the tray,
 *    or dismissed with Escape. In that state every traversal returns nothing,
 *    which reads exactly like a broken accessibility tree. So a read that finds
 *    no window says so explicitly instead of returning an empty conversation.
 * 2. The app element is not addressable directly, but it is a window's
 *    `AXParent`. That detour is how focus can be verified before a single
 *    keystroke is sent — see `sender.ts` for why that matters so much.
 */
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { AxBridgeClient } from '../macos/axBridge.js';
import { AxBridgeError } from '../macos/axBridge.js';
import type { ChatSnapshot } from './messages.js';
import { parseSnapshot } from './messages.js';
import { FEISHU_APP_PATH, FEISHU_BUNDLE_ID, MODAL_WINDOW_PREFIX, TREE_MAX_DEPTH, TREE_MAX_NODES } from './selectors.js';

export interface FeishuReaderConfig {
  readonly bundleId: string;
  readonly appPath: string;
  /** Display name used to attribute the user's own messages. */
  readonly selfName: string;
  /** How long to keep asking the app to show a window before giving up. */
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

export type WindowState = { readonly ok: true; readonly pid: number } | { readonly ok: false; readonly reason: string };

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
   * Make sure Feishu is actually showing a window, reopening it if it is not.
   * Failure is reported, never thrown: "the user has the app in the tray" and
   * "the screen is locked" are ordinary states, not errors in this daemon.
   */
  async ensureWindow(): Promise<WindowState> {
    const pid = await this.pid(true);
    // Wall clock on purpose: `config.now` is the injectable stamp for message
    // timestamps, and a frozen test clock must not turn this into a spin.
    const deadline = Date.now() + this.config.windowTimeoutMs;
    for (;;) {
      const windows = await this.client.windows(pid);
      if (windows.some((window) => !(window.title ?? '').startsWith(MODAL_WINDOW_PREFIX) && window.role !== 'AXApplication')) {
        return { ok: true, pid };
      }
      if (Date.now() >= deadline) {
        return {
          ok: false,
          reason: 'Feishu is running but shows no window (closed to the tray, or the screen is locked). Show its main window and retry.',
        };
      }
      await this.reopen();
    }
  }

  private async reopen(): Promise<void> {
    if (this.config.reopen !== undefined) {
      await this.config.reopen(this.config.appPath);
      return;
    }
    await new Promise<void>((resolve) => {
      const child = spawn('open', ['-a', this.config.appPath], { stdio: 'ignore' });
      child.on('error', () => resolve());
      child.on('close', () => setTimeout(resolve, 1_200));
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
