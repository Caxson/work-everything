import { describe, expect, it } from 'vitest';
import { MacAxDriver } from '../src/actions/drivers/macAx.js';
import { flattenAxTree } from '../src/actions/drivers/macAxTree.js';
import { SnapshotStore, withDomClass } from '../src/actions/snapshot.js';
import { AutoWait, type Clock } from '../src/actions/wait.js';
import { bridgeKeyboardRoute, unavailableKeyboardRoute } from '../src/actions/keyboard.js';
import type { ActionError} from '../src/actions/errors.js';
import { isRetryable } from '../src/actions/errors.js';
import type { Clipboard } from '../src/actions/clipboard.js';
import { AxBridgeError } from '../src/perception/macos/axBridge.js';
import { FAKE_APP, fakeAx, nativeTree, webTree, type FakeAxOptions } from './fixtures/fakeAxClient.js';

const APP = FAKE_APP.bundleId;
const clock: Clock = { now: () => 0, sleep: async () => undefined };

function rig(options: FakeAxOptions & { hybrid?: 'bridge' | 'missing'; clipboard?: Clipboard } = {}) {
  const ax = fakeAx({ roots: () => webTree(), ...options });
  const snapshots = new SnapshotStore();
  const driver = new MacAxDriver({
    client: ax.client,
    keyboard: options.hybrid === 'missing' ? unavailableKeyboardRoute() : bridgeKeyboardRoute(ax.client),
    snapshots,
    wait: new AutoWait({ settleMs: 0, maxWaitMs: 0, pollMs: 0 }, clock),
    clock,
    config: { treeTimeoutMs: 50, treePollMs: 1 },
    ...(options.clipboard === undefined ? {} : { clipboard: options.clipboard }),
  });
  return { ax, snapshots, driver };
}

/** Read once and hand back the index of the composer in that reading. */
async function readComposer(rigged: ReturnType<typeof rig>): Promise<{ snapshotId: string; index: number }> {
  const state = await rigged.driver.get_app_state({ app: APP });
  const elements = rigged.snapshots.current(APP)?.elements ?? [];
  const composer = elements.find(withDomClass('editor-kit-container'));
  return { snapshotId: state.snapshotId, index: composer?.index ?? -1 };
}

describe('reading an app', () => {
  it('names the app by its bundle identifier, whatever spelling it was given', async () => {
    const { driver } = rig();
    const state = await driver.get_app_state({ app: '飞书' });
    expect(state.app).toBe(APP);
  });

  it('returns the whole tree the first time and a diff after that', async () => {
    let composer = '';
    const { driver } = rig({ roots: () => webTree(composer) });

    const first = await driver.get_app_state({ app: APP });
    expect(first.diff).toBe(false);
    expect(first.text).toContain('AXWebArea');
    expect(first.text.split('\n').length).toBeGreaterThan(3);

    composer = 'hello';
    const second = await driver.get_app_state({ app: APP });
    expect(second.diff).toBe(true);
    expect(second.text).toBe("+ 5: AXStaticText val='hello'");
  });

  it('gives the full tree back when the caller says disableDiff', async () => {
    const { driver } = rig();
    await driver.get_app_state({ app: APP });
    const full = await driver.get_app_state({ app: APP, disableDiff: true });
    expect(full.diff).toBe(false);
    expect(full.text).toContain('AXWindow');
  });

  it('has no screenshot to offer, and says so rather than inventing a url', async () => {
    const { driver } = rig();
    expect((await driver.get_app_state({ app: APP })).screenshot).toBeNull();
  });

  it('gives every reading its own id', async () => {
    const { driver } = rig();
    const first = await driver.get_app_state({ app: APP });
    const second = await driver.get_app_state({ app: APP });
    expect(first.snapshotId).not.toBe(second.snapshotId);
  });

  it('claims every app, which is why it belongs last in the registry', () => {
    const { driver } = rig();
    expect(driver.supports()).toBe(true);
    expect(driver.kind).toBe('mac_ax');
  });

  it('lists running apps in the shape the action layer speaks', async () => {
    const { driver } = rig();
    expect(await driver.list_apps()).toEqual([{ id: APP, displayName: '飞书', isRunning: true }]);
  });

  it('resolves the app on every call, so a restart with a new pid is picked up', async () => {
    const { driver, ax } = rig();
    await driver.get_app_state({ app: APP });
    await driver.get_app_state({ app: APP });
    expect(ax.callsTo('apps')).toHaveLength(2);
  });

  it('refuses an app that is not running instead of launching it', async () => {
    const { driver, ax } = rig();
    await expect(driver.get_app_state({ app: 'Slack' })).rejects.toThrow(/no running application/);
    expect(ax.ops()).toEqual(['apps']);
  });
});

describe('writing into web content', () => {
  it('types through the keyboard route and never through the accessibility write', async () => {
    const rigged = rig();
    const { snapshotId, index } = await readComposer(rigged);
    await rigged.driver.set_value({ app: APP, element_index: index, snapshot_id: snapshotId, value: 'hello' });

    // Focus first with nothing to type, so select-all and delete are sent to
    // an element already confirmed to hold focus, and only then the text.
    expect(rigged.ax.callsTo('focusAndType').map((call) => call.args)).toEqual([
      { pid: FAKE_APP.pid, nodeId: 5, text: '' },
      { pid: FAKE_APP.pid, nodeId: 5, text: 'hello' },
    ]);
    expect(rigged.ax.callsTo('keystroke').map((call) => call.args)).toEqual([
      { pid: FAKE_APP.pid, key: 'a', modifiers: ['cmd'] },
      { pid: FAKE_APP.pid, key: 'delete', modifiers: [] },
    ]);
    // The measured failure: setValue on a contenteditable reports success and
    // produces no input event. It must never be on this path.
    expect(rigged.ax.callsTo('setValue')).toHaveLength(0);
  });

  it('clears without typing when the new value is empty', async () => {
    const rigged = rig();
    const { snapshotId, index } = await readComposer(rigged);
    await rigged.driver.set_value({ app: APP, element_index: index, snapshot_id: snapshotId, value: '' });
    expect(rigged.ax.callsTo('focusAndType')).toHaveLength(1);
    expect(rigged.ax.callsTo('keystroke')).toHaveLength(2);
  });

  it('fails loudly when the keyboard route is missing, rather than falling back to the write that lies', async () => {
    const rigged = rig({ hybrid: 'missing' });
    const { snapshotId, index } = await readComposer(rigged);
    try {
      await rigged.driver.set_value({ app: APP, element_index: index, snapshot_id: snapshotId, value: 'hello' });
      expect.unreachable('a missing write path must not look like a success');
    } catch (error) {
      expect((error as ActionError).code).toBe('HYBRID_ROUTE_UNAVAILABLE');
      expect((error as ActionError).message).toContain('Nothing was typed');
      expect(isRetryable(error)).toBe(false);
    }
    expect(rigged.ax.callsTo('setValue')).toHaveLength(0);
    expect(rigged.ax.callsTo('keystroke')).toHaveLength(0);
  });

  it('reads a bridge that does not know the op as the route being absent', async () => {
    const ax = fakeAx({ roots: () => webTree(), fail: { focusAndType: new AxBridgeError("unsupported op 'focusAndType'", 'BAD_REQUEST') } });
    const snapshots = new SnapshotStore();
    const driver = new MacAxDriver({
      client: ax.client,
      keyboard: bridgeKeyboardRoute(ax.client),
      snapshots,
      wait: new AutoWait({ settleMs: 0, maxWaitMs: 0, pollMs: 0 }, clock),
      clock,
      config: { treeTimeoutMs: 50, treePollMs: 1 },
    });
    const state = await driver.get_app_state({ app: APP });
    const index = snapshots.current(APP)?.elements.findIndex(withDomClass('editor-kit-container')) ?? -1;
    await expect(driver.set_value({ app: APP, element_index: index, snapshot_id: state.snapshotId, value: 'x' })).rejects.toMatchObject({
      code: 'HYBRID_ROUTE_UNAVAILABLE',
    });
  });

  it('uses the accessibility write on a native control, where it is the right call', async () => {
    const rigged = rig({ roots: () => nativeTree() });
    const state = await rigged.driver.get_app_state({ app: APP });
    const field = rigged.snapshots.current(APP)?.elements.find((element) => element.role === 'AXTextField');
    await rigged.driver.set_value({ app: APP, element_index: field?.index ?? -1, snapshot_id: state.snapshotId, value: 'typed' });
    expect(rigged.ax.callsTo('setValue')[0]?.args).toEqual({ nodeId: 2, value: 'typed' });
    expect(rigged.ax.callsTo('focusAndType')).toHaveLength(0);
    expect(rigged.ax.callsTo('keystroke')).toHaveLength(0);
  });

  it('types into whatever holds focus, resolving that element first', async () => {
    // The helper focuses by node, so "type where the caret is" has to be
    // turned into a node: the application element is a window's AXParent, and
    // AXFocusedUIElement hangs off that.
    const { driver, ax } = rig({ attrs: { AXParent: { nodeId: 900 }, AXFocusedUIElement: { nodeId: 5 } } });
    await driver.type_text({ app: APP, text: 'hi' });
    expect(ax.callsTo('attr').map((call) => call.args)).toEqual([
      { nodeId: 1, name: 'AXParent' },
      { nodeId: 900, name: 'AXFocusedUIElement' },
    ]);
    expect(ax.callsTo('focusAndType')[0]?.args).toEqual({ pid: FAKE_APP.pid, nodeId: 5, text: 'hi' });
  });

  it('says so when nothing can be reached to type into', async () => {
    const { driver } = rig({ roots: () => [], attrs: { AXFocusedUIElement: 'not an element' } });
    await expect(driver.type_text({ app: APP, text: 'hi' })).rejects.toThrow(/no window to reach its focused element/);
  });

  it('reads a nonsense focus answer as an error rather than typing into node zero', async () => {
    const { driver } = rig({ attrs: { AXParent: { nodeId: 900 }, AXFocusedUIElement: 'nothing addressable' } });
    await expect(driver.type_text({ app: APP, text: 'hi' })).rejects.toThrow(/AXFocusedUIElement did not answer/);
  });
});

describe('the rest of the vocabulary', () => {
  it('clicks an element by index, and a point by coordinates', async () => {
    const rigged = rig();
    const { snapshotId, index } = await readComposer(rigged);
    await rigged.driver.click({ app: APP, element_index: index, snapshot_id: snapshotId, mouse_button: 'r', click_count: 2 });
    await rigged.driver.click({ app: APP, x: 12, y: 34 });
    expect(rigged.ax.callsTo('click')[0]?.args).toMatchObject({ nodeId: 5, button: 'right', clickCount: 2 });
    // Codex says `middle`; CoreGraphics says `center`, and sending `middle`
    // is a BAD_REQUEST. The translation happens at the driver boundary.
    await rigged.driver.click({ app: APP, x: 1, y: 1, mouse_button: 'middle' });
    expect(rigged.ax.callsTo('click')[2]?.args).toMatchObject({ button: 'center' });
    expect(rigged.ax.callsTo('click')[1]?.args).toMatchObject({ x: 12, y: 34 });
  });

  it('presses a key as a chord delivered to the process', async () => {
    const { driver, ax } = rig();
    await driver.press_key({ app: APP, key: 'super+Return' });
    expect(ax.callsTo('keystroke')[0]?.args).toEqual({ pid: FAKE_APP.pid, key: 'return', modifiers: ['cmd'] });
  });

  it('scrolls with a wheel event over the element, because AX scroll actions do not exist', async () => {
    // Measured on real AXScrollAreas in Finder and Chrome: the action list is
    // empty, so AXScrollDownByPage is actionUnsupported and nothing moves.
    const rigged = rig();
    const { snapshotId, index } = await readComposer(rigged);
    await rigged.driver.scroll({ app: APP, element_index: index, snapshot_id: snapshotId, direction: 'd', pages: 2 });
    expect(rigged.ax.callsTo('press')).toHaveLength(0);
    // Negative deltaY scrolls down: CoreGraphics' sign, not intuition.
    expect(rigged.ax.callsTo('scroll')[0]?.args).toEqual({ pid: FAKE_APP.pid, nodeId: 5, deltaX: 0, deltaY: -1_600, unit: 'pixel' });
  });

  it('scrolls up, left and right with the signs CoreGraphics uses', async () => {
    const rigged = rig();
    const { snapshotId, index } = await readComposer(rigged);
    const bind = { app: APP, element_index: index, snapshot_id: snapshotId } as const;
    await rigged.driver.scroll({ ...bind, direction: 'up' });
    await rigged.driver.scroll({ ...bind, direction: 'left' });
    await rigged.driver.scroll({ ...bind, direction: 'right' });
    expect(rigged.ax.callsTo('scroll').map((call) => [call.args['deltaX'], call.args['deltaY']])).toEqual([
      [0, 800],
      [800, 0],
      [-800, 0],
    ]);
  });

  it('performs a secondary action by the name it was given, without inventing one', async () => {
    const rigged = rig();
    const { snapshotId, index } = await readComposer(rigged);
    await rigged.driver.perform_secondary_action({ app: APP, element_index: index, snapshot_id: snapshotId, action: 'AXShowMenu' });
    expect(rigged.ax.callsTo('press')[0]?.args).toEqual({ nodeId: 5, action: 'AXShowMenu' });
  });

  it('pastes through the pasteboard and puts the clipboard back', async () => {
    const written: string[] = [];
    const clipboard: Clipboard = { read: async () => 'whatever the user had', write: async (text) => void written.push(text) };
    const { driver, ax } = rig({ clipboard });
    await driver.paste({ app: APP, text: 'pasted', format: 'text' });
    expect(written).toEqual(['pasted', 'whatever the user had']);
    expect(ax.callsTo('keystroke')[0]?.args).toEqual({ pid: FAKE_APP.pid, key: 'v', modifiers: ['cmd'] });
  });

  it('says a paste needs a clipboard when it was built without one', async () => {
    const { driver } = rig();
    await expect(driver.paste({ app: APP, text: 'x', format: 'text' })).rejects.toMatchObject({ code: 'UNSUPPORTED_ACTION' });
  });

  it('scrolls one page when no page count is given', async () => {
    const rigged = rig();
    const { snapshotId, index } = await readComposer(rigged);
    await rigged.driver.scroll({ app: APP, element_index: index, snapshot_id: snapshotId, direction: 'up' });
    expect(rigged.ax.callsTo('scroll')[0]?.args).toMatchObject({ deltaY: 800 });
  });

  it('refuses html rather than pasting the markup as plain text', async () => {
    const clipboard: Clipboard = { read: async () => '', write: async () => undefined };
    const { driver } = rig({ clipboard });
    await expect(driver.paste({ app: APP, text: '<b>x</b>', format: 'html' })).rejects.toMatchObject({ code: 'UNSUPPORTED_ACTION' });
  });

  it('says what it cannot do instead of approximating it', async () => {
    const rigged = rig();
    const { snapshotId, index } = await readComposer(rigged);
    await expect(rigged.driver.drag({ app: APP, from_x: 0, from_y: 0, to_x: 1, to_y: 1 })).rejects.toMatchObject({ code: 'UNSUPPORTED_ACTION' });
    await expect(rigged.driver.select_text({ app: APP, element_index: index, snapshot_id: snapshotId, text: 'x' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_ACTION',
    });
    // Neither reached the app.
    expect(rigged.ax.callsTo('click')).toHaveLength(0);
    expect(rigged.ax.callsTo('keystroke')).toHaveLength(0);
  });
});

describe('acting on a reading that has moved on', () => {
  it('refuses an index from a superseded reading', async () => {
    const rigged = rig();
    const first = await readComposer(rigged);
    await rigged.driver.get_app_state({ app: APP });
    await expect(
      rigged.driver.click({ app: APP, element_index: first.index, snapshot_id: first.snapshotId }),
    ).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
    expect(rigged.ax.callsTo('click')).toHaveLength(0);
  });

  it('waits for the app to catch up before the reading that follows an action', async () => {
    let now = 0;
    const slept: number[] = [];
    const paced: Clock = {
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    };
    const ax = fakeAx({ roots: () => webTree() });
    const snapshots = new SnapshotStore();
    const driver = new MacAxDriver({
      client: ax.client,
      keyboard: bridgeKeyboardRoute(ax.client),
      snapshots,
      wait: new AutoWait({ settleMs: 1_000, maxWaitMs: 0, pollMs: 250 }, paced),
      clock: paced,
      config: { treeTimeoutMs: 50, treePollMs: 1 },
    });

    await driver.get_app_state({ app: APP });
    expect(slept).toEqual([]);
    await driver.press_key({ app: APP, key: 'Return' });
    await driver.get_app_state({ app: APP });
    expect(slept).toEqual([1_000]);
  });
});

describe('settling after an action', () => {
  it('re-reads until two readings agree, and stops when the app is no longer busy', async () => {
    let now = 0;
    const paced: Clock = {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    };
    // The tree changes once more after the action, then holds still.
    let reads = 0;
    const ax = fakeAx({
      roots: () => {
        reads += 1;
        return webTree(reads < 3 ? '' : 'settled');
      },
    });
    const driver = new MacAxDriver({
      client: ax.client,
      keyboard: bridgeKeyboardRoute(ax.client),
      snapshots: new SnapshotStore(),
      wait: new AutoWait({ settleMs: 0, maxWaitMs: 1_000, pollMs: 100 }, paced),
      clock: paced,
      config: { treeTimeoutMs: 50, treePollMs: 1 },
    });

    await driver.press_key({ app: APP, key: 'Return' });
    const state = await driver.get_app_state({ app: APP, disableDiff: true });
    expect(state.text).toContain('settled');
    expect(ax.callsTo('roots').length).toBeGreaterThan(2);
  });

  it('runs on the real clock when it is given none', async () => {
    const ax = fakeAx({ roots: () => webTree() });
    const driver = new MacAxDriver({
      client: ax.client,
      keyboard: bridgeKeyboardRoute(ax.client),
      snapshots: new SnapshotStore(),
      wait: new AutoWait({ settleMs: 0, maxWaitMs: 0, pollMs: 1 }),
      config: { treeTimeoutMs: 200, treePollMs: 1 },
    });
    await expect(driver.get_app_state({ app: APP })).resolves.toMatchObject({ app: APP });
  });
});

describe('a locked screen', () => {
  it('is terminal: reported once, in plain words, and not retried', async () => {
    const ax = fakeAx({ roots: () => webTree(), fail: { awaitTree: new AxBridgeError('windows are not addressable', 'SCREEN_LOCKED') } });
    const driver = new MacAxDriver({
      client: ax.client,
      keyboard: bridgeKeyboardRoute(ax.client),
      snapshots: new SnapshotStore(),
      wait: new AutoWait({ settleMs: 0, maxWaitMs: 0, pollMs: 0 }, clock),
      clock,
      config: { treeTimeoutMs: 5_000, treePollMs: 1 },
    });

    try {
      await driver.get_app_state({ app: APP });
      expect.unreachable('a locked screen must be an error');
    } catch (error) {
      expect((error as ActionError).code).toBe('SCREEN_LOCKED');
      expect(isRetryable(error)).toBe(false);
      expect((error as ActionError).message).toContain('unlocks it');
    }
    // One attempt, not a poll loop against something only a person can fix.
    expect(ax.callsTo('awaitTree')).toHaveLength(1);
    expect(ax.callsTo('findWithBudget')).toHaveLength(0);
  });
});

describe('flattening a tree', () => {
  it('numbers elements in document order and records how deep each one sits', () => {
    const elements = flattenAxTree(webTree('draft'));
    expect(elements.map((element) => element.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(elements.map((element) => element.depth)).toEqual([0, 1, 2, 3, 2, 3]);
    expect(elements[0]?.handle).toBe(1);
  });

  it('marks everything under a web area as web content', () => {
    const elements = flattenAxTree(webTree('draft'));
    expect(elements.map((element) => element.web)).toEqual([false, true, true, true, true, true]);
    expect(flattenAxTree(nativeTree()).every((element) => !element.web)).toBe(true);
  });
});
