import { describe, expect, it } from 'vitest';
import { NO_CHANGE, diffElements } from '../src/actions/diff.js';
import { MAX_FIELD_CHARS, describeElement, renderElement, renderSnapshot } from '../src/actions/render.js';
import type { SnapshotElement } from '../src/actions/snapshot.js';

const element = (over: Partial<SnapshotElement> & { index: number; role: string }): SnapshotElement => ({
  depth: 1,
  web: false,
  handle: over.index,
  ...over,
});

describe('rendering a reading', () => {
  it('leads with the index, because that is what an action is given', () => {
    const line = renderElement(element({ index: 7, role: 'AXButton', title: 'Send', domId: 'send', domClasses: ['a', 'b'] }));
    expect(line).toBe("7: AXButton title='Send' #send .a.b");
  });

  it('leaves out what an element does not expose', () => {
    expect(renderElement(element({ index: 0, role: 'AXGroup' }))).toBe('0: AXGroup');
  });

  it('clips a long value and flattens its newlines, so one element is one line', () => {
    const line = renderElement(element({ index: 0, role: 'AXStaticText', value: `${'x'.repeat(400)}\nmore` }));
    expect(line.includes('\n')).toBe(false);
    expect(line).toContain('…');
    expect(line.length).toBeLessThan(MAX_FIELD_CHARS + 40);
  });

  it('renders a whole reading, one line per element', () => {
    const rendered = renderSnapshot([element({ index: 0, role: 'AXWindow' }), element({ index: 1, role: 'AXButton', title: 'OK' })]);
    expect(rendered.split('\n')).toHaveLength(2);
  });
});

describe('the diff between two readings', () => {
  const before: readonly SnapshotElement[] = [
    element({ index: 0, role: 'AXWindow', title: 'app' }),
    element({ index: 1, role: 'AXGroup', domId: 'm1', value: 'hello' }),
    element({ index: 2, role: 'AXGroup', domId: 'm2', value: 'bye' }),
  ];

  it('says nothing when nothing changed', () => {
    expect(diffElements(before, before)).toBe(NO_CHANGE);
  });

  it('reports an added element with the index it now has', () => {
    const after = [...before, element({ index: 3, role: 'AXGroup', domId: 'm3', value: 'new' })];
    expect(diffElements(before, after)).toBe("+ 3: AXGroup val='new' #m3");
  });

  it('reports a removed element', () => {
    expect(diffElements(before, before.slice(0, 2))).toBe("- 2: AXGroup val='bye' #m2");
  });

  it('reports a changed value as one line, not as a removal and an addition', () => {
    const after = [before[0] as SnapshotElement, element({ index: 1, role: 'AXGroup', domId: 'm1', value: 'edited' }), before[2] as SnapshotElement];
    expect(diffElements(before, after)).toBe("~ 1: AXGroup val='edited' #m1");
  });

  it('does not call everything below an insertion changed', () => {
    // The whole point of matching on identity: one row inserted at the top
    // must not report every row under it as different.
    const after = [
      before[0] as SnapshotElement,
      element({ index: 1, role: 'AXGroup', domId: 'm0', value: 'first' }),
      element({ index: 2, role: 'AXGroup', domId: 'm1', value: 'hello' }),
      element({ index: 3, role: 'AXGroup', domId: 'm2', value: 'bye' }),
    ];
    expect(diffElements(before, after)).toBe("+ 1: AXGroup val='first' #m0");
  });

  it('lines identical siblings up by position among themselves', () => {
    const rows = (count: number): readonly SnapshotElement[] =>
      Array.from({ length: count }, (_, index) => element({ index, role: 'AXRow', title: 'item' }));
    expect(diffElements(rows(3), rows(3))).toBe(NO_CHANGE);
    expect(diffElements(rows(3), rows(4))).toBe("+ 3: AXRow title='item'");
  });

  it('describes an element without its index, which is what identity compares', () => {
    const one = element({ index: 1, role: 'AXButton', title: 'Send' });
    const moved = element({ index: 9, role: 'AXButton', title: 'Send' });
    expect(describeElement(one)).toBe(describeElement(moved));
  });
});
