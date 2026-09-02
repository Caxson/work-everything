/**
 * The two ways to reach a `we-ax` helper. Both carry the same NDJSON protocol; they
 * differ only in who owns the process at the other end, and that difference is the
 * whole point.
 *
 * **Spawn** starts a helper as a child. Simple, self-contained, and subject to a macOS
 * rule that makes it unusable for an agent: an Accessibility grant is attributed to the
 * *responsible process*, which for a child is whoever launched it. So the same binary
 * answers `trusted: true` when a terminal spawns it and `trusted: false` when the daemon
 * does, and granting the binary in System Settings changes neither — the grant being
 * consulted was never its own.
 *
 * **Socket** connects to a resident helper installed as a launchd agent, which is
 * responsible for itself. It is granted once, by hand, and every client that connects
 * borrows that grant. Nothing here can create the grant: TCC is deliberately not
 * programmable, and a transport that pretended otherwise would be lying about the one
 * thing a caller needs to know.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { createLineDecoder } from './axProtocol.js';

/** Where the install script puts the launchd job. Quoted in the "it is not running" message. */
export const AX_SERVICE_LABEL = 'com.work-everything.ax-bridge';
export const AX_SERVICE_INSTALLER = 'native/ax-bridge/scripts/install-service.sh';

export class AxTransportError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AxTransportError';
  }
}

export interface AxTransportHandlers {
  /** One complete NDJSON line, newline already stripped. */
  readonly onLine: (line: string) => void;
  /** The channel is gone. Every request still in flight has to be failed with this. */
  readonly onFail: (error: AxTransportError) => void;
}

export interface AxTransport {
  /** Opens the channel. Throws only for a fault visible before any I/O. */
  start(handlers: AxTransportHandlers): void;
  /** Writes one already-framed line. Delivery failures arrive through `onError`. */
  write(line: string, onError: (error: AxTransportError) => void): void;
  stop(): Promise<void>;
}

/** How long to wait for a stopped helper to actually be gone before killing it. */
const TERMINATE_GRACE_MS = 1_000;

export interface SpawnTransportConfig {
  readonly binaryPath: string;
  /** Injectable so tests can drive a stand-in helper over real pipes. */
  readonly spawnFn?: ((binaryPath: string) => ChildProcessWithoutNullStreams) | undefined;
}

/** A helper owned by this process, speaking over its stdin and stdout. */
export class SpawnTransport implements AxTransport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stderrTail = '';

  constructor(private readonly config: SpawnTransportConfig) {}

  start(handlers: AxTransportHandlers): void {
    // A missing binary is the common case on a fresh checkout, so it gets its own
    // message rather than an ENOENT from spawn.
    if (this.config.spawnFn === undefined && !existsSync(this.config.binaryPath)) {
      throw new AxTransportError(
        `ax bridge binary not found at ${this.config.binaryPath}. Build it from native/ax-bridge, or set axBridge.binaryPath in the config.`,
        'binary_missing',
      );
    }

    const child = this.config.spawnFn?.(this.config.binaryPath) ?? spawn(this.config.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;

    const decode = createLineDecoder();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      for (const line of decode(chunk)) handlers.onLine(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-2000);
    });
    child.on('error', (error) => handlers.onFail(new AxTransportError(`ax bridge failed to start: ${error.message}`, 'spawn_failed')));
    child.on('close', (code) => {
      this.child = undefined;
      const detail = this.stderrTail.trim().split('\n').slice(-1)[0] ?? '';
      handlers.onFail(new AxTransportError(`ax bridge exited (${code ?? -1})${detail === '' ? '' : `: ${detail}`}`, 'bridge_exited'));
    });
  }

  write(line: string, onError: (error: AxTransportError) => void): void {
    const child = this.child;
    if (child === undefined) {
      onError(new AxTransportError('ax bridge is not running', 'not_running'));
      return;
    }
    child.stdin.write(line, (error) => {
      if (error) onError(new AxTransportError(`write failed: ${error.message}`, 'write_failed'));
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child === undefined) return;
    await new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, TERMINATE_GRACE_MS).unref?.();
    });
  }
}

export interface SocketTransportConfig {
  readonly socketPath: string;
  /** Injectable so tests can point at a socket they control. */
  readonly connectFn?: ((socketPath: string) => Socket) | undefined;
}

/**
 * A resident helper reached over a unix domain socket.
 *
 * `start` is synchronous while the connect is not: node queues writes made before the
 * connection lands, so a request issued immediately after `start` is sent as soon as
 * there is somewhere to send it. A connect that never lands surfaces through `onFail`
 * with the same shape as a channel that died later, because to a caller holding a
 * pending request they are the same event.
 */
export class SocketTransport implements AxTransport {
  private socket: Socket | undefined;

  constructor(private readonly config: SocketTransportConfig) {}

  start(handlers: AxTransportHandlers): void {
    const socket = this.config.connectFn?.(this.config.socketPath) ?? connect(this.config.socketPath);
    this.socket = socket;

    const decode = createLineDecoder();
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      for (const line of decode(chunk)) handlers.onLine(line);
    });
    socket.on('error', (error) => {
      const explained = this.explain(error);
      this.socket = undefined;
      handlers.onFail(explained);
    });
    socket.on('close', () => {
      // A close this side asked for, and the close that follows every error, have both
      // already cleared `socket`. What is left is the service going away underneath a
      // caller that may still be waiting, which is the only case worth reporting here —
      // and worth reporting differently, because there is nothing wrong with the config.
      if (this.socket === undefined) return;
      this.socket = undefined;
      handlers.onFail(new AxTransportError(`the we-ax service at ${this.config.socketPath} closed the connection`, 'bridge_exited'));
    });
  }

  write(line: string, onError: (error: AxTransportError) => void): void {
    const socket = this.socket;
    if (socket === undefined) {
      onError(new AxTransportError('ax bridge is not running', 'not_running'));
      return;
    }
    socket.write(line, (error) => {
      if (error) onError(new AxTransportError(`write failed: ${error.message}`, 'write_failed'));
    });
  }

  async stop(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (socket === undefined) return;
    // End the connection, never the service: it is shared, and other clients — and the
    // Accessibility grant it holds — have nothing to do with this one going away.
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.end();
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, TERMINATE_GRACE_MS).unref?.();
    });
  }

  /**
   * Turns a connect failure into the sentence that names the remedy.
   *
   * The two failures a person actually hits are indistinguishable from the errno alone:
   * the service was never installed, and the service is installed but not running (its
   * socket file outlives it). Both arrive here as a bare `ENOENT`/`ECONNREFUSED` from a
   * path nobody recognises, which is how "the daemon cannot see any windows" gets
   * diagnosed as an accessibility problem for an hour.
   */
  private explain(error: NodeJS.ErrnoException): AxTransportError {
    const path = this.config.socketPath;
    if (error.code === 'ENOENT') {
      return new AxTransportError(
        `no we-ax service is listening at ${path}. Install it with \`bash ${AX_SERVICE_INSTALLER}\` (it also prints the one-time Accessibility grant instructions), or drop axBridge.socketPath from the config to spawn a helper instead.`,
        'service_unavailable',
      );
    }
    if (error.code === 'ECONNREFUSED') {
      return new AxTransportError(
        `the we-ax socket at ${path} exists but nothing is serving it — the service is installed and stopped. Start it with \`launchctl kickstart -k gui/$(id -u)/${AX_SERVICE_LABEL}\`.`,
        'service_unavailable',
      );
    }
    if (error.code === 'EACCES') {
      return new AxTransportError(`not allowed to open the we-ax socket at ${path} (${error.code}); it is owned by the user the service runs as.`, 'service_unavailable');
    }
    return new AxTransportError(`ax bridge socket error at ${path}: ${error.message}`, 'socket_failed');
  }
}
