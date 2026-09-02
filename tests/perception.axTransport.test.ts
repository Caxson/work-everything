import { mkdtempSync, rmSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AxBridgeClient } from '../src/perception/macos/axBridge.js';
import type { AxBridgeError } from '../src/perception/macos/axBridge.js';
import { SocketTransport, SpawnTransport } from '../src/perception/macos/axTransport.js';
// @ts-expect-error -- a .mjs test fixture, deliberately untyped
import { startFakeAxServer } from './fixtures/fakeAxServer.mjs';

interface FakeServer {
  close: () => Promise<void>;
  accepted: () => number;
  live: () => number;
}

const dirs: string[] = [];
const servers: FakeServer[] = [];
const clients: AxBridgeClient[] = [];

function socketPath(name = 'we-ax.sock'): string {
  const dir = mkdtempSync(join(tmpdir(), 'we-ax-transport-'));
  dirs.push(dir);
  return join(dir, name);
}

async function serve(path: string, env: Record<string, string> = {}): Promise<FakeServer> {
  const server = (await startFakeAxServer(path, env)) as FakeServer;
  servers.push(server);
  return server;
}

function connectClient(path: string, requestTimeoutMs = 2_000): AxBridgeClient {
  const client = new AxBridgeClient({ binaryPath: '/nonexistent/we-ax', socketPath: path, requestTimeoutMs });
  clients.push(client);
  client.start();
  return client;
}

/** A socket that never connects, so an errno can be delivered on demand. */
function stubSocket(): Socket {
  return new Socket();
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ax bridge socket transport', () => {
  it('talks to a resident service instead of spawning a helper', async () => {
    // binaryPath points at nothing. A client that fell back to spawning would throw
    // `binary_missing` here, which is the regression this asserts.
    const path = socketPath();
    const server = await serve(path);
    const client = connectClient(path);

    expect(client.running).toBe(true);
    expect(await client.trusted()).toBe(true);
    expect((await client.apps())[0]?.name).toBe('Feishu');
    expect((await client.tree(42, 3, 100)).children?.[0]?.value).toBe('hi');
    expect(server.accepted()).toBe(1);
  });

  it('reassembles a reply split across two writes, and keeps reading past a bad line', async () => {
    const path = socketPath();
    await serve(path);
    const client = connectClient(path);
    await expect(client.request('split' as never)).resolves.toEqual({ split: true });
    await expect(client.request('malformed' as never)).resolves.toEqual({ fine: true });
  });

  it('delivers unsolicited events to the client that subscribed', async () => {
    const path = socketPath();
    await serve(path);
    const client = connectClient(path);
    const seen: unknown[] = [];
    client.onNotification((notification) => seen.push(notification));
    expect(await client.observe(42, ['AXValueChanged'])).toBe(7);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(seen).toEqual([{ event: 'ax', subscription: 7, notification: 'AXValueChanged', nodeId: 11, pid: 42 }]);
  });

  it('leaves the service running when one client stops', async () => {
    // The whole reason the service is worth having: the Accessibility grant it holds is
    // shared, so a client going away must never be able to take it down.
    const path = socketPath();
    const server = await serve(path);
    const first = connectClient(path);
    expect(await first.trusted()).toBe(true);
    await first.stop();
    expect(first.running).toBe(false);

    const second = connectClient(path);
    expect(await second.trusted()).toBe(true);
    expect(server.accepted()).toBe(2);
  });

  it('serves two clients at once', async () => {
    const path = socketPath();
    const server = await serve(path);
    const a = connectClient(path);
    const b = connectClient(path);
    const [appsA, appsB] = await Promise.all([a.apps(), b.apps()]);
    expect(appsA).toEqual(appsB);
    expect(server.live()).toBe(2);
  });

  it('fails requests in flight when the service drops the connection', async () => {
    const path = socketPath();
    await serve(path);
    const client = connectClient(path);
    // `bye` makes the fixture destroy this connection without answering.
    await expect(client.request('bye' as never)).rejects.toMatchObject({ code: 'bridge_exited' });
    expect(client.running).toBe(false);
    await expect(client.request('trusted')).rejects.toMatchObject({ code: 'not_running' });
  });

  it('names the installer when nothing is listening', async () => {
    const path = socketPath('absent.sock');
    const client = connectClient(path);
    // ENOENT is the state somebody is actually in — the service was never installed — and
    // the errno alone sends them looking at accessibility instead.
    const failure = (await client.request('trusted').catch((error: AxBridgeError) => error)) as AxBridgeError;
    expect(failure.code).toBe('service_unavailable');
    expect(failure.message).toMatch(/install-service\.sh/);
    expect(failure.message).toMatch(/axBridge\.socketPath/);
    // The channel is gone, so the next request is refused locally rather than hanging.
    expect(client.running).toBe(false);
    await expect(client.request('trusted')).rejects.toMatchObject({ code: 'not_running' });
  });
});

describe('socket transport errno reporting', () => {
  const explain = async (code: string): Promise<AxBridgeError> => {
    const socket = stubSocket();
    const client = new AxBridgeClient({
      binaryPath: '/nonexistent/we-ax',
      socketPath: '/tmp/we-ax-unreachable.sock',
      requestTimeoutMs: 500,
      connectFn: () => socket,
    });
    clients.push(client);
    client.start();
    const pending = client.request('trusted');
    const error = Object.assign(new Error(`${code} test`), { code });
    socket.emit('error', error);
    return (await pending.catch((failure: AxBridgeError) => failure)) as AxBridgeError;
  };

  it('tells a stale socket from a missing one, because the remedies differ', async () => {
    const stale = await explain('ECONNREFUSED');
    expect(stale.code).toBe('service_unavailable');
    expect(stale.message).toMatch(/launchctl kickstart/);
    expect(stale.message).not.toMatch(/install-service\.sh/);
  });

  it('reports a permission failure as one, not as a missing service', async () => {
    const denied = await explain('EACCES');
    expect(denied.code).toBe('service_unavailable');
    expect(denied.message).toMatch(/not allowed to open/);
  });

  it('passes an unrecognised socket fault through rather than guessing', async () => {
    const other = await explain('EPIPE');
    expect(other.code).toBe('socket_failed');
    expect(other.message).toMatch(/EPIPE test/);
  });
});

describe('transports before and after their channel exists', () => {
  it('refuses a write on a socket transport that was never started', async () => {
    const transport = new SocketTransport({ socketPath: '/tmp/we-ax-never.sock' });
    const errors: string[] = [];
    transport.write('{}\n', (error) => errors.push(error.code));
    expect(errors).toEqual(['not_running']);
    await expect(transport.stop()).resolves.toBeUndefined();
  });

  it('refuses a write on a spawn transport that was never started', async () => {
    const transport = new SpawnTransport({ binaryPath: '/nonexistent/we-ax' });
    const errors: string[] = [];
    transport.write('{}\n', (error) => errors.push(error.code));
    expect(errors).toEqual(['not_running']);
    await expect(transport.stop()).resolves.toBeUndefined();
  });

  it('still reports a missing binary when no socket is configured', () => {
    const client = new AxBridgeClient({ binaryPath: '/nonexistent/we-ax', requestTimeoutMs: 100 });
    expect(() => client.start()).toThrow(/native\/ax-bridge/);
    expect(client.running).toBe(false);
  });

  it('treats an empty socketPath as "no socket", not as a path', () => {
    // A config key present and blank is a config key somebody meant to fill in. Connecting
    // to '' would fail with an errno nobody can read; falling back says what is wrong.
    const client = new AxBridgeClient({ binaryPath: '/nonexistent/we-ax', socketPath: '', requestTimeoutMs: 100 });
    expect(() => client.start()).toThrow(/binary not found/);
  });
});
