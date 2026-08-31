/**
 * The difference between two readings.
 *
 * This is the single biggest lever on how much a long task costs: a Feishu
 * tree is thousands of elements, almost all of which are the same as they
 * were a second ago. Codex makes the diff the *default* answer of
 * `get_app_state` and full text the opt-in (`disableDiff`), and that is
 * copied here.
 *
 * Elements are matched by identity, not by position. Matching by position
 * would report every element below an insertion as changed, which is exactly
 * the case where a diff is most needed and would be most wrong.
 */
import type { SnapshotElement } from './snapshot.js';
import { elementKey } from './snapshot.js';
import { describeElement, renderElement } from './render.js';

export const NO_CHANGE = '(no change since the previous reading)';

/**
 * Keys are not unique on their own — a list of twenty identical rows shares
 * one — so each repeat gets its occurrence number appended. Two readings of
 * the same list then line up row for row.
 */
function keyed(elements: readonly SnapshotElement[]): ReadonlyMap<string, SnapshotElement> {
  const seen = new Map<string, number>();
  const out = new Map<string, SnapshotElement>();
  for (const element of elements) {
    const base = elementKey(element);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    out.set(`${base}#${occurrence}`, element);
  }
  return out;
}

/**
 * Removed, added and changed elements, in that reading order. An element
 * whose identity survived but whose rendered description differs is one
 * `~` line, not a remove and an add. Identity includes the title, because
 * that is what lines two readings of a native app up when there is no DOM id
 * to match on; the cost is that a renamed control reads as one gone and one
 * arrived, which is also a fair description of what happened.
 */
export function diffElements(before: readonly SnapshotElement[], after: readonly SnapshotElement[]): string {
  const oldByKey = keyed(before);
  const newByKey = keyed(after);
  const lines: string[] = [];

  for (const [key, element] of oldByKey) {
    if (!newByKey.has(key)) lines.push(`- ${renderElement(element)}`);
  }
  for (const [key, element] of newByKey) {
    const previous = oldByKey.get(key);
    if (previous === undefined) {
      lines.push(`+ ${renderElement(element)}`);
      continue;
    }
    if (describeElement(previous) !== describeElement(element)) lines.push(`~ ${renderElement(element)}`);
  }

  return lines.length === 0 ? NO_CHANGE : lines.join('\n');
}
