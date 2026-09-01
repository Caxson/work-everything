/**
 * Re-checking the premise of an action that waited.
 *
 * An action queued behind a locked screen was formed against a world: a
 * conversation with a particular name, a message that existed, a target that
 * was the person being answered. None of that is guaranteed to survive the
 * wait, and the failure is silent — the action still runs, still succeeds, and
 * lands somewhere nobody asked for. So the premise is captured as plain facts
 * at enqueue and read back before the action is allowed to run.
 *
 * Two decisions here are deliberate and worth stating:
 *
 * - **The registry starts empty and an unregistered kind fails.** An action
 *   whose premise nothing knows how to re-read does not get to run after a
 *   delay. The alternative — treating "no checker" as "no objection" — makes
 *   the whole gate opt-in, which is exactly backwards for a mechanism whose
 *   only job is to stop stale work.
 * - **A failed check has two flavours.** `broken` means the premise is gone
 *   and the action never becomes valid again; it is dropped. `not_yet` means
 *   the premise is intact but the world is momentarily not in a state where
 *   the action can run — the conversation it answers is not the one on screen,
 *   say. That one keeps waiting, bounded by the action's own TTL, because
 *   dropping it would punish an action for the user's scrolling.
 *
 * Nothing here knows what any particular action is. A checker is registered by
 * whoever owns that action's meaning.
 */
import type { PreconditionCheck } from './deferred.js';

/**
 * A checker's answer.
 *
 * `detail` is carried on every outcome, not just failures: it is what the
 * trajectory and `we queue` show, and "held: chat 'Ops' still open" is worth
 * as much as the reason it did not.
 */
export type PreconditionVerdict =
  | { readonly state: 'holds'; readonly detail: string }
  | { readonly state: 'broken'; readonly detail: string }
  | { readonly state: 'not_yet'; readonly detail: string };

export const holds = (detail: string): PreconditionVerdict => ({ state: 'holds', detail });
export const broken = (detail: string): PreconditionVerdict => ({ state: 'broken', detail });
export const notYet = (detail: string): PreconditionVerdict => ({ state: 'not_yet', detail });

/**
 * Reads the live world and says whether the captured facts still describe it.
 * Given the facts alone: a checker that needed the whole action would be
 * tempted to re-derive the premise instead of re-checking it.
 */
export type PreconditionChecker = (facts: Readonly<Record<string, string>>) => Promise<PreconditionVerdict>;

export class PreconditionRegistry {
  private checkers = new Map<string, PreconditionChecker>();

  /** Later registrations replace earlier ones for the same kind. */
  register(kind: string, checker: PreconditionChecker): void {
    const next = new Map(this.checkers);
    next.set(kind, checker);
    this.checkers = next;
  }

  knows(kind: string): boolean {
    return this.checkers.has(kind);
  }

  get kinds(): readonly string[] {
    return [...this.checkers.keys()].sort();
  }

  /**
   * Re-check one premise. A checker that throws is reported as `broken` rather
   * than allowed to escape: a premise that cannot be read is not a premise
   * that holds, and an exception must not become an execution.
   */
  async check(precondition: PreconditionCheck): Promise<PreconditionVerdict> {
    const checker = this.checkers.get(precondition.kind);
    if (checker === undefined) {
      return broken(`nothing knows how to re-check a '${precondition.kind}' premise, so it was not run`);
    }
    try {
      return await checker(precondition.facts);
    } catch (error) {
      return broken(`re-checking the premise failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** A checker with a fixed answer. For tests and for genuinely premise-free work. */
export function fixedChecker(verdict: PreconditionVerdict): PreconditionChecker {
  return async () => verdict;
}
