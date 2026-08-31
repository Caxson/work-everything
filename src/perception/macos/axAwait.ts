/**
 * Waiting for an app's accessibility tree to become real.
 *
 * Measured, not guessed (`docs/TODO.md`, "Rules the executor must follow"):
 * a CEF app's tree is built by the act of reading it, per client process, and
 * the first traversal returns a stub — often the menu bar alone, which is
 * three hundred nodes and looks exactly like a real tree. Two rules follow,
 * and both are load-bearing:
 *
 * - Never sleep a fixed interval and assume readiness. Poll until a web area
 *   appears, then proceed; time out with an error rather than act on a stub.
 * - Judge readiness by the number of `AXWebArea` hits, never by the node
 *   count. A menu bar alone clears any plausible node threshold.
 *
 * The helper implements exactly that in its `awaitTree` op, so that is what
 * gets called. It waits specifically for web content, which leaves one case
 * it cannot answer: an app that has none. A native Cocoa app has no web area
 * to wait for and would time out forever, so that case — and only that case —
 * settles here instead, on the one other thing "finished being built" can
 * mean: two consecutive traversals that agree on the size of the tree.
 */
import type { AxBridgeClient } from './axBridge.js';
import { AxBridgeError } from './axBridge.js';
import type { AxNode } from './axProtocol.js';

export interface AwaitTreeOptions {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface TreeReading {
  readonly roots: readonly AxNode[];
  /** How many `AXWebArea` elements were found. Zero for a native app. */
  readonly webAreas: number;
  /** Traversals it took to get here. */
  readonly attempts: number;
}

export const WEB_AREA_ROLE = 'AXWebArea';

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isNotReady(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'TREE_NOT_READY' || code === 'tree_not_ready';
}

/** Wait for the tree to be worth reading, then read it once. */
export async function awaitTree(client: AxBridgeClient, pid: number, options: AwaitTreeOptions): Promise<TreeReading> {
  const limits = { maxDepth: options.maxDepth, maxNodes: options.maxNodes };
  try {
    const readiness = await client.awaitTree({ pid, timeoutMs: options.timeoutMs, pollMs: options.pollMs, ...limits });
    return { roots: await client.roots(pid, options.maxDepth, options.maxNodes), webAreas: readiness.webAreas, attempts: readiness.polls };
  } catch (error) {
    if (!isNotReady(error)) throw error;
    return await settleWithoutWebContent(client, pid, options, error);
  }
}

/**
 * An app with no web content at all. Two probes that agree on how much there
 * is to walk mean the tree has finished being built; anything else keeps the
 * helper's own error, which describes what it saw. A traversal that hit its
 * budget is not evidence of anything — two equal counts there only say the
 * budget did not change.
 */
async function settleWithoutWebContent(
  client: AxBridgeClient,
  pid: number,
  options: AwaitTreeOptions,
  notReady: unknown,
): Promise<TreeReading> {
  const sleep = options.sleep ?? defaultSleep;
  const limits = { maxDepth: options.maxDepth, maxNodes: options.maxNodes };
  const selector = { role: WEB_AREA_ROLE, maxResults: 1 } as const;

  const first = await client.findWithBudget(pid, selector, limits);
  await sleep(options.pollMs);
  const second = await client.findWithBudget(pid, selector, limits);

  // A truncated traversal stopped at the budget, so two equal counts say the
  // budget is the same size, not that the tree has stopped growing.
  const budgeted = first.truncated === true || second.truncated === true;
  const stable = !budgeted && first.visited > 0 && first.visited === second.visited;
  if (second.nodes.length > 0 || !stable) throw notReady;
  return { roots: await client.roots(pid, options.maxDepth, options.maxNodes), webAreas: 0, attempts: 2 };
}

/** The error the helper raises when a tree never arrived. Re-used by tests. */
export function treeNotReady(pid: number, timeoutMs: number): AxBridgeError {
  return new AxBridgeError(`process ${pid} exposed no readable tree within ${timeoutMs}ms`, 'TREE_NOT_READY');
}
