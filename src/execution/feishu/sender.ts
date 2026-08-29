/**
 * Sending a message in Feishu — the one place in this project that writes to
 * something a human will read.
 *
 * Every guard below exists because the alternative was demonstrated, not
 * imagined (`spikes/README.md`, "踩过的坑"):
 *
 * - **Nothing is typed until focus is confirmed.** With focus outside the
 *   composer, Chromium treats each character as a global shortcut: the spike
 *   navigated away from the chat and closed Feishu's window by typing a `w`.
 *   So the composer is clicked (`AXFocused` does not work on a contenteditable)
 *   and the app is asked who holds focus, and a failed check sends zero keys.
 * - **Nothing is sent until the text is read back out of the composer.** Enter
 *   is the send key and there is no undo.
 * - **Nothing is typed into an app whose accessibility layer is wedged.** The
 *   health check runs before the first click, so a broken Feishu produces a
 *   readable error instead of keystrokes fired into nowhere.
 * - **Nothing is sent to a conversation that was not asked for.** The target
 *   chat is resolved from the event's own trace id, checked against the
 *   allowlist, and compared with the title actually on screen.
 * - **The same text is not sent twice inside the dedupe window.** A retry, a
 *   double-routed event or a re-planned chain must not double-message a person.
 */
import { z } from 'zod';
import type { Executor, ToolResult } from '../base.js';
import { describeError, fail, ok } from '../base.js';
import type { ChatRouteTable } from '../../perception/feishu/chatRoutes.js';
import type { FeishuReader } from '../../perception/feishu/reader.js';
import type { FeishuHealthMonitor } from '../../perception/feishu/health.js';
import type { SentLedger } from '../../perception/feishu/sentLedger.js';
import type { AxBridgeClient } from '../../perception/macos/axBridge.js';
import { COMMAND_MODIFIER, DELETE_KEY, DOM_CLASS, SELECT_ALL_KEY, SEND_KEY } from '../../perception/feishu/selectors.js';

export const FEISHU_REPLY_TOOL = 'feishu.reply';

export interface FeishuSenderConfig {
  /** Conversations this executor may write to. Empty means it may write to none. */
  readonly allowedChats: readonly string[];
  /** Identical text to the same chat is dropped inside this window. */
  readonly dedupeWindowMs: number;
  readonly focusAttempts: number;
  readonly focusSettleMs: number;
  readonly typeSettleMs: number;
  readonly echoTimeoutMs: number;
  readonly echoIntervalMs: number;
  /** Longer text is truncated rather than refused; a reply still gets through. */
  readonly maxTextLength: number;
}

export const DEFAULT_FEISHU_SENDER_CONFIG: FeishuSenderConfig = {
  allowedChats: [],
  dedupeWindowMs: 30_000,
  focusAttempts: 3,
  focusSettleMs: 600,
  typeSettleMs: 300,
  echoTimeoutMs: 5_000,
  echoIntervalMs: 400,
  maxTextLength: 2_000,
};

export interface FeishuSenderDeps {
  readonly client: AxBridgeClient;
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

    const before = await this.deps.reader.snapshot();
    if (!before.hasOpenChat) throw new Error('no Feishu conversation is open');
    if (before.chatTitle !== target) {
      throw new Error(`the open conversation is '${before.chatTitle}', not '${target}'; refusing to send into the wrong chat`);
    }
    const composer = before.composerNodeId;
    if (composer === undefined) throw new Error(`conversation '${target}' exposes no composer`);

    if (!(await this.focusComposer(composer))) {
      throw new Error('could not put the caret in the composer; sent no keystrokes');
    }

    await this.clearComposer(health.pid);
    await this.typeText(health.pid, text);
    await this.sleep(this.deps.config.typeSettleMs);

    const staged = await this.deps.reader.snapshot();
    if (!contains(staged.composerText, text)) {
      await this.clearComposer(health.pid);
      throw new Error('the composer does not contain the reply after typing it; nothing was sent');
    }

    // Past this line the message is on its way, so the dedupe guard is armed
    // before the key that sends it, not after a confirmation that may not come.
    this.rememberSent(this.dedupeKey(target, text));
    // Recorded before the key that sends it: the perceiver may read the message
    // back before `awaitEcho` returns, and it must already know whose it is.
    this.deps.ledger.record(text);
    await this.deps.client.keystroke(health.pid, SEND_KEY);

    const echoedMessageId = await this.awaitEcho(text);
    this.deps.ledger.record(text, echoedMessageId);
    return { sent: true, chat: target, echoedMessageId, deduped: false };
  }

  /**
   * Click into the composer until the app agrees that is where focus is.
   * Compared by DOM class because Chromium returns a fresh `AXUIElement`
   * handle for the same element on every call.
   */
  private async focusComposer(composerNodeId: number): Promise<boolean> {
    for (let attempt = 0; attempt < this.deps.config.focusAttempts; attempt += 1) {
      await this.deps.client.click(composerNodeId);
      await this.sleep(this.deps.config.focusSettleMs);
      const classes = await this.deps.reader.focusedDomClasses();
      if (classes.includes(DOM_CLASS.composer)) return true;
    }
    return false;
  }

  private async clearComposer(pid: number): Promise<void> {
    await this.deps.client.keystroke(pid, SELECT_ALL_KEY, COMMAND_MODIFIER);
    await this.deps.client.keystroke(pid, DELETE_KEY);
  }

  /**
   * Type the reply. Line breaks are Shift+Enter: a bare Enter is the send key,
   * so a multi-line reply typed naively would send its first line and then
   * scatter the rest across follow-up messages.
   */
  private async typeText(pid: number, text: string): Promise<void> {
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
      if (index > 0) await this.deps.client.keystroke(pid, SEND_KEY, ['shift']);
      if (line !== '') await this.deps.client.keystroke(pid, line);
    }
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
    return `${chat} ${text}`;
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
