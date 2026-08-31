/**
 * Sending a message in Feishu — the one place in this project that writes to
 * something a human will read.
 *
 * The send now goes through the action layer (`src/actions`), which is what
 * makes it work with Feishu in the background: every step is addressed to the
 * application, nothing asks for the screen, and the element being written to
 * is bound to the reading it was found in. What did not change is the set of
 * guards, because each one exists for something that was demonstrated rather
 * than imagined (`spikes/README.md`, "踩过的坑"):
 *
 * - **Nothing is typed until focus has landed.** With focus outside the
 *   composer, Chromium treats each character as a global shortcut: the spike
 *   navigated away from the chat and closed Feishu's window by typing a `w`.
 *   The focus and the typing are now one bridge-side operation that posts no
 *   key unless focus was confirmed — see `src/actions/keyboard.ts`.
 * - **Nothing is typed with the accessibility write.** `setValue` on a
 *   contenteditable reports success and produces no input event. The action
 *   layer routes web content to the keyboard path and fails loudly when that
 *   path is missing, rather than falling back to the write that lies.
 * - **Nothing is sent until the text is read back out of the composer.**
 *   Enter is the send key and there is no undo.
 * - **Nothing is typed into an app whose accessibility layer is wedged.** The
 *   health check runs before anything else.
 * - **Nothing is sent to a conversation that was not asked for.** The target
 *   is resolved from the event's own trace id, checked against the allowlist,
 *   and compared with the title on screen — in the same reading the write is
 *   bound to, so nothing can change between the check and the write.
 * - **The same text is not sent twice inside the dedupe window.**
 */
import { z } from 'zod';
import type { Executor, ToolResult } from '../base.js';
import { describeError, fail, ok } from '../base.js';
import type { ActionDriver } from '../../actions/driver.js';
import type { SnapshotElement, SnapshotStore } from '../../actions/snapshot.js';
import type { ChatRouteTable } from '../../perception/feishu/chatRoutes.js';
import type { FeishuReader } from '../../perception/feishu/reader.js';
import type { FeishuHealthMonitor } from '../../perception/feishu/health.js';
import type { SentLedger } from '../../perception/feishu/sentLedger.js';
import type { OpenChat } from '../../perception/feishu/elements.js';
import { locateOpenChat } from '../../perception/feishu/elements.js';
import { FEISHU_BUNDLE_ID, SEND_KEY } from '../../perception/feishu/selectors.js';

export const FEISHU_REPLY_TOOL = 'feishu.reply';

/** A line break inside the composer. A bare Enter would send the message. */
export const NEWLINE_KEY = `shift+${SEND_KEY}`;

export interface FeishuSenderConfig {
  /** How the action layer is to name the app: its bundle identifier. */
  readonly app: string;
  /** Conversations this executor may write to. Empty means it may write to none. */
  readonly allowedChats: readonly string[];
  /** Identical text to the same chat is dropped inside this window. */
  readonly dedupeWindowMs: number;
  readonly echoTimeoutMs: number;
  readonly echoIntervalMs: number;
  /** Longer text is truncated rather than refused; a reply still gets through. */
  readonly maxTextLength: number;
}

export const DEFAULT_FEISHU_SENDER_CONFIG: FeishuSenderConfig = {
  app: FEISHU_BUNDLE_ID,
  allowedChats: [],
  dedupeWindowMs: 30_000,
  echoTimeoutMs: 5_000,
  echoIntervalMs: 400,
  maxTextLength: 2_000,
};

export interface FeishuSenderDeps {
  /** The action layer. Every keystroke and every read of the UI goes here. */
  readonly actions: ActionDriver;
  /** Where the reading behind a `snapshot_id` lives, for locating elements. */
  readonly snapshots: SnapshotStore;
  /** Still used for the echo: it parses messages, which the raw reading does not. */
  readonly reader: FeishuReader;
  /** Consulted before any input is synthesized. */
  readonly monitor: FeishuHealthMonitor;
  readonly routes: ChatRouteTable;
  /** Everything sent is recorded here so the perceiver skips its own echo. */
  readonly ledger: SentLedger;
  readonly config: FeishuSenderConfig;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const ReplyArgsSchema = z
  .object({
    text: z.string().min(1, 'reply text must not be empty'),
    /** Explicit target. Usually omitted in favour of `trace_id`. */
    chat: z.string().optional(),
    /** The event being answered; its origin conversation is the target. */
    trace_id: z.string().optional(),
  })
  .passthrough();

export interface ReplyOutcome {
  readonly sent: boolean;
  readonly chat: string;
  readonly echoedMessageId: string | undefined;
  readonly deduped: boolean;
}

/** One reading, and the token that binds an index to it. */
interface Reading {
  readonly snapshotId: string;
  readonly app: string;
  readonly elements: readonly SnapshotElement[];
  readonly chat: OpenChat | undefined;
}

export class FeishuExecutor implements Executor {
  readonly kind = 'feishu';
  private lastSent = new Map<string, number>();

  constructor(private readonly deps: FeishuSenderDeps) {}

  supports(tool: string): boolean {
    return tool === FEISHU_REPLY_TOOL;
  }

  names(): readonly string[] {
    return [FEISHU_REPLY_TOOL];
  }

  async run(tool: string, args: Readonly<Record<string, string>>): Promise<ToolResult> {
    const started = this.now();
    if (tool !== FEISHU_REPLY_TOOL) return fail(`unknown feishu tool '${tool}'`, 0);

    const parsed = ReplyArgsSchema.safeParse(args);
    if (!parsed.success) return fail(parsed.error.issues.map((issue) => issue.message).join('; '), this.now() - started);

    const text = clip(parsed.data.text.trim(), this.deps.config.maxTextLength);
    if (text === '') return fail('reply text must not be empty', this.now() - started);
    const target = this.resolveChat(parsed.data.chat, parsed.data.trace_id);
    if (target === undefined) {
      return fail(`${FEISHU_REPLY_TOOL} has no target: pass 'chat', or a 'trace_id' whose event came from Feishu`, this.now() - started);
    }
    if (!this.deps.config.allowedChats.includes(target)) {
      return fail(`refusing to write to '${target}': it is not in feishu.allowedChats`, this.now() - started);
    }

    const guard = this.dedupeKey(target, text);
    const previous = this.lastSent.get(guard);
    if (previous !== undefined && this.now() - previous < this.deps.config.dedupeWindowMs) {
      const outcome: ReplyOutcome = { sent: false, chat: target, echoedMessageId: undefined, deduped: true };
      return ok(outcome, this.now() - started);
    }

    try {
      return ok(await this.send(target, text), this.now() - started);
    } catch (error) {
      return fail(describeError(error), this.now() - started);
    }
  }

  // --- the send itself -----------------------------------------------------

  private async send(target: string, text: string): Promise<ReplyOutcome> {
    // `require` throws on a wedged app; a merely absent window is an ordinary
    // failure of this send, not a reason to keep hammering the accessibility API.
    const health = await this.deps.monitor.require();
    if (health.state !== 'ok') throw new Error(health.detail);

    const before = await this.read();
    const composer = this.composerOf(before, target);

    await this.write(before, composer, text);

    const staged = await this.read();
    if (!contains(staged.chat?.composerText ?? '', text)) {
      await this.clearComposer(staged);
      throw new Error('the composer does not contain the reply after typing it; nothing was sent');
    }

    // Past this line the message is on its way, so the dedupe guard is armed
    // before the key that sends it, not after a confirmation that may not come.
    this.rememberSent(this.dedupeKey(target, text));
    // Recorded before the key that sends it: the perceiver may read the message
    // back before `awaitEcho` returns, and it must already know whose it is.
    this.deps.ledger.record(text);
    await this.deps.actions.press_key({ app: this.deps.config.app, key: SEND_KEY });

    const echoedMessageId = await this.awaitEcho(text);
    this.deps.ledger.record(text, echoedMessageId);
    return { sent: true, chat: target, echoedMessageId, deduped: false };
  }

  /**
   * Put the reply in the composer.
   *
   * The first line replaces whatever was there, through the composer's own
   * element; the rest are separated by Shift+Enter, because a bare Enter is
   * the send key and a multi-line reply typed naively would send its first
   * line and scatter the remainder across follow-up messages.
   */
  private async write(reading: Reading, composerIndex: number, text: string): Promise<void> {
    const [first = '', ...rest] = text.split(/\r\n|\r|\n/);
    await this.deps.actions.set_value({ app: reading.app, element_index: composerIndex, snapshot_id: reading.snapshotId, value: first });
    for (const line of rest) {
      await this.deps.actions.press_key({ app: reading.app, key: NEWLINE_KEY });
      if (line !== '') await this.deps.actions.type_text({ app: reading.app, text: line });
    }
  }

  /**
   * The composer's index in this reading, having established that the
   * conversation on screen is the one being answered. Both checks are made
   * against the same reading the write will be bound to.
   */
  private composerOf(reading: Reading, target: string): number {
    const chat = reading.chat;
    if (chat === undefined) throw new Error('no Feishu conversation is open');
    if (chat.chatTitle !== target) {
      throw new Error(`the open conversation is '${chat.chatTitle}', not '${target}'; refusing to send into the wrong chat`);
    }
    if (chat.composerIndex === undefined) throw new Error(`conversation '${target}' exposes no composer`);
    return chat.composerIndex;
  }

  /** Best-effort: a failed send must not leave a half-typed draft behind. */
  private async clearComposer(reading: Reading): Promise<void> {
    const index = reading.chat?.composerIndex;
    if (index === undefined) return;
    await this.deps.actions
      .set_value({ app: reading.app, element_index: index, snapshot_id: reading.snapshotId, value: '' })
      .catch(() => undefined);
  }

  /** One full reading of the app, and the elements behind it. */
  private async read(): Promise<Reading> {
    const state = await this.deps.actions.get_app_state({ app: this.deps.config.app, disableDiff: true });
    const snapshot = this.deps.snapshots.current(state.app);
    if (snapshot === undefined || snapshot.snapshotId !== state.snapshotId) {
      throw new Error(`the reading of '${state.app}' went stale between taking it and using it; nothing was sent`);
    }
    return { snapshotId: state.snapshotId, app: state.app, elements: snapshot.elements, chat: locateOpenChat(snapshot.elements) };
  }

  /** Read the sent message back out of the conversation, for its real id. */
  private async awaitEcho(text: string): Promise<string | undefined> {
    const deadline = this.now() + this.deps.config.echoTimeoutMs;
    for (;;) {
      const snapshot = await this.deps.reader.snapshot();
      const echo = [...snapshot.messages].reverse().find((message) => message.isSelf && contains(message.text, text));
      if (echo !== undefined) return echo.id;
      if (this.now() >= deadline) return undefined;
      await this.sleep(this.deps.config.echoIntervalMs);
    }
  }

  // --- helpers -------------------------------------------------------------

  private resolveChat(explicit: string | undefined, traceId: string | undefined): string | undefined {
    const named = explicit?.trim();
    if (named !== undefined && named !== '') return named;
    if (traceId === undefined || traceId === '') return undefined;
    return this.deps.routes.lookup(traceId)?.chatTitle;
  }

  private dedupeKey(chat: string, text: string): string {
    return `${chat} ${text}`;
  }

  private rememberSent(key: string): void {
    const now = this.now();
    const next = new Map(this.lastSent);
    for (const [existing, ts] of next) {
      if (now - ts >= this.deps.config.dedupeWindowMs) next.delete(existing);
    }
    next.set(key, now);
    this.lastSent = next;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    if (this.deps.sleep !== undefined) return this.deps.sleep(ms);
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

/** Whitespace-insensitive containment: Feishu pads its text nodes. */
function contains(haystack: string, needle: string): boolean {
  return squash(haystack).includes(squash(needle)) && squash(needle) !== '';
}

/**
 * Feishu's composer pads its text nodes with zero-width characters (the
 * placeholder alone carries three), so any comparison against typed text has
 * to ignore whitespace and the invisibles: U+200B..U+200D and U+FEFF.
 */
function squash(text: string): string {
  return text.replace(/(?:\s|\u200B|\u200C|\u200D|\uFEFF)+/gu, '');
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
