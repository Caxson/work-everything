#!/usr/bin/env node
/**
 * End-to-end check of the Feishu loop against the real app.
 *
 * It plays the user: it types `we ping` into a conversation, waits for the
 * daemon to answer `pong <time>` off the muscle tier with no model call, then
 * asks a question that only slow thinking can answer and waits for that reply.
 * Every step writes its evidence — the AX read-back, the trajectory row, the
 * daemon's own log — into --out.
 *
 * Two things it refuses to do, because this drives someone's real chat client:
 *
 *   1. It will not run against a conversation that is not a chat with
 *      yourself. The proof is the composer placeholder, which Feishu writes as
 *      `可以向自己发送文件或转发消息` there and `发送给 <name>` everywhere else.
 *   2. It sends each message once. A step that does not confirm is reported as
 *      a failure; it is never retried into the conversation.
 *
 * Usage:
 *   node scripts/e2e-feishu.mjs --config <path> --chat "<title>" --out <dir>
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { loadConfig } from '../dist/config.js';
import { AxBridgeClient } from '../dist/perception/macos/axBridge.js';
import { FeishuReader } from '../dist/perception/feishu/reader.js';
import { ChatRouteTable } from '../dist/perception/feishu/chatRoutes.js';
import { SentLedger } from '../dist/perception/feishu/sentLedger.js';
import { FeishuExecutor, FEISHU_REPLY_TOOL } from '../dist/execution/feishu/sender.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PING = 'we ping';
const QUESTION = '用一句话告诉我今天是星期几';

const args = parseArgs(process.argv.slice(2));
const outDir = resolve(args.out ?? './e2e');
mkdirSync(outDir, { recursive: true });

const evidence = (name, body) => {
  const path = join(outDir, name);
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  return path;
};
const say = (line) => process.stdout.write(`${line}\n`);
const steps = [];
const step = (name, expected, actual, ok, proof) => {
  steps.push({ name, expected, actual, ok, proof });
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      expected: ${expected}\n      actual:   ${actual}\n      proof:    ${proof}`);
};

const config = loadConfig(args.config);
const chat = args.chat ?? config.feishu.allowedChats[0];
if (!chat) fatal('no --chat given and feishu.allowedChats is empty');

const client = new AxBridgeClient({ binaryPath: config.axBridge.binaryPath, requestTimeoutMs: config.axBridge.requestTimeoutMs });
const reader = new FeishuReader(client, {
  bundleId: config.feishu.bundleId,
  appPath: config.feishu.appPath,
  selfName: config.feishu.selfName,
  windowTimeoutMs: config.feishu.windowTimeoutMs,
});
const sender = new FeishuExecutor({
  client,
  reader,
  routes: new ChatRouteTable(),
  ledger: new SentLedger(),
  config: {
    allowedChats: [chat],
    dedupeWindowMs: 1,
    focusAttempts: 3,
    focusSettleMs: 600,
    typeSettleMs: 400,
    echoTimeoutMs: 6_000,
    echoIntervalMs: 400,
    maxTextLength: 2_000,
  },
});

let daemon;
try {
  await main();
} catch (error) {
  say(`\nABORTED: ${error.message}`);
  process.exitCode = 1;
} finally {
  daemon?.kill('SIGTERM');
  await client.stop();
  evidence('steps.json', steps);
  say(`\nevidence: ${outDir}`);
}

async function main() {
  // --- 0. safety gate ------------------------------------------------------
  client.start();
  if (!(await client.trusted())) fatal('the ax bridge has no accessibility permission');
  const window = await reader.ensureWindow();
  if (!window.ok) fatal(window.reason);

  const before = await reader.snapshot();
  evidence('00-snapshot-before.json', before);
  say(`Feishu pid ${window.pid}; conversation on screen: "${before.chatTitle}" (selfChat=${before.isSelfChat})`);
  if (before.chatTitle !== chat) fatal(`the open conversation is "${before.chatTitle}", not "${chat}" — open it and rerun`);
  if (!before.isSelfChat) fatal(`"${chat}" is not a chat with yourself; this harness refuses to message anyone else`);
  // Sending starts with Cmd+A, Delete. An unsent draft in the composer is
  // someone's words, and this harness will not be what erases them.
  if (!draftIsEmpty(before.composerText)) fatal(`the composer already contains a draft (${JSON.stringify(before.composerText)}); clear it and rerun`);
  step('0 safety gate', `self-chat "${chat}" open, composer empty`, `"${before.chatTitle}", selfChat=true, no draft`, true, '00-snapshot-before.json');

  // --- 1. start the daemon -------------------------------------------------
  const logPath = join(outDir, 'daemon.log');
  const logFile = createWriteStream(logPath);
  daemon = spawn(process.execPath, ['dist/cli.js', ...(args.config ? ['-c', args.config] : []), 'run', '--source', 'feishu'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  for (const stream of [daemon.stdout, daemon.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      log += chunk;
      logFile.write(chunk);
    });
  }
  const started = await waitFor(() => log.includes('[run] watching'), 30_000, 200);
  if (!started) fatal(`the daemon did not start; see ${logPath}\n${log}`);
  step('1 daemon up', "'we run --source feishu' watching", log.split('\n').find((line) => line.includes('[run] watching')), true, 'daemon.log');

  const db = new Database(config.dbPath, { readonly: true });

  // --- 2. muscle: `we ping` -> `pong <time>` -------------------------------
  await sendAsUser(PING, '02-ping-sent.json');
  const ping = await waitForTrajectory(db, PING, 45_000);
  evidence('03-ping-trajectory.json', ping);
  const pingOk = ping !== undefined && ping.tier === 'muscle' && ping.llm_calls === 0 && ping.ok === 1;
  step(
    '2 muscle tier',
    "tier=muscle, llm_calls=0, replies 'pong <ISO time>'",
    ping === undefined ? 'no trajectory recorded' : `tier=${ping.tier} llm_calls=${ping.llm_calls} ok=${ping.ok} steps=${ping.steps.map((s) => s.tool).join('>')}`,
    pingOk,
    '03-ping-trajectory.json',
  );

  const afterPing = await waitFor(async () => (await reader.snapshot()).messages.some((m) => /^pong \d{4}-/.test(m.text)), 20_000, 800);
  const pingChat = await reader.snapshot();
  evidence('04-messages-after-ping.json', pingChat.messages);
  step(
    '2b read back',
    "a 'pong <ISO time>' message in the conversation",
    afterPing ? pingChat.messages.filter((m) => m.text.startsWith('pong ')).map((m) => `${m.id} ${m.text}`).join(' | ') : 'no pong found',
    afterPing,
    '04-messages-after-ping.json',
  );

  // --- 3. slow: a question only reasoning can answer -----------------------
  await sendAsUser(QUESTION, '05-question-sent.json');
  const slow = await waitForTrajectory(db, QUESTION, 180_000);
  evidence('06-slow-trajectory.json', slow);
  const slowOk = slow !== undefined && slow.tier.includes('slow');
  step(
    '3 slow tier',
    'tier=slow via claude -p, reply delivered',
    slow === undefined ? 'no trajectory recorded' : `tier=${slow.tier} llm_calls=${slow.llm_calls} ok=${slow.ok} ${slow.duration_ms}ms`,
    slowOk,
    '06-slow-trajectory.json',
  );

  const afterSlow = await reader.snapshot();
  evidence('07-messages-after-slow.json', afterSlow.messages);

  // --- 4. replay -----------------------------------------------------------
  const ids = [ping?.trace_id, slow?.trace_id].filter(Boolean);
  let replay = '';
  for (const id of ids) replay += `$ we replay ${id}\n${await run(process.execPath, ['dist/cli.js', ...(args.config ? ['-c', args.config] : []), 'replay', id])}\n`;
  evidence('08-replay.txt', replay);
  step('4 replay', 'both trajectories printed', `${ids.length} trajectory/ies replayed`, ids.length === 2, '08-replay.txt');

  db.close();
  say(`\n${steps.filter((s) => s.ok).length}/${steps.length} steps passed`);
  if (steps.some((s) => !s.ok)) process.exitCode = 1;
}

/** Type a message as the user would. Sent once; a failure is not retried. */
async function sendAsUser(text, name) {
  const result = await sender.run(FEISHU_REPLY_TOOL, { text, chat });
  evidence(name, result);
  if (!result.ok) fatal(`could not put "${text}" in the conversation: ${result.error}`);
  say(`sent as user: ${text}`);
}

function waitForTrajectory(db, text, timeoutMs) {
  return poll(() => {
    const row = db.prepare('SELECT * FROM trajectories WHERE text = ? AND kind = ? ORDER BY ts DESC LIMIT 1').get(text, 'message');
    if (row === undefined) return undefined;
    row.steps = db.prepare('SELECT * FROM trajectory_steps WHERE trace_id = ? ORDER BY seq').all(row.trace_id);
    return row;
  }, timeoutMs, 500);
}

async function poll(probe, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() >= deadline) return undefined;
    await sleep(intervalMs);
  }
}

async function waitFor(probe, timeoutMs, intervalMs) {
  return (await poll(async () => (await probe()) || undefined, timeoutMs, intervalMs)) === true;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function run(command, argv) {
  return new Promise((done) => {
    const child = spawn(command, argv, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', () => done(out));
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[String(argv[i]).replace(/^--/, '')] = argv[i + 1];
  return out;
}

/** The composer reads back as its placeholder when nothing is typed. */
function draftIsEmpty(composerText) {
  const squashed = composerText.replace(/(?:\s|\u200B|\u200C|\u200D|\uFEFF)+/gu, '');
  return squashed === '' || squashed.startsWith('可以向自己发送文件或转发消息') || squashed.startsWith('发送给');
}

function fatal(message) {
  throw new Error(message);
}
