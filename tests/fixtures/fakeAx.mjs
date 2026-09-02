// A stand-in for the `we-ax` helper over stdio: same wire protocol, no accessibility.
// Used to exercise the client's framing, correlation and error paths.
//
// The behaviour lives in `fakeAxOps.mjs`, which the socket fixture uses too — one helper,
// two transports, exactly as the real bridge now works.
import { createInterface } from 'node:readline';
import { handleRequest } from './fakeAxOps.mjs';

createInterface({ input: process.stdin }).on('line', (line) => {
  handleRequest(JSON.parse(line), {
    send: (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`),
    raw: (text) => process.stdout.write(text),
    close: () => process.exit(0),
  });
});
