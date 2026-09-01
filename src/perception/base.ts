/**
 * Perceivers — where events come from.
 *
 * A perceiver is an async iterable of events and nothing else. It owns its
 * transport (a socket, a hook, a subprocess) and it owns turning that
 * transport's shape into an `Event`; the daemon owns everything after that.
 * Iteration ends when the source ends or the daemon stops asking.
 */
import type { Event } from '../core/events.js';

export interface Perceiver {
  readonly name: string;
  /** Yields events until the source closes or `signal` aborts. */
  events(signal?: AbortSignal): AsyncIterable<Event>;
  /** Release the transport. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * Merge perceivers into one stream, preserving arrival order. A perceiver
 * that throws is dropped with a recorded reason rather than taking the others
 * down with it.
 */
export async function* mergeEvents(
  perceivers: readonly Perceiver[],
  signal?: AbortSignal,
  onError?: (perceiver: string, error: unknown) => void,
): AsyncIterable<Event> {
  const iterators = perceivers.map((perceiver) => ({
    name: perceiver.name,
    iterator: perceiver.events(signal)[Symbol.asyncIterator](),
  }));

  const pending = new Map<string, Promise<{ name: string; result: IteratorResult<Event>; error?: unknown }>>();
  const pump = (entry: (typeof iterators)[number]): void => {
    pending.set(
      entry.name,
      entry.iterator
        .next()
        .then((result) => ({ name: entry.name, result }))
        .catch((error: unknown) => ({ name: entry.name, result: { done: true, value: undefined } as IteratorResult<Event>, error })),
    );
  };
  for (const entry of iterators) pump(entry);

  while (pending.size > 0) {
    const settled = await Promise.race(pending.values());
    pending.delete(settled.name);
    if (settled.error !== undefined) {
      onError?.(settled.name, settled.error);
      continue;
    }
    if (settled.result.done === true) continue;
    yield settled.result.value;
    const entry = iterators.find((candidate) => candidate.name === settled.name);
    if (entry !== undefined) pump(entry);
  }
}
