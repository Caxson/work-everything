/**
 * A reading of an app's UI, and the binding that keeps indices honest.
 *
 * An `element_index` only means anything relative to the reading it came
 * from: one insertion above it and index 42 is a different button. Codex
 * handles this by telling the model to re-read state after every action,
 * which is advice. Here the reading is given an id, an action carrying an
 * index must carry that id too, and a mismatch is refused. A wrong click is
 * always worse than a rejected call, because a rejected call says so.
 *
 * The store keeps exactly one live reading per app. Taking a new one retires
 * the old id, which is what makes "act on what you just read" enforceable
 * rather than hoped for.
 */
import { ActionError } from './errors.js';

export interface SnapshotElement {
  /** Position in document order. This is what `element_index` addresses. */
  readonly index: number;
  /** Depth in the source tree. Kept for subtree reads, not rendered. */
  readonly depth: number;
  readonly role: string;
  readonly subrole?: string | undefined;
  readonly title?: string | undefined;
  readonly value?: string | undefined;
  readonly description?: string | undefined;
  readonly identifier?: string | undefined;
  readonly domId?: string | undefined;
  readonly domClasses?: readonly string[] | undefined;
  /**
   * Inside web content (Chromium/WebKit). Load-bearing: accessibility writes
   * to a `contenteditable` report success and change nothing, so a driver
   * must take a different path for these — see `drivers/macAx.ts`.
   */
  readonly web: boolean;
  /** The driver's own handle for this element: an AX node id, a CDP node id. */
  readonly handle: number;
}

export interface Snapshot {
  readonly snapshotId: string;
  /** Canonical app key — the bundle identifier, never the display name. */
  readonly app: string;
  readonly capturedAt: number;
  readonly elements: readonly SnapshotElement[];
}

/** Roles whose `value` is the text a human reads. */
const TEXT_ROLES: ReadonlySet<string> = new Set(['AXStaticText', 'StaticText', 'text']);

/** Roles an app shows while it is still working. */
const BUSY_ROLES: ReadonlySet<string> = new Set(['AXProgressIndicator', 'AXBusyIndicator', 'progressbar', 'ProgressIndicator']);

/**
 * Every text value under `index`, joined. Computed on demand rather than
 * stored per element: a Feishu tree is twelve thousand nodes deep in the
 * forties, and materialising a subtree string for each one costs more than
 * every read that will ever ask for one.
 */
export function subtreeText(elements: readonly SnapshotElement[], index: number): string {
  const out: string[] = [];
  for (const element of subtreeElements(elements, index)) {
    if (!TEXT_ROLES.has(element.role)) continue;
    const value = element.value ?? '';
    if (value !== '') out.push(value);
  }
  return out.join('').trim();
}

/**
 * The element at `index` and everything under it, in document order. The
 * entries keep their absolute `index`, because that is what an action has to
 * be given — a position within a slice would address the wrong thing.
 */
export function subtreeElements(elements: readonly SnapshotElement[], index: number): readonly SnapshotElement[] {
  const root = elements[index];
  if (root === undefined) return [];
  let end = index + 1;
  while (end < elements.length && (elements[end]?.depth ?? 0) > root.depth) end += 1;
  return elements.slice(index, end);
}

/** Whether anything in the reading says the app is still settling. */
export function hasLoadingIndicator(elements: readonly SnapshotElement[]): boolean {
  return elements.some((element) => BUSY_ROLES.has(element.role));
}

/** The first element matching a predicate, in document order. */
export function findElement(
  elements: readonly SnapshotElement[],
  predicate: (element: SnapshotElement) => boolean,
): SnapshotElement | undefined {
  return elements.find(predicate);
}

/** Predicate: the element carries this DOM class. */
export function withDomClass(name: string): (element: SnapshotElement) => boolean {
  return (element) => (element.domClasses ?? []).includes(name);
}

/**
 * Identity used to line two readings up against each other. Deliberately not
 * the index: an element that moved has not changed, and reporting it as a
 * change would make every diff useless the first time anything is inserted.
 */
export function elementKey(element: SnapshotElement): string {
  const parts = [element.role, element.domId ?? '', element.identifier ?? '', element.title ?? '', (element.domClasses ?? []).join('.')];
  return parts.join('|');
}

export class SnapshotStore {
  private snapshots: ReadonlyMap<string, Snapshot> = new Map();
  private sequence: ReadonlyMap<string, number> = new Map();

  /** Record a new reading, retiring the app's previous id. */
  capture(app: string, elements: readonly SnapshotElement[], capturedAt: number): Snapshot {
    const next = (this.sequence.get(app) ?? 0) + 1;
    this.sequence = new Map(this.sequence).set(app, next);
    const snapshot: Snapshot = { snapshotId: `${app}#${next}`, app, capturedAt, elements };
    this.snapshots = new Map(this.snapshots).set(app, snapshot);
    return snapshot;
  }

  current(app: string): Snapshot | undefined {
    return this.snapshots.get(app);
  }

  /**
   * The element an action is addressing, or an error explaining which of the
   * two things went wrong: the reading is out of date, or the index is not in
   * it. Both are fixed by taking a fresh `get_app_state`, and the message
   * says so.
   */
  resolve(app: string, snapshotId: string, index: number): SnapshotElement {
    const current = this.snapshots.get(app);
    if (current === undefined) {
      throw new ActionError('STALE_SNAPSHOT', `no reading of '${app}' has been taken yet; call get_app_state before addressing an element_index`);
    }
    if (current.snapshotId !== snapshotId) {
      throw new ActionError(
        'STALE_SNAPSHOT',
        `element_index ${index} was read from snapshot '${snapshotId}', but '${app}' is now on '${current.snapshotId}'; re-read with get_app_state and use the fresh indices`,
      );
    }
    const element = current.elements[index];
    if (element === undefined) {
      throw new ActionError('UNKNOWN_ELEMENT', `snapshot '${snapshotId}' of '${app}' has ${current.elements.length} elements; there is no element_index ${index}`);
    }
    return element;
  }

  /** Forget an app's reading, so the next index must come from a fresh one. */
  invalidate(app: string): void {
    const next = new Map(this.snapshots);
    next.delete(app);
    this.snapshots = next;
  }
}
