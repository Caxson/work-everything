import { describe, expect, it } from 'vitest';
import { awaitTree, treeNotReady } from '../src/perception/macos/axAwait.js';
import { AxBridgeError, type AxAwaitTreeRequest, type AxBridgeClient, type AxFindBudget, type AxTreeReadiness } from '../src/perception/macos/axBridge.js';
import type { AxNode } from '../src/perception/macos/axProtocol.js';

const ROOTS: readonly AxNode[] = [{ nodeId: 1, role: 'AXWindow', children: [{ nodeId: 2, role: 'AXWebArea' }] }];

interface Script {
  /** What the helper's own wait answers, or throws. */
  readonly readiness?: AxTreeReadiness | Error;
  /** What the fallback probes see, one per call. */
  readonly probes?: readonly { webAreas: number; visited: number }[];
}

function bridge(script: Script): { client: AxBridgeClient; ops: () => readonly string[] } {
  const ops: string[] = [];
  let probe = 0;
  const client = {
    awaitTree: async (request: AxAwaitTreeRequest): Promise<AxTreeReadiness> => {
      ops.push('awaitTree');
      expect(request.pid).toBe(42);
      if (script.readiness instanceof Error) throw script.readiness;
      return script.readiness ?? { ready: true, nodes: 9_000, webAreas: 2, polls: 3 };
    },
    findWithBudget: async (): Promise<AxFindBudget> => {
      ops.push('findWithBudget');
      const step = script.probes?.[Math.min(probe, (script.probes.length ?? 1) - 1)] ?? { webAreas: 0, visited: 0 };
      probe += 1;
      return { nodes: Array.from({ length: step.webAreas }, (): AxNode => ({ nodeId: -1, role: 'AXWebArea' })), visited: step.visited };
    },
    roots: async (): Promise<readonly AxNode[]> => {
      ops.push('roots');
      return ROOTS;
    },
  };
  return { client: client as unknown as AxBridgeClient, ops: () => ops };
}

const options = { maxDepth: 45, maxNodes: 12_000, timeoutMs: 1_000, pollMs: 1, sleep: async (): Promise<void> => undefined };

describe('waiting for a tree that is worth reading', () => {
  it('lets the helper do the waiting, then reads the tree exactly once', async () => {
    const rig = bridge({});
    const reading = await awaitTree(rig.client, 42, options);
    expect(reading).toMatchObject({ webAreas: 2, attempts: 3, roots: ROOTS });
    expect(rig.ops()).toEqual(['awaitTree', 'roots']);
  });

  it('settles a native app, which has no web area for the helper to wait for', async () => {
    // The helper waits specifically for web content, so a Cocoa app always
    // times out there. Two traversals that agree on the size of the tree are
    // the only other thing "finished being built" can mean.
    const rig = bridge({
      readiness: treeNotReady(42, 1_000),
      probes: [
        { webAreas: 0, visited: 120 },
        { webAreas: 0, visited: 120 },
      ],
    });
    const reading = await awaitTree(rig.client, 42, options);
    expect(reading.webAreas).toBe(0);
    expect(reading.attempts).toBe(2);
    expect(rig.ops()).toEqual(['awaitTree', 'findWithBudget', 'findWithBudget', 'roots']);
  });

  it('keeps the helper error when the tree is still growing', async () => {
    const rig = bridge({
      readiness: treeNotReady(42, 1_000),
      probes: [
        { webAreas: 0, visited: 311 },
        { webAreas: 0, visited: 940 },
      ],
    });
    await expect(awaitTree(rig.client, 42, options)).rejects.toMatchObject({ code: 'TREE_NOT_READY' });
    expect(rig.ops()).not.toContain('roots');
  });

  it('keeps the helper error when there is nothing there at all', async () => {
    const rig = bridge({ readiness: treeNotReady(42, 1_000), probes: [{ webAreas: 0, visited: 0 }] });
    await expect(awaitTree(rig.client, 42, options)).rejects.toMatchObject({ code: 'TREE_NOT_READY' });
  });

  it('does not treat an app that does have web content as a native one', async () => {
    // A web area that turns up in the fallback probe means the app was simply
    // not ready yet, not that it has no web content. That is the helper's
    // verdict to keep.
    const rig = bridge({
      readiness: treeNotReady(42, 1_000),
      probes: [
        { webAreas: 0, visited: 400 },
        { webAreas: 1, visited: 400 },
      ],
    });
    await expect(awaitTree(rig.client, 42, options)).rejects.toMatchObject({ code: 'TREE_NOT_READY' });
  });

  it('passes anything that is not a readiness failure straight through', async () => {
    const rig = bridge({ readiness: new AxBridgeError('windows are not addressable', 'SCREEN_LOCKED') });
    await expect(awaitTree(rig.client, 42, options)).rejects.toMatchObject({ code: 'SCREEN_LOCKED' });
    expect(rig.ops()).toEqual(['awaitTree']);
  });

  it('runs on the real clock when it is given none', async () => {
    const rig = bridge({
      readiness: treeNotReady(42, 1),
      probes: [
        { webAreas: 0, visited: 7 },
        { webAreas: 0, visited: 7 },
      ],
    });
    const reading = await awaitTree(rig.client, 42, { maxDepth: 10, maxNodes: 100, timeoutMs: 50, pollMs: 1 });
    expect(reading.attempts).toBe(2);
  });
});
