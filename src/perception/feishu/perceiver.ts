/**
 * Feishu as an event source.
 *
 * Two guards decide whether anything at all leaves this file, and both fail
 * closed:
 *
 * - **The allowlist.** Only conversations named in `allowedChats` produce
 *   events. The default is empty, which means a freshly configured daemon
 *   watches nothing. Reading everything the user says to their colleagues and
 *   handing it to a model is not a default anyone should get by accident.
 * - **The authorship filter.** A message this daemon sent is never an event
 *   (see `sentLedger.ts` for why direction is the wrong test). Without it the
 *   daemon's own reply is perceived as new input and answers itself, forever,
 *   in the user's real chat window. In a conversation with someone else the
 *   user's own outgoing messages are ignored too — talking to a colleague is
 *   not a command. In a chat with yourself there is no such distinction, and
 *   everything you type is addressed to the daemon.
 *
 * Beyond that: the message list is virtualized and the conversation on screen
 * changes under us, so a chat is *primed* the first time it is seen — its
 * visible history is recorded as already-known and emits nothing. Only what
 * appears after that is new.
 */
import type { Event } from '../../core/events.js';
import type { Perceiver } from '../base.js';
import type { AxBridgeClient } from '../macos/axBridge.js';
import { AxBridgeError } from '../macos/axBridge.js';
import type { ChatRouteTable } from './chatRoutes.js';
import type { ChatSnapshot, FeishuMessage } from './messages.js';
import type { FeishuReader } from './reader.js';
import type { SentLedger } from './sentLedger.js';
import { FEISHU_NOTIFICATIONS } from './selectors.js';

export interface FeishuPerceiverConfig {
  /** Conversation titles that may produce events. Empty means none. */
  readonly allowedChats: readonly string[];
  /** Fallback sweep when no accessibility notification arrives. */
  readonly pollIntervalMs: number;
  /** How long to let a burst of notifications settle before reading. */
  readonly debounceMs: number;
  /** Fingerprints remembered before the oldest are forgotten. */
  readonly memory: number;
}

export const DEFAULT_FEISHU_PERCEIVER_CONFIG: FeishuPerceiverConfig = {
  allowedChats: [],
  pollIntervalMs: 3_000,
  debounceMs: 250,
  memory: 2_000,
};

export interface FeishuPerceiverDeps {
  readonly client: AxBridgeClient;
  readonly reader: FeishuReader;
  readonly routes: ChatRouteTable;
  /** What the sender has already put in these conversations. */
  readonly ledger: SentLedger;
  readonly config: FeishuPerceiverConfig;
  /** Diagnostics. Defaults to stderr; injected in tests. */
  readonly onWarn?: (message: string) => void;
}

export class FeishuPerceiver implements Perceiver {
  readonly name = 'feishu';
  private seen: readonly string[] = [];
  private seenSet = new Set<string>();
  private primed = new Set<string>();
  private observedPid: number | undefined;
  private subscription: number | undefined;
  private unsubscribe: (() => void) | undefined;
  private wake: (() => void) | undefined;
  private dirty = false;
  private stopped = false;

  constructor(private readonly deps: FeishuPerceiverDeps) {}

  async *events(signal?: AbortSignal): AsyncIterable<Event> {
    const { client } = this.deps;
    client.start();
    if (!(await client.trusted())) {
      throw new AxBridgeError('accessibility trust has not been granted; grant it to the app that starts the daemon', 'not_trusted');
    }
    this.unsubscribe = client.onNotification(() => {
      this.dirty = true;
      this.wake?.();
    });

    const aborted = (): boolean => signal?.aborted === true;
    while (!aborted() && !this.stopped) {
      await this.settle(signal);
      if (aborted() || this.stopped) break;
      for (const event of await this.sweep()) yield event;
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const subscription = this.subscription;
    this.subscription = undefined;
    if (subscription !== undefined) {
      try {
        await this.deps.client.unobserve(subscription);
      } catch {
        // The bridge may already be gone; nothing left to release.
      }
    }
  }

  /** Wait for a notification, or for the fallback poll interval to elapse. */
  private async settle(signal?: AbortSignal): Promise<void> {
    if (this.dirty) {
      this.dirty = false;
      await delay(this.deps.config.debounceMs, signal);
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, this.deps.config.pollIntervalMs);
      const onAbort = (): void => finish();
      function finish(): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }
      this.wake = finish;
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    this.wake = undefined;
    this.dirty = false;
  }

  /** One read of Feishu, turned into whatever events it justifies. */
  private async sweep(): Promise<readonly Event[]> {
    try {
      await this.ensureObserver();
      const snapshot = await this.deps.reader.snapshot();
      if (!snapshot.hasOpenChat || snapshot.chatTitle === '') return [];

      const fresh = snapshot.messages.filter((message) => !this.seenSet.has(message.fingerprint));
      this.remember(snapshot.messages.map((message) => message.fingerprint));

      // First sight of a conversation is history, not news.
      if (!this.primed.has(snapshot.chatTitle)) {
        this.primed = new Set(this.primed).add(snapshot.chatTitle);
        return [];
      }
      if (!this.deps.config.allowedChats.includes(snapshot.chatTitle)) return [];

      return fresh.filter((message) => this.isActionable(message, snapshot)).map((message) => this.toEvent(message));
    } catch (error) {
      this.warn(error instanceof Error ? error.message : String(error));
      // Feishu restarting gives it a new pid, and every later call against the
      // cached one fails the same way forever. Drop the pid and the
      // subscription so the next sweep resolves both again.
      this.observedPid = undefined;
      this.subscription = undefined;
      return [];
    }
  }

  private async ensureObserver(): Promise<void> {
    const pid = await this.deps.reader.pid(this.observedPid === undefined);
    if (this.observedPid === pid && this.subscription !== undefined) return;
    if (this.subscription !== undefined) {
      try {
        await this.deps.client.unobserve(this.subscription);
      } catch {
        // Stale subscription against a pid that is gone. Nothing to release.
      }
    }
    await this.deps.client.enableAX(pid).catch(() => undefined);
    this.subscription = await this.deps.client.observe(pid, FEISHU_NOTIFICATIONS);
    this.observedPid = pid;
  }

  /**
   * A message worth waking the router for: words in it, not written by this
   * daemon, and — outside a chat with yourself — not written by the user.
   */
  private isActionable(message: FeishuMessage, snapshot: ChatSnapshot): boolean {
    if (message.text.trim() === '') return false;
    if (this.deps.ledger.wasSentByUs(message)) return false;
    return snapshot.isSelfChat || !message.isSelf;
  }

  private toEvent(message: FeishuMessage): Event {
    const traceId = `feishu-${message.fingerprint}`;
    this.deps.routes.remember(traceId, { chatTitle: message.chatTitle, messageId: message.id, ts: message.ts });
    return {
      traceId,
      source: 'feishu',
      kind: 'message',
      ts: message.ts,
      payload: {
        text: message.text,
        chat: message.chatTitle,
        sender: message.sender,
        messageId: message.id,
        messageKind: message.kind,
        isSelf: message.isSelf,
      },
    };
  }

  private remember(fingerprints: readonly string[]): void {
    const unseen = fingerprints.filter((fingerprint) => !this.seenSet.has(fingerprint));
    if (unseen.length === 0) return;
    const next = [...this.seen, ...unseen].slice(-this.deps.config.memory);
    this.seen = next;
    this.seenSet = new Set(next);
  }

  private warn(message: string): void {
    const onWarn = this.deps.onWarn;
    if (onWarn !== undefined) onWarn(message);
    else console.error(`[feishu] ${message}`);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    const onAbort = (): void => finish();
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
