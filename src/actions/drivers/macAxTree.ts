/**
 * An accessibility tree, flattened into an addressable list.
 *
 * Document order, one entry per element, which is what makes an
 * `element_index` mean something a human could also point at. The one
 * judgement made here is `web`: everything under an `AXWebArea` is web
 * content, and web content is where accessibility writes report success and
 * change nothing (`docs/TODO.md`). Marking it at read time is what lets the
 * driver pick the right write path later without re-deriving it.
 */
import type { AxNode } from '../../perception/macos/axProtocol.js';
import { WEB_AREA_ROLE } from '../../perception/macos/axAwait.js';
import type { SnapshotElement } from '../snapshot.js';

export function flattenAxTree(roots: readonly AxNode[]): readonly SnapshotElement[] {
  const elements: SnapshotElement[] = [];

  const visit = (node: AxNode, depth: number, inWeb: boolean): void => {
    const web = inWeb || node.role === WEB_AREA_ROLE;
    elements.push({
      index: elements.length,
      depth,
      role: node.role,
      subrole: node.subrole,
      title: node.title,
      value: node.value,
      description: node.description,
      identifier: node.identifier,
      domId: node.domId,
      domClasses: node.domClasses,
      web,
      handle: node.nodeId,
    });
    for (const child of node.children ?? []) visit(child, depth + 1, web);
  };

  for (const root of roots) visit(root, 0, false);
  return elements;
}
