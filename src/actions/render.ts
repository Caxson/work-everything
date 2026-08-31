/**
 * Turning a reading into the text a model reads.
 *
 * One line per element, prefixed with the index that addresses it. Nesting is
 * deliberately not drawn: the lines are already in document order, depth is
 * available programmatically to anything that needs it, and forty spaces of
 * indentation per line on a tree that is routinely forty levels deep is a
 * token bill with no reader.
 */
import type { SnapshotElement } from './snapshot.js';

/** Long attribute values are cut here; the bridge already caps at 200. */
export const MAX_FIELD_CHARS = 160;

function field(label: string, value: string | undefined): string {
  if (value === undefined || value === '') return '';
  const clipped = value.length <= MAX_FIELD_CHARS ? value : `${value.slice(0, MAX_FIELD_CHARS)}…`;
  return ` ${label}='${clipped.replace(/\n/g, '\\n')}'`;
}

/** One element, without its index — the part a diff compares. */
export function describeElement(element: SnapshotElement): string {
  const classes = element.domClasses ?? [];
  return [
    element.role,
    element.subrole === undefined ? '' : ` sub=${element.subrole}`,
    field('title', element.title),
    field('val', element.value),
    field('desc', element.description),
    element.domId === undefined || element.domId === '' ? '' : ` #${element.domId}`,
    classes.length === 0 ? '' : ` .${classes.join('.')}`,
  ].join('');
}

/** One element, addressable. */
export function renderElement(element: SnapshotElement): string {
  return `${element.index}: ${describeElement(element)}`;
}

export function renderSnapshot(elements: readonly SnapshotElement[]): string {
  return elements.map(renderElement).join('\n');
}
