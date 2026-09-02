// The stand-in helper as a resident service: one unix socket, many clients, the same
// answers `fakeAx.mjs` gives over stdio.
//
// It exists to test the property that makes the real service worth having — a client
// leaving takes its own connection and nothing else — which cannot be observed at all
// against a helper that is one process per caller.
import { createServer } from 'node:net';
import { handleRequest } from './fakeAxOps.mjs';

/**
 * @param {string} socketPath
 * @param {Record<string, string>} env  overrides for the FAKE_* switches
 * @returns {Promise<{ close: () => Promise<void>, accepted: () => number, live: () => number }>}
 */
export function startFakeAxServer(socketPath, env = {}) {
  let accepted = 0;
  const sockets = new Set();

  const server = createServer((socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        if (line.trim() === '') continue;
        handleRequest(JSON.parse(line), {
          send: (obj) => socket.write(`${JSON.stringify(obj)}\n`),
          raw: (text) => socket.write(text),
          close: () => socket.destroy(),
          env: { ...process.env, ...env },
        });
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      resolve({
        accepted: () => accepted,
        live: () => sockets.size,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
