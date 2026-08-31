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
 *    only supplies the readings, and never diagnoses from one of them. It also
 *    never asks Feishu to come back: nothing in this daemon takes the screen
 *    from the person using the Mac.
 * 2. It reads and never writes. Writing goes through the action layer, whose
 *    keyboard route is the only path that reaches a `contenteditable` —
 *    see `src/actions/keyboard.ts` for what was measured and why.
 */
import type { AxBridgeClient } from '../macos/axBridge.js';
import { AxBridgeError } from '../macos/axBridge.js';
import type { AxNode } from '../macos/axProtocol.js';
import type { ChatSnapshot } from './messages.js';
import { parseSnapshot } from './messages.js';
import type { FeishuHealthConfig } from './health.js';
import { FeishuHealthMonitor } from './health.js';
import { FEISHU_APP_PATH, FEISHU_BUNDLE_ID, ROLE, TREE_MAX_DEPTH, TREE_MAX_NODES } from './selectors.js';

export interface FeishuReaderConfig {
  readonly bundleId: string;
  readonly appPath: string;
  /** Display name used to attribute the user's own messages. */
  readonly selfName: string;
  readonly now?: () => number;
}

export const DEFAULT_FEISHU_READER_CONFIG: FeishuReaderConfig = {
  bundleId: FEISHU_BUNDLE_ID,
  appPath: FEISHU_APP_PATH,
  selfName: 'me',
};

export class FeishuReader {
  private cachedPid: number | undefined;

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
    this.cachedPid = app.pid;
    return app.pid;
  }

  /** Every web area the app exposes. Zero, with a window open, means trouble. */
  async webAreas(pid: number): Promise<readonly AxNode[]> {
    return await this.client.find(pid, { role: ROLE.webArea });
  }

  /** One read of the open conversation: title, composer and visible messages. */
  async snapshot(): Promise<ChatSnapshot> {
    const pid = await this.pid();
    const roots = await this.client.roots(pid, TREE_MAX_DEPTH, TREE_MAX_NODES);
    return parseSnapshot(roots, { now: this.now(), selfName: this.config.selfName });
  }

}

/**
 * The health monitor for one bridge/reader pair. Built here so every caller —
 * the perceiver, the sender, `we run`'s preflight and the end-to-end check —
 * asks the same question the same way, and re-resolves the pid every time.
 *
 * There is no local screen-lock probe any more. The helper answers with a
 * classified diagnosis that sees both the session's lock state and the window
 * server's census, which is strictly more than `ioreg` could tell us and — for
 * a screen saver running on an unlocked session — the only thing that gets the
 * answer right.
 */
export function feishuHealthMonitor(
  client: AxBridgeClient,
  reader: FeishuReader,
  options: { readonly config?: FeishuHealthConfig } = {},
): FeishuHealthMonitor {
  return new FeishuHealthMonitor({
    pid: () => reader.pid(true),
    windows: (pid) => client.windows(pid),
    webAreas: (pid) => reader.webAreas(pid),
    ...(options.config === undefined ? {} : { config: options.config }),
  });
}
