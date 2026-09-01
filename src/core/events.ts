/**
 * Observed events — the only thing that enters the system.
 *
 * A perceiver turns whatever a source natively emits (a Feishu message, a
 * Claude Code hook payload, an accessibility notification) into this one
 * shape, so routing never has to know where an event came from.
 */
import { z } from 'zod';

/** Where an event was observed. Open-ended: perceivers may add sources. */
export const EventSourceSchema = z.enum(['feishu', 'claude_code', 'macos_ax', 'shell', 'manual']);
export type EventSource = z.infer<typeof EventSourceSchema>;

/** JSON-ish payload values. Perceivers must not put class instances here. */
export type PayloadValue = string | number | boolean | null | readonly PayloadValue[] | { readonly [k: string]: PayloadValue };

const PayloadValueSchema: z.ZodType<PayloadValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(PayloadValueSchema),
    z.record(PayloadValueSchema),
  ]),
);

export const EventSchema = z
  .object({
    /** Stable id for this observation; also the trajectory primary key. */
    traceId: z.string().min(1),
    source: EventSourceSchema,
    /** Source-specific event name, e.g. 'message.received', 'tool.post_use'. */
    kind: z.string().min(1),
    /** Epoch milliseconds, when the event was observed. */
    ts: z.number().int().nonnegative(),
    payload: z.record(PayloadValueSchema).default({}),
  })
  .strict()
  .readonly();

export type Event = z.infer<typeof EventSchema>;

/** Payload keys scanned, in order, for the human-readable text of an event. */
export const TEXT_PAYLOAD_KEYS = ['text', 'message', 'content', 'prompt', 'title', 'command'] as const;

/**
 * The natural-language surface of an event: what a human would say the
 * event *is*. Routing, retrieval and planning all key off this string, so
 * it is derived in exactly one place.
 */
export function eventText(event: Event): string {
  const parts: string[] = [];
  for (const key of TEXT_PAYLOAD_KEYS) {
    const value = event.payload[key];
    if (typeof value === 'string' && value.trim() !== '') parts.push(value.trim());
  }
  return parts.join(' ');
}

/** Parse an untrusted object into an Event, throwing a readable ZodError. */
export function parseEvent(raw: unknown): Event {
  return EventSchema.parse(raw);
}

/** Non-throwing variant for perceivers reading from a lossy transport. */
export function safeParseEvent(raw: unknown): { readonly ok: true; readonly event: Event } | { readonly ok: false; readonly error: string } {
  const result = EventSchema.safeParse(raw);
  return result.success
    ? { ok: true, event: result.data }
    : { ok: false, error: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
}
