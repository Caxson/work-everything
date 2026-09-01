/**
 * What a queued Feishu reply assumed, and how to read it back later.
 *
 * The queue itself knows nothing about conversations — it holds facts and a
 * checker name. This file is the one place that knows what those facts mean for
 * a reply, and it exists because "send this text" is not a complete description
 * of a reply. The complete description is *send this text, to this person,
 * about that message*, and the last two parts are the ones a wait can quietly
 * invalidate while the first stays true.
 *
 * A reply that **names** its own conversation is checked differently from one
 * that inherited the sender's, and the fact says which: an ops-channel chain
 * with a literal `chat` was never answering anybody, so comparing it against
 * the event's origin would condemn it every time it was queued — a policy that
 * differed between a locked screen and an open one, which is the one thing the
 * gate exists to avoid.
 *
 * The target is resolved **at capture time**, not at execution time. The
 * sender's own rule is that a reply goes to the conversation the event came
 * from rather than whatever is on screen when the text is ready; a deferred
 * reply stretches that gap from seconds to minutes, so the answer is pinned
 * while it is still known and re-checked against two independent records of it
 * afterwards — the in-memory route table, and the origin event's own
 * trajectory, which is what survives a restart.
 *
 * The severities are chosen, not incidental:
 *
 * - **Broken** is for being aimed at the wrong person: a target that has left
 *   the allowlist, or an origin event that turns out to have come from a
 *   different conversation than the queued reply names. Nothing about waiting
 *   longer fixes either, and both are the failure that actually matters.
 * - **Not yet** is for the conversation not being the one on screen, and for
 *   the answered message not being visible in it. Both are ordinary and
 *   recoverable — the daemon never switches conversations itself, so it simply
 *   waits for the one it needs, bounded by the action's TTL.
 *
 * One limit is worth stating rather than papering over: a message that was
 * *recalled* and one that has merely been scrolled out of view look identical
 * from a snapshot of the visible tree. Both come back as `not_yet`, so a
 * recalled message is not reported as such — it waits, and is then dropped as
 * expired. The reply does not go out either way, which is the part that counts.
 */
import { renderArgs } from '../../core/engine.js';
import { chainSteps } from '../../core/scenario.js';
import type { ChatRouteTable } from '../../perception/feishu/chatRoutes.js';
import type { CaptureFn, DeferralCapture } from '../../queue/gate.js';
import type { PreconditionChecker, PreconditionVerdict } from '../../queue/preconditions.js';
import { broken, holds, notYet } from '../../queue/preconditions.js';
import { FEISHU_REPLY_TOOL } from './sender.js';

/** The checker name stored on every deferred reply. */
export const FEISHU_REPLY_PREMISE = 'feishu.reply';

/** What the conversation looks like right now, as far as this check cares. */
export interface OpenConversation {
  readonly title: string;
  readonly messageIds: readonly string[];
}

export interface ReplyCaptureDeps {
  /** The same table the sender resolves targets through. */
  readonly routes: ChatRouteTable;
}

/**
 * Describe a chain that sends a Feishu reply.
 *
 * Returns `undefined` — refusing deferral — for anything it cannot pin down: a
 * chain with no reply in it, one with several (whose target would be
 * ambiguous), or one whose target cannot be resolved yet because it depends on
 * an earlier step's output that has not run.
 */
export function feishuReplyCapture(deps: ReplyCaptureDeps): CaptureFn {
  return (request) => {
    const replies = chainSteps(request.chain.chain).filter((step) => step.tool === FEISHU_REPLY_TOOL);
    const step = replies[0];
    if (step === undefined || replies.length > 1) return undefined;

    const args = renderArgs(step, request.vars);
    const traceId = pick(args['trace_id'], request.vars['trace_id'], request.traceId);
    const named = pick(args['chat']);
    // Where the target came from is itself a fact, and the check depends on it:
    // a chain that names its own conversation was never aimed at the sender of
    // the event, so comparing the two would condemn every such chain the moment
    // it was queued — a policy that differed between locked and unlocked.
    const chat = named === '' ? (deps.routes.lookup(traceId)?.chatTitle ?? '') : named;
    if (chat === '' || unresolved(chat)) return undefined;

    const messageId = named === '' ? (deps.routes.lookup(traceId)?.messageId ?? '') : '';
    const capture: DeferralCapture = {
      purpose: `reply in '${chat}' to ${traceId}: ${preview(pick(args['text']))}`,
      precondition: {
        kind: FEISHU_REPLY_PREMISE,
        facts: { chat, originTraceId: traceId, originMessageId: messageId, targetFrom: named === '' ? 'origin' : 'explicit' },
      },
    };
    return capture;
  };
}

export interface ReplyPremiseDeps {
  /** Read fresh: the allowlist can change under a daemon that is still running. */
  readonly allowedChats: () => readonly string[];
  /** In-memory routing for work in flight. Empty after a restart. */
  readonly routes: ChatRouteTable;
  /** The durable answer: the conversation the origin event was recorded in. */
  readonly recordedChat: (traceId: string) => string | undefined;
  /** The conversation currently readable on screen. */
  readonly openConversation: () => Promise<OpenConversation>;
}

/** Re-check a queued reply's premise against the world as it is now. */
export function feishuReplyChecker(deps: ReplyPremiseDeps): PreconditionChecker {
  return async (facts) => {
    const chat = facts['chat'] ?? '';
    const originTraceId = facts['originTraceId'] ?? '';
    if (chat === '') return broken('the queued reply names no conversation');

    if (!deps.allowedChats().includes(chat)) {
      return broken(`'${chat}' is no longer in feishu.allowedChats, so the reply is not allowed to be sent there`);
    }

    // Only a reply that inherited its target from the event has an origin to be
    // checked against. One that named its own was never answering a sender.
    if ((facts['targetFrom'] ?? 'origin') === 'origin') {
      const origin = originConversation(deps, originTraceId);
      if (origin === undefined) {
        return broken(`the conversation event ${originTraceId} came from can no longer be identified, so the reply has no verified target`);
      }
      if (origin !== chat) {
        return broken(`event ${originTraceId} came from '${origin}', but the queued reply is addressed to '${chat}'`);
      }
    }

    return await inspectOpenChat(deps, chat, facts['originMessageId'] ?? '');
  };
}

/** The route table first — it is exact — then the trajectory, which is durable. */
function originConversation(deps: ReplyPremiseDeps, traceId: string): string | undefined {
  if (traceId === '') return undefined;
  const routed = deps.routes.lookup(traceId)?.chatTitle;
  if (routed !== undefined && routed !== '') return routed;
  const recorded = deps.recordedChat(traceId);
  return recorded === undefined || recorded === '' ? undefined : recorded;
}

async function inspectOpenChat(deps: ReplyPremiseDeps, chat: string, messageId: string): Promise<PreconditionVerdict> {
  let open: OpenConversation;
  try {
    open = await deps.openConversation();
  } catch (error) {
    return notYet(`the conversation could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (open.title !== chat) {
    const seen = open.title === '' ? 'no conversation is open' : `'${open.title}' is`;
    return notYet(`'${chat}' is not the conversation on screen (${seen}), and this daemon never switches conversations by itself`);
  }
  if (messageId !== '' && !open.messageIds.includes(messageId)) {
    return notYet(`the message being answered (${messageId}) is not visible in '${chat}' right now`);
  }
  return holds(`'${chat}' is open and still the conversation this answers`);
}

/** First non-empty value. Keeps the target resolution readable. */
function pick(...values: readonly (string | undefined)[]): string {
  return values.find((value) => value !== undefined && value.trim() !== '')?.trim() ?? '';
}

/**
 * A value that is still a template. `renderTemplate` leaves an unknown `$name`
 * as itself, so a target that reads like one was never resolved — it depends on
 * a step that has not run, and pinning it now would pin the wrong thing.
 */
function unresolved(value: string): boolean {
  return /\$\w/.test(value);
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 60 ? flat : `${flat.slice(0, 59)}…`;
}
