import { describe, expect, it, vi } from 'vitest';
import { mergeEvents } from '../src/perception/base.js';
import type { Perceiver } from '../src/perception/base.js';
import { parseEvent } from '../src/core/events.js';
import type { Event } from '../src/core/events.js';

const event = (id: string): Event => parseEvent({ traceId: id, source: 'manual', kind: 'k', ts: 1, payload: { text: id } });

const fixture = (name: string, ids: readonly string[], delayMs = 0): Perceiver => ({
  name,
  events: async function* () {
    for (const id of ids) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      yield event(id);
    }
  },
  close: async () => undefined,
});

const collect = async (iterable: AsyncIterable<Event>): Promise<string[]> => {
  const out: string[] = [];
  for await (const item of iterable) out.push(item.traceId);
  return out;
};

describe('mergeEvents', () => {
  it('yields nothing when there are no perceivers', async () => {
    expect(await collect(mergeEvents([]))).toEqual([]);
  });

  it('drains a single perceiver in order', async () => {
    expect(await collect(mergeEvents([fixture('a', ['1', '2', '3'])]))).toEqual(['1', '2', '3']);
  });

  it('interleaves perceivers by arrival, not by registration', async () => {
    const ids = await collect(mergeEvents([fixture('slow', ['s1'], 30), fixture('fast', ['f1', 'f2'], 1)]));
    expect(ids).toHaveLength(3);
    expect(ids.indexOf('s1')).toBe(2);
  });

  it('drops a failing perceiver without taking the others down', async () => {
    const broken: Perceiver = {
      name: 'broken',
      events: async function* () {
        yield event('b1');
        throw new Error('transport died');
      },
      close: async () => undefined,
    };
    const onError = vi.fn();
    const ids = await collect(mergeEvents([broken, fixture('ok', ['o1'])], undefined, onError));
    expect(ids.sort()).toEqual(['b1', 'o1']);
    expect(onError).toHaveBeenCalledWith('broken', expect.any(Error));
  });

  it('passes the abort signal through to each perceiver', async () => {
    const controller = new AbortController();
    let sawSignal = false;
    const watcher: Perceiver = {
      name: 'watcher',
      events: async function* (signal) {
        sawSignal = signal?.aborted === false;
        yield event('w1');
      },
      close: async () => undefined,
    };
    await collect(mergeEvents([watcher], controller.signal));
    expect(sawSignal).toBe(true);
  });
});
