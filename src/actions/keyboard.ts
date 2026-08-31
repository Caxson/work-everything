/**
 * The only route that actually writes into web content.
 *
 * Measured, not assumed (`docs/TODO.md`, "Writing into a composer"): against
 * a `contenteditable`, `AXValue`, `AXFocused`, `AXSelectedTextRange`,
 * `AXSelectedText`, `AXPress` and `AXConfirm` all return success and not one
 * of them produces a `beforeinput` or an `input`. The text reads back
 * correctly and the page never knew — so a controlled editor's own state
 * never updated and the message that looks typed was never typed. What works
 * is press to focus, then send keys to the process.
 *
 * That is a bridge primitive, not something this side can synthesize, so the
 * route is an interface with two implementations: the real one, and one that
 * says clearly that it is missing. There is deliberately no third that falls
 * back to `setValue`; a fallback that reports success and sends nothing is
 * worse than an error, because nobody goes looking for it.
 */
import { ActionError, toActionError } from './errors.js';

export interface FocusAndTypeRequest {
  readonly pid: number;
  /** The element to focus. The helper focuses by node, so this is required —
   *  a caller that means "wherever focus is" resolves that node first. */
  readonly nodeId: number;
  readonly text: string;
}

export interface KeyboardRoute {
  /**
   * Focus the element and deliver the text as key events to the process.
   *
   * The contract the bridge owns: focus is verified before a single key is
   * posted, and unverified focus is an error rather than a typed character.
   * Typing into a Chromium window that is not focused turns every character
   * into a global shortcut — the spike closed Feishu by typing a `w`.
   */
  focusAndType(request: FocusAndTypeRequest): Promise<void>;
}

/** What the bridge client must provide for the real route. */
export interface FocusAndTypeTransport {
  focusAndType(request: FocusAndTypeRequest): Promise<{ readonly focused?: unknown } | undefined>;
}

const MISSING =
  'the we-ax bridge does not provide focusAndType, and there is no other verified way to write into web content: ' +
  'AX setValue/AXPress/AXConfirm all report success and produce no input event. Nothing was typed.';

export function bridgeKeyboardRoute(transport: FocusAndTypeTransport): KeyboardRoute {
  return {
    focusAndType: async (request) => {
      let result: { readonly focused?: unknown } | undefined;
      try {
        result = await transport.focusAndType(request);
      } catch (error) {
        throw translate(error);
      }
      // The helper raises when focus does not land, so reaching here is
      // normally enough. An explicit denial is still refused rather than read
      // as a success: the cost of being wrong here is keystrokes loose in
      // somebody's window.
      if (result?.focused === false) {
        throw new ActionError('FOCUS_FAILED', sentence('the bridge could not put focus on the target element, so no keys were sent', CLICK_SIDE_EFFECT(undefined)));
      }
    },
  };
}

/** The route when the bridge has not shipped it. Every call is a clear error. */
export function unavailableKeyboardRoute(reason: string = MISSING): KeyboardRoute {
  return {
    focusAndType: () => Promise.reject(new ActionError('HYBRID_ROUTE_UNAVAILABLE', reason)),
  };
}

/**
 * A bridge that does not know the op answers `BAD_REQUEST`. That is not a
 * driver fault to be retried, it is the route being absent — and it must read
 * that way in the log, or the next person debugs the wrong thing.
 */
function translate(error: unknown): ActionError {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === 'BAD_REQUEST') return new ActionError('HYBRID_ROUTE_UNAVAILABLE', MISSING);
  const action = toActionError(error, 'focusAndType');
  if (action.code !== 'FOCUS_FAILED') return action;
  return new ActionError('FOCUS_FAILED', sentence(action.message, CLICK_SIDE_EFFECT(action.details)), action.details);
}

/**
 * What a failed focus already did.
 *
 * The bridge reports `keysSent: 0`, which is true and is read too generously:
 * the `auto` strategy order is press, then the focused attribute, then a real
 * mouse click, so a failure means the click has already been posted at the
 * element's centre. In a chat window that click can land on a message, a link
 * or a button. Saying only "no keys were sent" invites both a retry loop and
 * the belief that nothing happened, and neither is true.
 */
const CLICK_SIDE_EFFECT = (details: unknown): string => {
  const attempted = readAttempted(details);
  if (attempted !== undefined && !attempted.includes('click')) return '';
  return (
    'That is not a clean no-op, though: establishing focus already posted a real mouse click at the element centre, ' +
    'which in a chat window can land on whatever is there. Not retried — repeating it clicks again.'
  );
};

/** Joins two sentences without doubling or omitting the punctuation between. */
function sentence(head: string, tail: string): string {
  if (tail === '') return head;
  const trimmed = head.trimEnd();
  return `${trimmed}${/[.!?]$/.test(trimmed) ? '' : '.'} ${tail}`;
}

function readAttempted(details: unknown): readonly string[] | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  const attempted = (details as { attempted?: unknown }).attempted;
  if (!Array.isArray(attempted)) return undefined;
  return attempted.filter((entry): entry is string => typeof entry === 'string');
}
