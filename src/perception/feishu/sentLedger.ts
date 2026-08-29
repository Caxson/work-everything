/**
 * What this daemon has said, so it never answers itself.
 *
 * The obvious anti-loop guard — "ignore messages the account sent" — is wrong
 * in both directions:
 *
 * - In a **chat with yourself** every message is `message-self`, including the
 *   ones the user types as commands. That guard would make the safest
 *   conversation to test in the one conversation that can never work.
 * - In any chat, the daemon's own replies differ every time (`pong <clock>`),
 *   so the sender's identical-text guard does not catch them. Perceiving one
 *   routes it, which produces another reply, which is perceived… The loop runs
 *   in a real person's chat window until someone kills the process.
 *
 * So the guard is authorship, not direction: a message is skipped when *this
 * daemon* sent it. The message id read back after a send is exact; the text
 * window covers the case where the read-back did not resolve in time.
 */

export interface SentLedgerConfig {
  /** How long a sent text keeps suppressing an identical message. */
  readonly windowMs: number;
  /** Ids and texts retained before the oldest are dropped. */
  readonly capacity: number;
}

export const DEFAULT_SENT_LEDGER_CONFIG: SentLedgerConfig = { windowMs: 120_000, capacity: 200 };

interface SentText {
  readonly text: string;
  readonly ts: number;
}

export class SentLedger {
  private ids: readonly string[] = [];
  private idSet = new Set<string>();
  private texts: readonly SentText[] = [];

  constructor(
    private readonly config: SentLedgerConfig = DEFAULT_SENT_LEDGER_CONFIG,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Called by the sender for everything it puts in a conversation. */
  record(text: string, messageId?: string): void {
    const now = this.clock();
    this.texts = [...this.texts, { text: squash(text), ts: now }].slice(-this.config.capacity);
    if (messageId === undefined || messageId === '') return;
    const ids = [...this.ids.filter((id) => id !== messageId), messageId].slice(-this.config.capacity);
    this.ids = ids;
    this.idSet = new Set(ids);
  }

  /** Whether this daemon is the author of the message just read back. */
  wasSentByUs(message: { readonly id: string; readonly text: string }): boolean {
    if (this.idSet.has(message.id)) return true;
    const needle = squash(message.text);
    if (needle === '') return false;
    const cutoff = this.clock() - this.config.windowMs;
    return this.texts.some((entry) => entry.ts >= cutoff && entry.text === needle);
  }

  get size(): number {
    return this.texts.length;
  }
}

function squash(text: string): string {
  return text.replace(/(?:\s|\u200B|\u200C|\u200D|\uFEFF)+/gu, '');
}
