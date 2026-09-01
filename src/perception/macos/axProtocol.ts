/**
 * The wire format spoken with the `we-ax` helper (see
 * `docs/ax-bridge-protocol.md`, which both sides implement against).
 *
 * One JSON object per line in each direction. Requests carry a numeric `id`;
 * every reply carries the same `id` back. Anything with an `event` field is
 * unsolicited and belongs to a subscription, not to a request.
 *
 * Everything read off the pipe is validated before it is used. The helper is
 * a separate process written in another language: treating its output as
 * trusted is how a crash there becomes a crash here.
 */
import { z } from 'zod';

export const AX_OPS = [
  'trusted',
  'apps',
  'enableAX',
  'windows',
  'tree',
  'find',
  'attr',
  'setValue',
  'press',
  'focus',
  'click',
  'scroll',
  'keystroke',
  /**
   * Focus an element and deliver text to the process as key events. The only
   * path that reaches a `contenteditable`: see `src/actions/keyboard.ts`.
   */
  'focusAndType',
  /** Poll until an app's tree is worth reading. See `axAwait.ts`. */
  'awaitTree',
  'windowInfo',
  /** Machine-wide diagnostics, including the screen lock. Needs no pid. */
  'env',
  'observe',
  'unobserve',
] as const;
export type AxOp = (typeof AX_OPS)[number];

/**
 * A rectangle, normalized. The helper emits CoreGraphics' `w`/`h` spelling while
 * this document has always said `width`/`height`; accepting both and settling on
 * one keeps a rename on either side from silently dropping every frame.
 */
export const AxFrameSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().optional(),
    height: z.number().optional(),
    w: z.number().optional(),
    h: z.number().optional(),
  })
  .transform((raw) => ({ x: raw.x, y: raw.y, width: raw.width ?? raw.w ?? 0, height: raw.height ?? raw.h ?? 0 }));
export type AxFrame = z.infer<typeof AxFrameSchema>;

export interface AxNode {
  readonly nodeId: number;
  readonly role: string;
  readonly subrole?: string | undefined;
  readonly title?: string | undefined;
  readonly value?: string | undefined;
  readonly description?: string | undefined;
  readonly identifier?: string | undefined;
  /** Chromium/WebKit only: the element's DOM id. */
  readonly domId?: string | undefined;
  /** Chromium/WebKit only: the element's CSS class list. */
  readonly domClasses?: readonly string[] | undefined;
  /** Present on `find` results, which are flat, in place of `children`. */
  readonly depth?: number | undefined;
  /** Window results only: the window server's number for this window. */
  readonly windowNumber?: number | undefined;
  /** Window results only: which mechanism found it. */
  readonly resolvedBy?: string | undefined;
  /** Window results only: whether it can actually be addressed right now. */
  readonly addressable?: boolean | undefined;
  readonly frame?: AxFrame | undefined;
  readonly children?: readonly AxNode[] | undefined;
}

/**
 * An AX attribute the bridge coerces from a live `CFTypeRef`: usually a string,
 * but a checkbox's value is a boolean, a slider's a number, and so on. The node
 * parse used to reject the moment any such attribute came back non-string, which
 * sank the entire snapshot over one toggle deep in the tree. Accept every scalar
 * and render it as text.
 */
const AxText = z
  .union([z.string(), z.boolean(), z.number()])
  .transform((raw) => (typeof raw === 'string' ? raw : String(raw)));

export const AxNodeSchema: z.ZodType<AxNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    nodeId: z.number().int(),
    role: z.string(),
    subrole: AxText.optional(),
    title: AxText.optional(),
    value: AxText.optional(),
    description: AxText.optional(),
    identifier: AxText.optional(),
    domId: z.string().optional(),
    domClasses: z.array(z.string()).optional(),
    depth: z.number().int().optional(),
    windowNumber: z.number().int().optional(),
    resolvedBy: z.string().optional(),
    addressable: z.boolean().optional(),
    frame: AxFrameSchema.optional(),
    children: z.array(AxNodeSchema).optional(),
  }),
);

export const AxAppSchema = z
  .object({ pid: z.number().int(), name: z.string(), bundleId: z.string(), activationPolicy: z.string().optional() })
  .readonly();
export type AxApp = z.infer<typeof AxAppSchema>;

export const AxSelectorSchema = z
  .object({
    role: z.string().optional(),
    subrole: z.string().optional(),
    title: z.string().optional(),
    titleContains: z.string().optional(),
    identifier: z.string().optional(),
    valueContains: z.string().optional(),
    descriptionContains: z.string().optional(),
    /** Web content only, and by far the most stable hook Feishu offers. */
    domId: z.string().optional(),
    domClass: z.string().optional(),
    maxResults: z.number().int().positive().optional(),
  })
  .readonly();
export type AxSelector = z.infer<typeof AxSelectorSchema>;

/**
 * `details` is additive structured diagnostics the helper attaches to some
 * failures — window censuses, mostly. A client that reads only `code` and
 * `message` is unaffected; one that wants counts does not have to parse prose.
 */
export const AxErrorSchema = z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }).readonly();
export type AxError = z.infer<typeof AxErrorSchema>;

/**
 * Why an application exposes no window.
 *
 * The helper classifies this rather than answering with an empty array,
 * because the four causes look identical from a count and call for four
 * different responses — see `windows` in `docs/ax-bridge-protocol.md`. An
 * unrecognised code is accepted rather than rejected: a new cause the helper
 * learns to tell apart must not stop this side parsing the answer.
 */
export const WINDOW_DIAGNOSIS_CODES = ['OK', 'SCREEN_LOCKED', 'AX_SEES_NO_WINDOWS_BUT_CG_DOES', 'NO_WINDOW'] as const;
export type WindowDiagnosisCode = (typeof WINDOW_DIAGNOSIS_CODES)[number];

export const WindowDiagnosisDetailsSchema = z
  .object({
    /** Windows the window server has for this process, drawn or not. */
    cgWindows: z.number().int().optional(),
    /** How many of them are on screen. */
    onScreen: z.number().int().optional(),
    /** Ordinary windows on screen across the whole machine. */
    desktopOnScreen: z.number().int().optional(),
    /** How many processes own them. One means the desktop is not compositing. */
    desktopOwnersOnScreen: z.number().int().optional(),
    /** `desktop` when nothing anywhere is being drawn; `application` when it is just this one. */
    scope: z.string().optional(),
    /**
     * Whether a screen saver is **displaying** — a window of its own, on
     * screen, covering the display. Present on every diagnosis the helper
     * builds a census for, so `false` is a real negative and only an absent
     * key means "this helper does not report it".
     */
    screenSaverOnScreen: z.boolean().optional(),
  })
  .passthrough();
export type WindowDiagnosisDetails = z.infer<typeof WindowDiagnosisDetailsSchema>;

export const WindowDiagnosisSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  details: WindowDiagnosisDetailsSchema.optional(),
  /** Present on `OK`: how many of the windows can actually be addressed. */
  addressable: z.number().int().optional(),
});
export type WindowDiagnosis = z.infer<typeof WindowDiagnosisSchema>;

/**
 * The helper's answer about the login session's lock state.
 *
 * `locked` comes from `CGSSessionScreenIsLocked`, which only the helper can
 * read. It arrives on `windowInfo` — the diagnostic op, and the one op that
 * keeps answering while the screen is locked, because withholding the
 * diagnosis at the moment somebody needs it would be the wrong trade.
 */
export const AxScreenStateSchema = z.object({ locked: z.boolean(), lockedSince: z.string().optional() }).passthrough();
export type AxScreenState = z.infer<typeof AxScreenStateSchema>;

/**
 * `windowInfo`'s reply. Only `screen` is modelled: the rest is a census this
 * side has no use for, and `passthrough` keeps a helper that adds fields from
 * breaking a client that does not read them.
 */
export const WindowInfoSchema = z.object({ screen: AxScreenStateSchema }).passthrough();
export type WindowInfo = z.infer<typeof WindowInfoSchema>;

/**
 * `env`'s reply. The same `screen` object, from an op that takes no pid and is
 * not gated on accessibility permission — which is what makes it the right
 * place to ask whether the Mac is locked. `windowInfo` answers the same
 * question but only about a *running application*, so a probe built on it stops
 * working the moment that application quits, and a screen that unlocked while
 * it was gone would never be noticed.
 */
export const AxEnvSchema = z.object({ screen: AxScreenStateSchema }).passthrough();
export type AxEnv = z.infer<typeof AxEnvSchema>;

/** What `windows {meta: true}` answers: the windows, and why there are none. */
export const WindowReadingSchema = z.object({ windows: z.array(AxNodeSchema), diagnosis: WindowDiagnosisSchema });
export type WindowReading = z.infer<typeof WindowReadingSchema>;

export const AxResponseSchema = z.union([
  z.object({ id: z.number().int(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.number().int(), ok: z.literal(false), error: AxErrorSchema }),
]);
export type AxResponse = z.infer<typeof AxResponseSchema>;

export const AxNotificationSchema = z
  .object({
    event: z.literal('ax'),
    subscription: z.number().int(),
    notification: z.string(),
    nodeId: z.number().int(),
    pid: z.number().int(),
  })
  .readonly();
export type AxNotification = z.infer<typeof AxNotificationSchema>;

export type AxMessage = { readonly type: 'response'; readonly response: AxResponse } | { readonly type: 'notification'; readonly notification: AxNotification };

/** Serialize one request. The trailing newline is the frame delimiter. */
export function encodeRequest(id: number, op: AxOp, params: Readonly<Record<string, unknown>> = {}): string {
  return `${JSON.stringify({ id, op, ...params })}\n`;
}

export type DecodeResult = { readonly ok: true; readonly message: AxMessage } | { readonly ok: false; readonly error: string };

/** Classify and validate one line from the helper. */
export function decodeMessage(line: string): DecodeResult {
  const trimmed = line.trim();
  if (trimmed === '') return { ok: false, error: 'empty line' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: `line is not JSON: ${trimmed.slice(0, 120)}` };
  }

  if (typeof parsed === 'object' && parsed !== null && 'event' in parsed) {
    const notification = AxNotificationSchema.safeParse(parsed);
    return notification.success
      ? { ok: true, message: { type: 'notification', notification: notification.data } }
      : { ok: false, error: `malformed event: ${issue(notification.error)}` };
  }

  const response = AxResponseSchema.safeParse(parsed);
  return response.success
    ? { ok: true, message: { type: 'response', response: response.data } }
    : { ok: false, error: `malformed response: ${issue(response.error)}` };
}

function issue(error: z.ZodError): string {
  const first = error.issues[0];
  return first === undefined ? 'invalid' : `${first.path.join('.') || '(root)'}: ${first.message}`;
}

/**
 * Reassemble newline-delimited messages from arbitrary chunk boundaries. A
 * pipe splits wherever it likes; a half-received JSON object must not be
 * parsed as a malformed one.
 */
export function createLineDecoder(): (chunk: string) => readonly string[] {
  let buffer = '';
  return (chunk: string): readonly string[] => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    return parts.filter((line) => line.trim() !== '');
  };
}
