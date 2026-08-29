/**
 * Reading an `AxNode` tree.
 *
 * Nothing here knows about any particular application: these are the four
 * things every accessibility-driven adapter needs — walk the tree, find nodes
 * by a predicate, ask whether a node carries a DOM class, and flatten the text
 * under a subtree. Keeping them generic is what stops each new app adapter
 * from growing its own slightly different traversal.
 */
import type { AxNode } from './axProtocol.js';

export type NodePredicate = (node: AxNode) => boolean;

/** Depth-first, document order. Yields the roots themselves as well. */
export function* walk(roots: readonly AxNode[]): Generator<AxNode> {
  for (const root of roots) {
    yield root;
    yield* walk(root.children ?? []);
  }
}

/** Every node matching `predicate`, in document order, optionally capped. */
export function findAll(roots: readonly AxNode[], predicate: NodePredicate, limit = 0): readonly AxNode[] {
  const found: AxNode[] = [];
  for (const node of walk(roots)) {
    if (!predicate(node)) continue;
    found.push(node);
    if (limit > 0 && found.length >= limit) break;
  }
  return found;
}

export function findFirst(roots: readonly AxNode[], predicate: NodePredicate): AxNode | undefined {
  return findAll(roots, predicate, 1)[0];
}

/** Predicate: the node's DOM class list contains every one of `wanted`. */
export function hasDomClass(...wanted: readonly string[]): NodePredicate {
  return (node) => {
    const classes = node.domClasses ?? [];
    return classes.length > 0 && wanted.every((name) => classes.includes(name));
  };
}

/** Predicate: role, and every supplied DOM class. */
export function isRoleWithClass(role: string, ...wanted: readonly string[]): NodePredicate {
  const byClass = hasDomClass(...wanted);
  return (node) => node.role === role && byClass(node);
}

/**
 * Every `AXStaticText` value under a subtree, in visual order. Web content
 * puts the words a human reads in leaf text nodes, never on the container, so
 * this is how any text is actually recovered.
 */
export function collectText(root: AxNode, staticTextRole: string): readonly string[] {
  const out: string[] = [];
  for (const node of walk([root])) {
    if (node.role !== staticTextRole) continue;
    const value = node.value;
    if (typeof value === 'string' && value !== '') out.push(value);
  }
  return out;
}

/** `collectText`, joined and trimmed — the common case. */
export function textOf(root: AxNode, staticTextRole: string): string {
  return collectText(root, staticTextRole).join('').trim();
}
