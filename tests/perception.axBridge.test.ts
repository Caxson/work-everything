import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AxBridgeClient, AxBridgeError, AxPerceiver, toEvent } from '../src/perception/macos/axBridge.js';

const helper = fileURLToPath(new URL('./fixtures/fakeAx.mjs', import.meta.url));
const spawnFake = () => spawn(process.execPath, [helper], { stdio: ['pipe', 'pipe', 'pipe'] });

let client: AxBridgeClient | undefined;

const start = (timeoutMs = 2000): AxBridgeClient => {
  client = new AxBridgeClient({ binaryPath: '/nonexistent/we-ax', requestTimeoutMs: timeoutMs, spawnFn: spawnFake });
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
