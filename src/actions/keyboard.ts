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
        throw new ActionError('FOCUS_FAILED', 'the bridge could not put focus on the target element; sent no keystrokes');
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
  return toActionError(error, 'focusAndType');
}
