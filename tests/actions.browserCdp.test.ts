import { describe, expect, it } from 'vitest';
import { BrowserCdpDriver, DEFAULT_BROWSER_TARGETS, flattenCdpTree, type CdpTransport } from '../src/actions/drivers/browserCdp.js';
import { SCROLL_PAGE_PIXELS } from '../src/actions/driver.js';
import { SnapshotStore } from '../src/actions/snapshot.js';
import { AutoWait, type Clock } from '../src/actions/wait.js';
import type { ActionError } from '../src/actions/errors.js';

const CHROME = 'com.google.Chrome';
const clock: Clock = { now: () => 0, sleep: async () => undefined };

/** An accessibility tree as CDP hands it over: flat, with child ids. */
const AX_TREE = {
  nodes: [
    { nodeId: '1', backendDOMNodeId: 11, role: { value: 'RootWebArea' }, name: { value: 'Example' }, childIds: ['2', '3'] },
    { nodeId: '2', backendDOMNodeId: 12, role: { value: 'textbox' }, name: { value: 'Search' }, value: { value: 'cats' }, childIds: [] },
    { nodeId: '3', backendDOMNodeId: 13, role: { value: 'button' }, name: { value: 'Go' }, childIds: [] },
  ],
};

function recorder(responses: Readonly<Record<string, unknown>> = {}): CdpTransport & { readonly sent: { method: string; params: unknown }[] } {
  const sent: { method: string; params: unknown }[] = [];
  return {
    sent,
    send: async (method, params) => {
      sent.push({ method, params });
      return responses[method] ?? {};
    },
  };
}

function rig(transport?: CdpTransport) {
  const snapshots = new SnapshotStore();
  const driver = new BrowserCdpDriver({
    ...(transport === undefined ? {} : { transport }),
    snapshots,
    wait: new AutoWait({ settleMs: 0, maxWaitMs: 0, pollMs: 0 }, clock),
    clock,
  });
  return { driver, snapshots };
}

describe('which apps the browser driver claims', () => {
  it('takes the browsers and leaves everything else alone', () => {
    const { driver } = rig();
    expect(driver.supports(CHROME)).toBe(true);
    expect(driver.supports('Google Chrome')).toBe(true);
    expect(driver.supports('com.bytedance.macos.feishu')).toBe(false);
    expect(DEFAULT_BROWSER_TARGETS).toContain('com.microsoft.edgemac');
  });

  it('takes a configured list instead, when it is given one', () => {
    const driver = new BrowserCdpDriver({ snapshots: new SnapshotStore(), wait: new AutoWait(), targets: ['Arc'] });
    expect(driver.supports('arc')).toBe(true);
    expect(driver.supports(CHROME)).toBe(false);
  });
});

describe('with no connection', () => {
  it('says it is not connected rather than pretending the action happened', async () => {
    const { driver } = rig();
    try {
      await driver.type_text({ app: CHROME, text: 'hi' });
      expect.unreachable('an unsent action must not resolve');
    } catch (error) {
      expect((error as ActionError).code).toBe('NOT_CONNECTED');
      expect((error as ActionError).message).toContain('Input.insertText');
    }
  });

  it('reports no apps at all rather than a browser it cannot drive', async () => {
    expect(await rig().driver.list_apps()).toEqual([]);
  });
});

describe('driving a page', () => {
  it('reads the accessibility tree and returns a diff on the second look', async () => {
    const transport = recorder({ 'Accessibility.getFullAXTree': AX_TREE });
    const { driver } = rig(transport);
    const first = await driver.get_app_state({ app: CHROME });
    expect(first.diff).toBe(false);
    expect(first.text).toContain("1: textbox title='Search' val='cats'");
    expect((await driver.get_app_state({ app: CHROME })).diff).toBe(true);
  });

  it('clicks the centre of an element it was given by index', async () => {
    const transport = recorder({
      'Accessibility.getFullAXTree': AX_TREE,
      'DOM.getBoxModel': { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } },
    });
    const { driver } = rig(transport);
    const state = await driver.get_app_state({ app: CHROME });
    await driver.click({ app: CHROME, element_index: 2, snapshot_id: state.snapshotId });

    expect(transport.sent.find((call) => call.method === 'DOM.getBoxModel')?.params).toEqual({ backendNodeId: 13 });
    const clicks = transport.sent.filter((call) => call.method === 'Input.dispatchMouseEvent');
    expect(clicks.map((call) => (call.params as { type: string }).type)).toEqual(['mousePressed', 'mouseReleased']);
    expect(clicks[0]?.params).toMatchObject({ x: 20, y: 30, button: 'left', clickCount: 1 });
  });

  it('refuses an index from a superseded reading here too', async () => {
    const transport = recorder({ 'Accessibility.getFullAXTree': AX_TREE });
    const { driver } = rig(transport);
    const first = await driver.get_app_state({ app: CHROME });
    await driver.get_app_state({ app: CHROME });
    await expect(driver.click({ app: CHROME, element_index: 1, snapshot_id: first.snapshotId })).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
  });

  it('says so when an element has no box to click', async () => {
    const transport = recorder({ 'Accessibility.getFullAXTree': AX_TREE, 'DOM.getBoxModel': {} });
    const { driver } = rig(transport);
    const state = await driver.get_app_state({ app: CHROME });
    await expect(driver.click({ app: CHROME, element_index: 1, snapshot_id: state.snapshotId })).rejects.toThrow(/no box to click/);
  });

  it('types, presses keys and pastes as input events', async () => {
    const transport = recorder();
    const { driver } = rig(transport);
    await driver.type_text({ app: CHROME, text: 'hello' });
    await driver.press_key({ app: CHROME, key: 'super+c' });
    await driver.paste({ app: CHROME, text: 'pasted', format: 'text' });

    expect(transport.sent[0]).toEqual({ method: 'Input.insertText', params: { text: 'hello' } });
    const keys = transport.sent.filter((call) => call.method === 'Input.dispatchKeyEvent');
    expect(keys.map((call) => (call.params as { type: string }).type)).toEqual(['keyDown', 'keyUp']);
    // Meta is bit 4 in CDP's modifier mask.
    expect(keys[0]?.params).toMatchObject({ key: 'c', modifiers: 4 });
    expect(transport.sent.at(-1)).toEqual({ method: 'Input.insertText', params: { text: 'pasted' } });
  });

  it('replaces a field by focusing it, selecting everything and inserting', async () => {
    const transport = recorder({ 'Accessibility.getFullAXTree': AX_TREE });
    const { driver } = rig(transport);
    const state = await driver.get_app_state({ app: CHROME });
    await driver.set_value({ app: CHROME, element_index: 1, snapshot_id: state.snapshotId, value: 'dogs' });
    expect(transport.sent.map((call) => call.method)).toEqual([
      'Accessibility.getFullAXTree',
      'DOM.focus',
      'Input.dispatchKeyEvent',
      'Input.dispatchKeyEvent',
      'Input.insertText',
    ]);
  });

  it('scrolls with a wheel event and drags with a press, a move and a release', async () => {
    const transport = recorder({
      'Accessibility.getFullAXTree': AX_TREE,
      'DOM.getBoxModel': { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } },
    });
    const { driver } = rig(transport);
    const state = await driver.get_app_state({ app: CHROME });
    await driver.scroll({ app: CHROME, element_index: 1, snapshot_id: state.snapshotId, direction: 'down', pages: 2 });
    expect(transport.sent.at(-1)?.params).toMatchObject({ type: 'mouseWheel', deltaY: SCROLL_PAGE_PIXELS * 2, deltaX: 0 });

    await driver.drag({ app: CHROME, from_x: 1, from_y: 2, to_x: 3, to_y: 4 });
    expect(transport.sent.slice(-3).map((call) => (call.params as { type: string }).type)).toEqual(['mousePressed', 'mouseMoved', 'mouseReleased']);
  });

  it('settles by re-reading until two readings of the page agree', async () => {
    let now = 0;
    const paced = {
      now: () => now,
      sleep: async (ms: number): Promise<void> => {
        now += ms;
      },
    };
    let reads = 0;
    const transport: CdpTransport = {
      send: async (method) => {
        if (method !== 'Accessibility.getFullAXTree') return {};
        reads += 1;
        return reads < 2 ? { nodes: AX_TREE.nodes.slice(0, 2) } : AX_TREE;
      },
    };
    const driver = new BrowserCdpDriver({
      transport,
      snapshots: new SnapshotStore(),
      wait: new AutoWait({ settleMs: 0, maxWaitMs: 1_000, pollMs: 100 }, paced),
      clock: paced,
    });
    await driver.type_text({ app: CHROME, text: 'x' });
    const state = await driver.get_app_state({ app: CHROME, disableDiff: true });
    expect(state.text).toContain('button');
    expect(reads).toBeGreaterThan(2);
  });

  it('runs on the real clock when it is given none', async () => {
    const driver = new BrowserCdpDriver({
      transport: recorder({ 'Accessibility.getFullAXTree': AX_TREE }),
      snapshots: new SnapshotStore(),
      wait: new AutoWait({ settleMs: 0, maxWaitMs: 0, pollMs: 1 }),
    });
    await expect(driver.get_app_state({ app: CHROME })).resolves.toMatchObject({ app: CHROME });
  });

  it('names the browser it is connected to', async () => {
    const { driver } = rig(recorder({ 'Browser.getVersion': { product: 'Chrome/143.0.0.0' } }));
    expect(await driver.list_apps()).toEqual([{ id: DEFAULT_BROWSER_TARGETS[0], displayName: 'Chrome/143.0.0.0', isRunning: true }]);
  });

  it('says which two actions it has no equivalent for', async () => {
    const { driver } = rig(recorder());
    await expect(driver.select_text({ app: CHROME, element_index: 0, snapshot_id: 's', text: 'x' })).rejects.toMatchObject({ code: 'UNSUPPORTED_ACTION' });
    await expect(driver.perform_secondary_action({ app: CHROME, element_index: 0, snapshot_id: 's', action: 'AXShowMenu' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_ACTION',
    });
    await expect(driver.paste({ app: CHROME, text: '<b>x</b>', format: 'html' })).rejects.toMatchObject({ code: 'UNSUPPORTED_ACTION' });
  });

  it('reports a transport failure as a driver error, with the method that failed', async () => {
    const failing: CdpTransport = { send: async () => Promise.reject(new Error('socket closed')) };
    const { driver } = rig(failing);
    await expect(driver.type_text({ app: CHROME, text: 'x' })).rejects.toThrow(/browser_cdp.Input.insertText: socket closed/);
  });

  it('says so when the page returns something that is not a tree', async () => {
    const { driver } = rig(recorder({ 'Accessibility.getFullAXTree': { nodes: 'nope' } }));
    await expect(driver.get_app_state({ app: CHROME })).rejects.toThrow(/returned no nodes/);
  });
});

describe('flattening what CDP returns', () => {
  it('recovers document order and depth from the child ids', () => {
    const elements = flattenCdpTree(AX_TREE.nodes);
    expect(elements.map((element) => element.role)).toEqual(['RootWebArea', 'textbox', 'button']);
    expect(elements.map((element) => element.depth)).toEqual([0, 1, 1]);
    expect(elements.map((element) => element.handle)).toEqual([11, 12, 13]);
    expect(elements.every((element) => element.web)).toBe(true);
  });

  it('copes with a node list that names no root', () => {
    expect(flattenCdpTree([])).toEqual([]);
  });
});
