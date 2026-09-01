import { describe, expect, it } from 'vitest';
import { ActionError } from '../src/actions/errors.js';
import {
  SnapshotStore,
  elementKey,
  findElement,
  hasLoadingIndicator,
  subtreeElements,
  subtreeText,
  withDomClass,
  type SnapshotElement,
} from '../src/actions/snapshot.js';

const element = (over: Partial<SnapshotElement> & { index: number; depth: number; role: string }): SnapshotElement => ({
  web: false,
  handle: over.index + 100,
  ...over,
});

const tree: readonly SnapshotElement[] = [
  element({ index: 0, depth: 0, role: 'AXWindow' }),
  element({ index: 1, depth: 1, role: 'AXGroup', domClasses: ['chatWindow_chatName'] }),
  element({ index: 2, depth: 2, role: 'AXStaticText', value: 'Ada ' }),
  element({ index: 3, depth: 2, role: 'AXStaticText', value: 'Lovelace' }),
  element({ index: 4, depth: 1, role: 'AXTextArea', value: 'placeholder', domClasses: ['editor-kit-container'] }),
  element({ index: 5, depth: 2, role: 'AXStaticText', value: 'draft' }),
];

describe('reading inside a snapshot', () => {
  it('takes the text of a subtree, not of the element itself', () => {
    // The composer's own value is the placeholder; what is typed lives in its
    // text leaves. Reading the wrong one is how a draft looks like a send.
    expect(subtreeText(tree, 1)).toBe('Ada Lovelace');
    expect(subtreeText(tree, 4)).toBe('draft');
    expect(subtreeText(tree, 99)).toBe('');
  });

  it('slices a subtree while keeping absolute indices', () => {
    expect(subtreeElements(tree, 1).map((each) => each.index)).toEqual([1, 2, 3]);
    expect(subtreeElements(tree, 5).map((each) => each.index)).toEqual([5]);
    expect(subtreeElements(tree, 42)).toEqual([]);
  });

  it('finds by DOM class', () => {
    expect(findElement(tree, withDomClass('editor-kit-container'))?.index).toBe(4);
    expect(findElement(tree, withDomClass('nope'))).toBeUndefined();
  });

  it('sees a loading indicator', () => {
    expect(hasLoadingIndicator(tree)).toBe(false);
    expect(hasLoadingIndicator([...tree, element({ index: 6, depth: 1, role: 'AXProgressIndicator' })])).toBe(true);
  });

  it('identifies an element by what it is, not by where it sits', () => {
    const moved = element({ index: 9, depth: 1, role: 'AXGroup', domClasses: ['chatWindow_chatName'] });
    expect(elementKey(moved)).toBe(elementKey(tree[1] as SnapshotElement));
  });
});

describe('binding an index to the reading it came from', () => {
  it('refuses an index before anything has been read', () => {
    const store = new SnapshotStore();
    expect(() => store.resolve('app', 'app#1', 0)).toThrow(/call get_app_state/);
  });

  it('refuses an index from a reading that has been superseded', () => {
    const store = new SnapshotStore();
    const first = store.capture('app', tree, 1);
    store.capture('app', tree, 2);
    try {
      store.resolve('app', first.snapshotId, 4);
      expect.unreachable('a stale index must not resolve');
    } catch (error) {
      expect((error as ActionError).code).toBe('STALE_SNAPSHOT');
      expect((error as ActionError).message).toContain('re-read with get_app_state');
    }
  });

  it('refuses an index the reading does not contain', () => {
    const store = new SnapshotStore();
    const snapshot = store.capture('app', tree, 1);
    expect(() => store.resolve('app', snapshot.snapshotId, 400)).toThrow(/no element_index 400/);
    expect((() => {
      try {
        store.resolve('app', snapshot.snapshotId, 400);
      } catch (error) {
        return (error as ActionError).code;
      }
      return 'no error';
    })()).toBe('UNKNOWN_ELEMENT');
  });

  it('resolves an index from the current reading', () => {
    const store = new SnapshotStore();
    const snapshot = store.capture('app', tree, 1);
    expect(store.resolve('app', snapshot.snapshotId, 4).handle).toBe(104);
    expect(store.current('app')?.snapshotId).toBe(snapshot.snapshotId);
  });

  it('gives each reading of each app its own id', () => {
    const store = new SnapshotStore();
    expect(store.capture('a', tree, 1).snapshotId).toBe('a#1');
    expect(store.capture('a', tree, 2).snapshotId).toBe('a#2');
    expect(store.capture('b', tree, 3).snapshotId).toBe('b#1');
  });

  it('forgets a reading on request, so the next index must be fresh', () => {
    const store = new SnapshotStore();
    const snapshot = store.capture('app', tree, 1);
    store.invalidate('app');
    expect(store.current('app')).toBeUndefined();
    expect(() => store.resolve('app', snapshot.snapshotId, 0)).toThrow(ActionError);
  });
});
