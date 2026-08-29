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
  'tree',
  'find',
  'attr',
  'setValue',
  'press',
  'focus',
  'keystroke',
  'observe',
  'unobserve',
] as const;
export type AxOp = (typeof AX_OPS)[number];

export const AxFrameSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).readonly();
export type AxFrame = z.infer<typeof AxFrameSchema>;

export interface AxNode {
  readonly nodeId: number;
  readonly role: string;
  readonly subrole?: string | undefined;
  readonly title?: string | undefined;
  readonly value?: string | undefined;
  readonly description?: string | undefined;
  readonly identifier?: string | undefined;
  readonly frame?: AxFrame | undefined;
  readonly children?: readonly AxNode[] | undefined;
}

export const AxNodeSchema: z.ZodType<AxNode> = z.lazy(() =>
  z.object({
    nodeId: z.number().int(),
    role: z.string(),
    subrole: z.string().optional(),
    title: z.string().optional(),
    value: z.string().optional(),
    description: z.string().optional(),
    identifier: z.string().optional(),
    frame: AxFrameSchema.optional(),
    children: z.array(AxNodeSchema).optional(),
  }),
);

export const AxAppSchema = z.object({ pid: z.number().int(), name: z.string(), bundleId: z.string() }).readonly();
export type AxApp = z.infer<typeof AxAppSchema>;

export const AxSelectorSchema = z
  .object({
    role: z.string().optional(),
    title: z.string().optional(),
    identifier: z.string().optional(),
    valueContains: z.string().optional(),
    maxResults: z.number().int().positive().optional(),
  })
  .readonly();
export type AxSelector = z.infer<typeof AxSelectorSchema>;

export const AxErrorSchema = z.object({ code: z.string(), message: z.string() }).readonly();
export type AxError = z.infer<typeof AxErrorSchema>;

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
