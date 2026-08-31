import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AxBridgeClient, AxBridgeError, AxPerceiver, toEvent } from '../src/perception/macos/axBridge.js';

const helper = fileURLToPath(new URL('./fixtures/fakeAx.mjs', import.meta.url));
const spawnFake =
  (env: NodeJS.ProcessEnv = {}) =>
  (): ReturnType<typeof spawn> =>
    spawn(process.execPath, [helper], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });

let client: AxBridgeClient | undefined;

const start = (timeoutMs = 2000, env: NodeJS.ProcessEnv = {}): AxBridgeClient => {
  client = new AxBridgeClient({ binaryPath: '/nonexistent/we-ax', requestTimeoutMs: timeoutMs, spawnFn: spawnFake(env) });
  client.start();
  return client;
};

afterEach(async () => {
  await client?.stop();
  client = undefined;
});

describe('ax bridge client', () => {
  it('refuses to start when the binary is absent, and says where to get it', () => {
    const bare = new AxBridgeClient({ binaryPath: '/nonexistent/we-ax', requestTimeoutMs: 100 });
    expect(() => bare.start()).toThrow(/native\/ax-bridge/);
    expect(bare.running).toBe(false);
  });

  it('rejects requests made before it is running', async () => {
    const bare = new AxBridgeClient({ binaryPath: '/nonexistent/we-ax', requestTimeoutMs: 100 });
    await expect(bare.request('trusted')).rejects.toThrow(/not running/);
  });

  it('round-trips the typed ops', async () => {
    const c = start();
    expect(await c.trusted()).toBe(true);
    expect(await c.apps()).toEqual([{ pid: 42, name: 'Feishu', bundleId: 'com.feishu.app' }]);
    expect((await c.tree(42, 3, 100)).children?.[0]?.value).toBe('hi');
    expect((await c.find(42, { role: 'AXButton', maxResults: 1 }))[0]?.title).toBe('Send');
    expect(await c.attr(10, 'AXTitle')).toBe('Send');
    await expect(c.enableAX(42)).resolves.toBeUndefined();
    await expect(c.setValue(10, 'hello')).resolves.toBeUndefined();
    await expect(c.press(10)).resolves.toBeUndefined();
    await expect(c.focus(10)).resolves.toBeUndefined();
    await expect(c.keystroke(42, 'a', ['cmd'])).resolves.toBeUndefined();
    await expect(c.unobserve(7)).resolves.toBeUndefined();
  });

  it('clicks a node or a point, and refuses a click with neither', async () => {
    const c = start();
    await expect(c.click({ nodeId: 10, button: 'right', clickCount: 2 })).resolves.toBeUndefined();
    await expect(c.click({ x: 4, y: 5 })).resolves.toBeUndefined();
    await expect(c.click({})).rejects.toThrow(/needs a nodeId, or both x and y/);
  });

  it('performs a named accessibility action, not only AXPress', async () => {
    const c = start();
    await expect(c.press(10, 'AXScrollDownByPage')).resolves.toBeUndefined();
  });

  it('always asks for the window diagnosis, and reports it alongside the windows', async () => {
    const c = start();
    const reading = await c.windows(42);
    expect(reading.diagnosis).toEqual({ code: 'OK', addressable: 1 });
    expect(reading.windows[0]).toMatchObject({ nodeId: 10, windowNumber: 7, resolvedBy: 'ax', addressable: true });
  });

  it('turns a classified refusal into a diagnosis rather than a throw', async () => {
    // A locked screen is refused by the helper's dispatch gate, before the
    // handler that would have classified it — so it arrives as an error even
    // with `meta`. Callers must still see one shape, with the census intact.
    const c = start(2000, { FAKE_WINDOWS_LOCKED: '1' });
    const reading = await c.windows(42);
    expect(reading.windows).toEqual([]);
    expect(reading.diagnosis.code).toBe('SCREEN_LOCKED');
    expect(reading.diagnosis.details).toMatchObject({ cgWindows: 2, onScreen: 0 });
  });

  it('lets a fault that is not a diagnosis keep throwing', async () => {
    const c = start();
    await expect(c.request('boom')).rejects.toThrow(/element went away/);
  });

  it('carries the structured details the helper attaches to a failure', async () => {
    const c = start();
    await expect(c.request('locked')).rejects.toMatchObject({ code: 'SCREEN_LOCKED', details: { cgWindows: 2, onScreen: 0 } });
  });

  it('scrolls with a wheel event over an element', async () => {
    const c = start();
    await expect(c.scroll({ pid: 42, nodeId: 10, deltaY: -800, unit: 'pixel' })).resolves.toBeUndefined();
  });

  it('asks for a traversal budget alongside the hits', async () => {
    const c = start();
    const budget = await c.findWithBudget(42, { role: 'AXButton' }, { maxDepth: 10, maxNodes: 100 });
    expect(budget.visited).toBe(2);
    expect(budget.nodes[0]?.title).toBe('Send');
  });

  it('waits for a tree through the helper, and types through the hybrid route', async () => {
    const c = start();
    expect(await c.awaitTree({ pid: 42, timeoutMs: 100, pollMs: 10, maxDepth: 10, maxNodes: 100 })).toMatchObject({ ready: true, webAreas: 1, polls: 1 });
    expect(await c.focusAndType({ pid: 42, nodeId: 10, text: 'hi' })).toMatchObject({ focused: { action: 'AXPress' } });
  });

  it('correlates concurrent requests by id', async () => {
    const c = start();
    const [trusted, apps] = await Promise.all([c.trusted(), c.apps()]);
    expect(trusted).toBe(true);
    expect(apps).toHaveLength(1);
  });

  it('surfaces a helper error with its code', async () => {
    const c = start();
    await expect(c.request('press', { nodeId: -1 })).resolves.toBeDefined();
    await expect(c.request('boom' as never)).rejects.toMatchObject({ code: 'ax_error' });
  });

  it('times out a request the helper never answers', async () => {
    const c = start(80);
    await expect(c.request('silent' as never)).rejects.toThrow(/timed out/);
  });

  it('keeps reading after a malformed line', async () => {
    const c = start();
    expect(await c.request('malformed' as never)).toEqual({ fine: true });
  });

  it('handles a response split across writes', async () => {
    const c = start();
    expect(await c.request('split' as never)).toEqual({ split: true });
  });

  it('delivers subscription events to listeners', async () => {
    const c = start();
    const received: string[] = [];
    const off = c.onNotification((notification) => received.push(notification.notification));
    expect(await c.observe(42, ['AXValueChanged'])).toBe(7);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(received).toEqual(['AXValueChanged']);
    off();
  });

  it('fails outstanding requests when the helper exits', async () => {
    const c = start();
    const pending = c.request('silent' as never);
    await c.request('bye' as never).catch(() => undefined);
    await expect(pending).rejects.toBeInstanceOf(AxBridgeError);
  });

  it('reads the lock state without naming an application', async () => {
    // Ops that resolve a window are refused while locked (covered above). The
    // lock poll goes through `env`, which takes no pid — so it keeps answering
    // when the watched app has quit, and a screen that unlocks while it is gone
    // is still noticed.
    const c = start(2000, { FAKE_LOCKED: '1' });
    expect(await c.screenState()).toEqual({ locked: true, lockedSince: '2026-08-31 10:00:00 +0000' });
    expect((await c.env()).screen.locked).toBe(true);
  });

  it('reports an unlocked screen without inventing a lock time', async () => {
    expect(await start().screenState()).toEqual({ locked: false });
  });

  it('still answers windowInfo per application, for a diagnosis of one app', async () => {
    const c = start(2000, { FAKE_LOCKED: '1' });
    const info = await c.windowInfo(42);
    expect(info.screen.locked).toBe(true);
    expect(info.diagnosis).toEqual({ code: 'SCREEN_LOCKED' });
  });

  it('is safe to stop twice', async () => {
    const c = start();
    await c.stop();
    await expect(c.stop()).resolves.toBeUndefined();
  });
});

describe('ax perceiver', () => {
  it('turns a notification into a routable event', () => {
    const event = toEvent({ event: 'ax', subscription: 7, notification: 'AXValueChanged', nodeId: 11, pid: 42 }, 'Feishu');
    expect(event.source).toBe('macos_ax');
    expect(event.kind).toBe('AXValueChanged');
    expect(event.payload['text']).toBe('Feishu AXValueChanged');
  });

  it('yields events for the bundles it was asked to watch', async () => {
    const c = start();
    const perceiver = new AxPerceiver(c, { bundleIds: ['com.feishu.app'], notifications: ['AXValueChanged'] });
    const controller = new AbortController();
    const seen: string[] = [];
    const consume = (async () => {
      for await (const event of perceiver.events(controller.signal)) {
        seen.push(event.kind);
        controller.abort();
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 120));
    controller.abort();
    await consume;
    expect(seen).toEqual(['AXValueChanged']);
    client = undefined;
    await perceiver.close();
  });
});
