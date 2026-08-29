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
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Event } from '../../core/events.js';
import type { Perceiver } from '../base.js';
import type { AxApp, AxNode, AxNotification, AxOp, AxSelector } from './axProtocol.js';
import { AxAppSchema, AxNodeSchema, createLineDecoder, decodeMessage, encodeRequest } from './axProtocol.js';
import { z } from 'zod';

export class AxBridgeError extends Error {
  constructor(
    message: string,
    readonly code = 'bridge_error',
  ) {
    super(message);
    this.name = 'AxBridgeError';
  }
}

export interface AxBridgeConfig {
  /** Path to the `we-ax` binary produced by `native/ax-bridge`. */
  readonly binaryPath: string;
  readonly requestTimeoutMs: number;
  /** Injectable so tests can drive a stand-in helper over real pipes. */
  readonly spawnFn?: (binaryPath: string) => ChildProcessWithoutNullStreams;
}

export const DEFAULT_AX_TIMEOUT_MS = 10_000;

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class AxBridgeClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(notification: AxNotification) => void>();
  private stderrTail = '';

  constructor(private readonly config: AxBridgeConfig) {}

  get running(): boolean {
    return this.child !== undefined;
  }

  /**
   * Start the helper. A missing binary is the common case on a fresh
   * checkout, so it gets its own message rather than an ENOENT from spawn.
   */
  start(): void {
    if (this.child !== undefined) return;
    if (this.config.spawnFn === undefined && !existsSync(this.config.binaryPath)) {
      throw new AxBridgeError(
        `ax bridge binary not found at ${this.config.binaryPath}. Build it from native/ax-bridge, or set axBridge.binaryPath in the config.`,
        'binary_missing',
      );
    }

    const child = this.config.spawnFn?.(this.config.binaryPath) ?? spawn(this.config.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;

    const decode = createLineDecoder();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      for (const line of decode(chunk)) this.handleLine(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-2000);
    });
    child.on('error', (error) => this.failAll(new AxBridgeError(`ax bridge failed to start: ${error.message}`, 'spawn_failed')));
    child.on('close', (code) => {
      this.child = undefined;
      const detail = this.stderrTail.trim().split('\n').slice(-1)[0] ?? '';
      this.failAll(new AxBridgeError(`ax bridge exited (${code ?? -1})${detail === '' ? '' : `: ${detail}`}`, 'bridge_exited'));
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.failAll(new AxBridgeError('ax bridge stopped', 'stopped'));
    if (child === undefined) return;
    await new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 1000).unref?.();
    });
  }

  /** Send one op and await its correlated reply. */
  request(op: AxOp, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    const child = this.child;
    if (child === undefined) return Promise.reject(new AxBridgeError('ax bridge is not running', 'not_running'));

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AxBridgeError(`op '${op}' timed out after ${this.config.requestTimeoutMs}ms`, 'timeout'));
      }, this.config.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(encodeRequest(id, op, params), (error) => {
        if (error) {
          this.settle(id, undefined, new AxBridgeError(`write failed: ${error.message}`, 'write_failed'));
        }
      });
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

  async tree(pid: number, maxDepth: number, maxNodes: number): Promise<AxNode> {
    return AxNodeSchema.parse(await this.request('tree', { pid, maxDepth, maxNodes }));
  }

  async find(pid: number, selector: AxSelector): Promise<readonly AxNode[]> {
    return z.array(AxNodeSchema).parse(await this.request('find', { pid, selector }));
  }

  async attr(nodeId: number, name: string): Promise<unknown> {
    return await this.request('attr', { nodeId, name });
  }

  async setValue(nodeId: number, value: string): Promise<void> {
    await this.request('setValue', { nodeId, value });
  }

  async press(nodeId: number): Promise<void> {
    await this.request('press', { nodeId });
  }

  async focus(nodeId: number): Promise<void> {
    await this.request('focus', { nodeId });
  }

  async keystroke(pid: number, key: string, modifiers: readonly string[] = []): Promise<void> {
    await this.request('keystroke', { pid, key, modifiers });
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
    else this.settle(response.id, undefined, new AxBridgeError(response.error.message, response.error.code));
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
