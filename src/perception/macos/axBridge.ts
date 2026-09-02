/**
 * Client for the `we-ax` helper: the macOS accessibility side of perception.
 *
 * The helper is a separate binary (built from `native/ax-bridge`) because the
 * accessibility APIs are only reachable from a native process holding the
 * user's trust grant. This file speaks its protocol and nothing else — no
 * accessibility concepts leak in here beyond what the wire carries.
 *
 * Every request is correlated by id and bounded by a timeout, because a
 * helper that stops answering must not strand the daemon; and the process is
 * never assumed to exist — a missing binary is reported as exactly that.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Socket } from 'node:net';
import type { Event } from '../../core/events.js';
import type { Perceiver } from '../base.js';
import type { AxApp, AxEnv, AxNode, AxNotification, AxOp, AxScreenState, AxSelector, WindowDiagnosis, WindowInfo, WindowReading } from './axProtocol.js';
import {
  AxAppSchema,
  AxEnvSchema,
  AxNodeSchema,
  WINDOW_DIAGNOSIS_CODES,
  WindowDiagnosisDetailsSchema,
  WindowInfoSchema,
  WindowReadingSchema,
  decodeMessage,
  encodeRequest,
} from './axProtocol.js';
import { SocketTransport, SpawnTransport, type AxTransport, type AxTransportError } from './axTransport.js';
import { z } from 'zod';

export class AxBridgeError extends Error {
  constructor(
    message: string,
    readonly code = 'bridge_error',
    /** Structured diagnostics the helper attached, when it had any. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AxBridgeError';
  }
}

export interface AxBridgeConfig {
  /** Path to the `we-ax` binary produced by `native/ax-bridge`. */
  readonly binaryPath: string;
  readonly requestTimeoutMs: number;
  /**
   * Unix socket of a resident `we-ax` service. When set, this is the transport and the
   * binary is never spawned.
   *
   * Preferred, and for an unattended agent effectively required. macOS attributes an
   * Accessibility grant to the *responsible process*: a helper spawned as a child inherits
   * the grant of whoever launched it, so the same binary is trusted from a terminal and
   * untrusted from the daemon, and granting the binary itself changes nothing. A service
   * under launchd is responsible for itself — granted once, by hand, and then usable by
   * any caller that can open this socket. See `native/ax-bridge/scripts/install-service.sh`.
   */
  readonly socketPath?: string | undefined;
  /** Injectable so tests can drive a stand-in helper over real pipes. */
  readonly spawnFn?: (binaryPath: string) => ChildProcessWithoutNullStreams;
  /** Injectable so tests can point the socket transport at a server they control. */
  readonly connectFn?: (socketPath: string) => Socket;
}

export const DEFAULT_AX_TIMEOUT_MS = 10_000;

export interface AxClickRequest {
  readonly nodeId?: number | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly button?: 'left' | 'right' | 'center' | undefined;
  readonly clickCount?: number | undefined;
}

export interface AxFocusAndTypeRequest {
  readonly pid: number;
  /** The element to focus. Required: the helper focuses by node, not by app. */
  readonly nodeId: number;
  readonly text: string;
}

/** What `awaitTree` reports. It answers about readiness, not with the tree. */
const AxTreeReadinessSchema = z.object({
  ready: z.boolean(),
  nodes: z.number().int().nonnegative(),
  webAreas: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
  polls: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative().optional(),
});
export type AxTreeReadiness = z.infer<typeof AxTreeReadinessSchema>;

/**
 * A classified failure, as a diagnosis. Anything else is a real fault and is
 * left to throw: turning an unknown error into "no window" would hide it.
 */
function diagnosisFromError(error: unknown): WindowDiagnosis | undefined {
  if (!(error instanceof AxBridgeError)) return undefined;
  if (!(WINDOW_DIAGNOSIS_CODES as readonly string[]).includes(error.code)) return undefined;
  const details = WindowDiagnosisDetailsSchema.safeParse(error.details);
  return { code: error.code, message: error.message, ...(details.success ? { details: details.data } : {}) };
}

export interface AxScrollRequest {
  readonly pid: number;
  /** The element to scroll over. Its centre is where the wheel event lands. */
  readonly nodeId: number;
  readonly deltaX?: number | undefined;
  readonly deltaY?: number | undefined;
  readonly unit?: 'line' | 'pixel' | undefined;
}

export interface AxAwaitTreeRequest {
  readonly pid: number;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

const AxFindBudgetSchema = z.object({
  nodes: z.array(AxNodeSchema),
  visited: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
});
export type AxFindBudget = z.infer<typeof AxFindBudgetSchema>;

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * Transport faults reach callers as `AxBridgeError`, keeping one error type on this side
 * of the pipe. The code is carried through unchanged: `binary_missing` and
 * `service_unavailable` name different remedies and a caller that collapses them tells
 * somebody to build a binary they already have.
 */
function fromTransport(error: unknown): AxBridgeError {
  if (error instanceof AxBridgeError) return error;
  const transport = error as Partial<AxTransportError>;
  if (typeof transport?.code === 'string' && typeof transport.message === 'string') {
    return new AxBridgeError(transport.message, transport.code);
  }
  return new AxBridgeError(error instanceof Error ? error.message : String(error), 'bridge_error');
}

export class AxBridgeClient {
  private transport: AxTransport | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(notification: AxNotification) => void>();

  constructor(private readonly config: AxBridgeConfig) {}

  get running(): boolean {
    return this.transport !== undefined;
  }

  /**
   * Open the channel to the helper — a resident service when `socketPath` is configured,
   * a spawned child otherwise.
   *
   * The choice is the caller's and is made once here, not per request: the two differ in
   * who holds the Accessibility grant, so silently swapping one for the other would change
   * whether the daemon can see anything at all, without saying so.
   */
  start(): void {
    if (this.transport !== undefined) return;
    const transport = this.makeTransport();
    // Assigned before `start`, because a transport that fails immediately calls back into
    // `failAll` and a half-registered client would swallow the reason.
    this.transport = transport;
    try {
      transport.start({
        onLine: (line) => this.handleLine(line),
        onFail: (error) => {
          this.transport = undefined;
          this.failAll(fromTransport(error));
        },
      });
    } catch (error) {
      this.transport = undefined;
      throw fromTransport(error);
    }
  }

  private makeTransport(): AxTransport {
    const socketPath = this.config.socketPath;
    if (socketPath !== undefined && socketPath !== '') {
      return new SocketTransport({ socketPath, connectFn: this.config.connectFn });
    }
    return new SpawnTransport({ binaryPath: this.config.binaryPath, spawnFn: this.config.spawnFn });
  }

  async stop(): Promise<void> {
    const transport = this.transport;
    this.transport = undefined;
    this.failAll(new AxBridgeError('ax bridge stopped', 'stopped'));
    await transport?.stop();
  }

  /** Send one op and await its correlated reply. */
  request(op: AxOp, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    const transport = this.transport;
    if (transport === undefined) return Promise.reject(new AxBridgeError('ax bridge is not running', 'not_running'));

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AxBridgeError(`op '${op}' timed out after ${this.config.requestTimeoutMs}ms`, 'timeout'));
      }, this.config.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      transport.write(encodeRequest(id, op, params), (error) => this.settle(id, undefined, fromTransport(error)));
    });
  }

  onNotification(listener: (notification: AxNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- typed ops -----------------------------------------------------------

  async trusted(): Promise<boolean> {
    const result = await this.request('trusted');
    return z.object({ trusted: z.boolean() }).parse(result).trusted;
  }

  async apps(): Promise<readonly AxApp[]> {
    return z.array(AxAppSchema).parse(await this.request('apps'));
  }

  async enableAX(pid: number): Promise<void> {
    await this.request('enableAX', { pid });
  }

  /**
   * Every AXWindow of an app, best first, **with the reason when there are
   * none**.
   *
   * Always asked with `meta: true`. The bare form answers an empty array for
   * four different situations — a locked screen, a desktop that is not
   * compositing, windows on another space, and an application genuinely closed
   * to the tray — which are indistinguishable from a count and call for four
   * different responses. With `meta` the helper classifies instead of throwing,
   * and the caller branches on `diagnosis.code`.
   */
  async windows(pid: number): Promise<WindowReading> {
    try {
      return WindowReadingSchema.parse(await this.request('windows', { pid, meta: true }));
    } catch (error) {
      // A locked screen is refused by the helper's dispatch gate, before the
      // handler that would have classified it, so it arrives as a throw even
      // with `meta`. Normalised here so every caller branches on one shape.
      const diagnosis = diagnosisFromError(error);
      if (diagnosis === undefined) throw error;
      return { windows: [], diagnosis };
    }
  }

  /**
   * The helper's full diagnosis for one application, including whether the
   * screen is locked.
   *
   * This is the op to ask when the answer matters: unlike everything that has
   * to resolve a window, it is not gated on the screen being unlocked, so it
   * answers rather than refusing at exactly the moment the answer is wanted.
   */
  async windowInfo(pid: number): Promise<WindowInfo> {
    return WindowInfoSchema.parse(await this.request('windowInfo', { pid }));
  }

  /** Machine-wide diagnostics. Takes no pid and needs no accessibility grant. */
  async env(): Promise<AxEnv> {
    return AxEnvSchema.parse(await this.request('env'));
  }

  /**
   * Whether the Mac is locked, as the helper reads it from the login session.
   *
   * Asked through `env` rather than `windowInfo` because it must not depend on
   * any particular application being alive. `windowInfo` needs a pid; a probe
   * built on it goes dark the moment that app quits, and a screen that unlocked
   * while it was gone would never be noticed — leaving the queue holding work
   * forever against a Mac somebody is sitting in front of.
   *
   * This is the only lock check on this side of the pipe, deliberately: a
   * second one built from what accessibility exposes here would be reading the
   * same session key through a worse lens, and this project has already deleted
   * one such duplicate (see `perception/feishu/reader.ts`).
   */
  async screenState(): Promise<AxScreenState> {
    return (await this.env()).screen;
  }

  /**
   * The roots of an app's accessibility tree — one per window. The helper has
   * always answered with an array; the protocol document describes a single
   * node, so both shapes are accepted and normalized here.
   */
  async roots(pid: number, maxDepth: number, maxNodes: number): Promise<readonly AxNode[]> {
    const result = await this.request('tree', { pid, maxDepth, maxNodes });
    return z.union([z.array(AxNodeSchema), AxNodeSchema.transform((node) => [node])]).parse(result);
  }

  async tree(pid: number, maxDepth: number, maxNodes: number): Promise<AxNode> {
    const roots = await this.roots(pid, maxDepth, maxNodes);
    const first = roots[0];
    if (first === undefined) throw new AxBridgeError(`process ${pid} exposes no accessibility tree`, 'ax_error');
    return first;
  }

  async find(pid: number, selector: AxSelector): Promise<readonly AxNode[]> {
    return z.array(AxNodeSchema).parse(await this.request('find', { pid, selector }));
  }

  /**
   * `find`, with the traversal budget the helper spent. `visited` is how many
   * elements it walked, which is the cheapest signal available for "is this
   * app's tree finished being built" — see `axAwait.ts`.
   */
  async findWithBudget(pid: number, selector: AxSelector, limits: { readonly maxDepth: number; readonly maxNodes: number }): Promise<AxFindBudget> {
    const result = await this.request('find', { pid, selector, maxDepth: limits.maxDepth, maxNodes: limits.maxNodes, meta: true });
    return AxFindBudgetSchema.parse(result);
  }

  async attr(nodeId: number, name: string): Promise<unknown> {
    return await this.request('attr', { nodeId, name });
  }

  async setValue(nodeId: number, value: string): Promise<void> {
    await this.request('setValue', { nodeId, value });
  }

  /**
   * Perform an accessibility action. Defaults to `AXPress`; a named action
   * must be one the element actually exposes, so callers pass through what
   * they read rather than what they expect.
   */
  async press(nodeId: number, action?: string): Promise<void> {
    await this.request('press', { nodeId, ...(action === undefined ? {} : { action }) });
  }

  async focus(nodeId: number): Promise<void> {
    await this.request('focus', { nodeId });
  }

  /**
   * A real mouse click, at a node's centre or at a screen point. Chromium's
   * contenteditable does not take focus from `AXFocused`; only a click routed
   * through the window server puts the caret inside it.
   */
  async click(request: AxClickRequest): Promise<void> {
    const { nodeId, x, y, button, clickCount } = request;
    if (nodeId === undefined && (x === undefined || y === undefined)) {
      throw new AxBridgeError('click needs a nodeId, or both x and y', 'bad_request');
    }
    await this.request('click', {
      ...(nodeId === undefined ? { x, y } : { nodeId }),
      ...(button === undefined ? {} : { button }),
      ...(clickCount === undefined ? {} : { clickCount }),
    });
  }

  /**
   * Focus an element and type into it, in one bridge-side operation.
   *
   * Atomic on purpose. The guarantee this side depends on is that no key is
   * posted unless focus was confirmed to have landed: keys delivered to a
   * Chromium window with focus elsewhere are read as global shortcuts, and
   * the spike closed Feishu's window by typing the letter `w`. Splitting the
   * two would put a race exactly where that failure lives.
   */
  async focusAndType(request: AxFocusAndTypeRequest): Promise<{ readonly focused?: unknown } | undefined> {
    const result = await this.request('focusAndType', { pid: request.pid, nodeId: request.nodeId, text: request.text });
    const parsed = z.object({ focused: z.unknown() }).passthrough().safeParse(result);
    return parsed.success ? parsed.data : undefined;
  }

  /**
   * Wait for an app's accessibility tree to become real, and report what was
   * seen. It does not return the tree: readiness and reading are separate so
   * the expensive traversal happens once, when there is something to traverse.
   */
  async awaitTree(request: AxAwaitTreeRequest): Promise<AxTreeReadiness> {
    return AxTreeReadinessSchema.parse(await this.request('awaitTree', { ...request }));
  }

  async keystroke(pid: number, key: string, modifiers: readonly string[] = []): Promise<void> {
    await this.request('keystroke', { pid, key, modifiers });
  }

  /**
   * A scroll wheel event over an element.
   *
   * Sign follows CoreGraphics, not intuition: a **positive** `deltaY` scrolls
   * the content *up* — towards what came before — and a positive `deltaX`
   * scrolls left. Getting this backwards moves a conversation the wrong way
   * and looks like the scroll did nothing.
   */
  async scroll(request: AxScrollRequest): Promise<void> {
    const { pid, nodeId, deltaX, deltaY, unit } = request;
    await this.request('scroll', { pid, nodeId, deltaX: deltaX ?? 0, deltaY: deltaY ?? 0, ...(unit === undefined ? {} : { unit }) });
  }

  async observe(pid: number, notifications: readonly string[], nodeId?: number): Promise<number> {
    const result = await this.request('observe', { pid, notifications, ...(nodeId === undefined ? {} : { nodeId }) });
    return z.object({ subscription: z.number().int() }).parse(result).subscription;
  }

  async unobserve(subscription: number): Promise<void> {
    await this.request('unobserve', { subscription });
  }

  // --- plumbing ------------------------------------------------------------

  private handleLine(line: string): void {
    const decoded = decodeMessage(line);
    if (!decoded.ok) {
      // A malformed line is the helper's bug, not a reason to stop reading.
      console.error(`[ax-bridge] ${decoded.error}`);
      return;
    }
    if (decoded.message.type === 'notification') {
      for (const listener of this.listeners) listener(decoded.message.notification);
      return;
    }
    const response = decoded.message.response;
    if (response.ok) this.settle(response.id, response.result, undefined);
    else this.settle(response.id, undefined, new AxBridgeError(response.error.message, response.error.code, response.error.details));
  }

  private settle(id: number, value: unknown, error: Error | undefined): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (error === undefined) pending.resolve(value);
    else pending.reject(error);
  }

  private failAll(error: Error): void {
    for (const [id] of this.pending) this.settle(id, undefined, error);
  }
}

export interface AxPerceiverConfig {
  readonly bundleIds: readonly string[];
  readonly notifications: readonly string[];
}

/** UI notifications, seen as events the daemon can route. */
export class AxPerceiver implements Perceiver {
  readonly name = 'macos_ax';
  private queue: AxNotification[] = [];
  private wake: (() => void) | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly client: AxBridgeClient,
    private readonly config: AxPerceiverConfig,
  ) {}

  async *events(signal?: AbortSignal): AsyncIterable<Event> {
    this.client.start();
    if (!(await this.client.trusted())) {
      throw new AxBridgeError('accessibility trust has not been granted to the ax bridge', 'not_trusted');
    }

    const apps = await this.client.apps();
    const watched = apps.filter((app) => this.config.bundleIds.includes(app.bundleId));
    for (const app of watched) {
      await this.client.enableAX(app.pid);
      await this.client.observe(app.pid, this.config.notifications);
    }

    this.unsubscribe = this.client.onNotification((notification) => {
      this.queue.push(notification);
      this.wake?.();
    });

    const byPid = new Map(watched.map((app) => [app.pid, app]));
    while (signal?.aborted !== true) {
      if (this.queue.length === 0) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        this.wake = undefined;
        continue;
      }
      const pending = this.queue;
      this.queue = [];
      for (const notification of pending) yield toEvent(notification, byPid.get(notification.pid)?.name ?? String(notification.pid));
    }
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.client.stop();
  }
}

export function toEvent(notification: AxNotification, appName: string): Event {
  return {
    traceId: `ax-${notification.pid}-${notification.nodeId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: 'macos_ax',
    kind: notification.notification,
    ts: Date.now(),
    payload: {
      text: `${appName} ${notification.notification}`,
      pid: notification.pid,
      nodeId: notification.nodeId,
      subscription: notification.subscription,
      app: appName,
    },
  };
}
