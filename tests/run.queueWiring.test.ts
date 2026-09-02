import { describe, expect, it } from 'vitest';
import { openDb } from '../src/memory/db.js';
import type { Db } from '../src/memory/db.js';
import { TrajectoryStore } from '../src/memory/trajectory.js';
import type { TrajectoryRecord } from '../src/memory/trajectory.js';
import { parseConfig } from '../src/config.js';
import type { Config } from '../src/config.js';
import { ActionError } from '../src/actions/errors.js';
import { ShellExecutor } from '../src/execution/shell.js';
import { ok as toolOk, type Executor, type ToolResult } from '../src/execution/base.js';
import { FEISHU_REPLY_CHAIN, FEISHU_REPLY_TOOL } from '../src/execution/feishu/sender.js';
import type { OpenConversation } from '../src/execution/feishu/replyPremise.js';
import { FEISHU_REPLY_PREMISE } from '../src/execution/feishu/replyPremise.js';
import { ChatRouteTable } from '../src/perception/feishu/chatRoutes.js';
import type { AxScreenState } from '../src/perception/macos/axProtocol.js';
import { createActionQueue, type ActionQueueParts } from '../src/run/queueWiring.js';

const CHAT = 'Ops';
const NOW = 1_700_000_000_000;

/** Claims the reply tool and records what it was asked to send. */
class RecordingReply implements Executor {
  readonly kind = 'feishu';
  readonly screenBound = true;
  readonly sent: Readonly<Record<string, string>>[] = [];

  supports(tool: string): boolean {
    return tool === FEISHU_REPLY_TOOL;
  }

  names(): readonly string[] {
    return [FEISHU_REPLY_TOOL];
  }

  async run(_tool: string, args: Readonly<Record<string, string>>): Promise<ToolResult> {
    this.sent.push(args);
    return toolOk({ sent: true }, 1);
  }
}

const originRecord = (traceId: string): TrajectoryRecord => ({
  traceId,
  ts: NOW,
  source: 'feishu',
  kind: 'message.received',
  text: 'we ping',
  payload: { text: 'we ping', chat: CHAT },
  tier: 'muscle',
  needsConfirmation: false,
  confirmed: null,
  score: 1,
  reason: 'matched',
  considered: [],
  llmCalls: 0,
  durationMs: 1,
  ok: true,
  steps: [],
});

interface Wired extends ActionQueueParts {
  readonly db: Db;
  readonly reply: RecordingReply;
  readonly store: TrajectoryStore;
  readonly routes: ChatRouteTable;
  readonly lines: string[];
  readonly setLocked: (value: boolean) => void;
  readonly setOpenChat: (title: string) => void;
}

function wire(over: { config?: Config; locked?: boolean; remember?: boolean } = {}): Wired {
  const db = openDb(':memory:');
  const store = new TrajectoryStore(db);
  const reply = new RecordingReply();
  const shell = new ShellExecutor([{ name: 'build', description: '', command: '/bin/echo', argv: [], params: [] }]);
  const routes = new ChatRouteTable();
  if (over.remember !== false) routes.remember('feishu-1', { chatTitle: CHAT, messageId: 'msg-1', ts: NOW });

  let locked = over.locked ?? true;
  let openChat = CHAT;
  const lines: string[] = [];
  const executors = [reply, shell];

  const parts = createActionQueue({
    db,
    store,
    runner: async (tool, args) => (tool === FEISHU_REPLY_TOOL ? await reply.run(tool, args) : toolOk('shelled', 1)),
    executors,
    routes,
    config: over.config ?? parseConfig({ feishu: { allowedChats: [CHAT] } }),
    screen: async (): Promise<AxScreenState> => ({ locked }),
    openConversation: async (): Promise<OpenConversation> => ({ title: openChat, messageIds: ['msg-1'] }),
    log: (line) => lines.push(line),
  });

  return {
    ...parts,
    db,
    reply,
    store,
    routes,
    lines,
    setLocked: (value) => {
      locked = value;
    },
    setOpenChat: (title) => {
      openChat = title;
    },
  };
}

const admit = (parts: ActionQueueParts, traceId = 'feishu-1'): ReturnType<ActionQueueParts['gate']['admit']> =>
  parts.gate.admit({ traceId, chain: FEISHU_REPLY_CHAIN, vars: { text: 'pong', trace_id: traceId } });

describe('the assembled action queue', () => {
  it('registers a checker for the reply premise, and nothing it was not given', () => {
    const w = wire();
    expect(w.preconditions.kinds).toEqual([FEISHU_REPLY_PREMISE]);
    expect(w.preconditions.knows('something.else')).toBe(false);
  });

  it('takes its screen-bound tool set from what the executors declare', async () => {
    const w = wire();
    await w.drainer.tick();
    expect(w.gate.needsScreen(FEISHU_REPLY_CHAIN)).toBe(true);
    // The shell executor declares nothing, so its tools run through a lock.
    const admission = await w.gate.admit({
      traceId: 'feishu-1',
      chain: { ...FEISHU_REPLY_CHAIN, chain: [{ tool: 'build', args: {}, extractTo: '', condition: 'always' }] },
      vars: {},
    });
    expect(admission.admitted).toBe(true);
  });

  it('learns the lock from the bridge poll before anything needs to know', async () => {
    const w = wire();
    expect(w.sensor.current().state).toBe('unknown');
    await w.drainer.tick();
    expect(w.sensor.blocked).toBe(true);
    expect(w.sensor.current().blockers[0]?.learnedFrom).toBe('poll');
  });

  it('learns it from a driver refusal too, and only from that code', () => {
    const w = wire({ locked: false });
    w.noteActionError(new ActionError('TREE_NOT_READY', 'not ready yet'));
    expect(w.sensor.blocked).toBe(false);

    w.noteActionError(new ActionError('SCREEN_LOCKED', 'the Mac is locked, so no window can be addressed'));
    expect(w.sensor.blocked).toBe(true);
    expect(w.sensor.current().blockers[0]?.learnedFrom).toBe('refusal');
    expect(w.lines.join(' ')).toContain('SCREEN_LOCKED');
  });

  it('queues a reply behind a lock and sends it after the unlock', async () => {
    const w = wire();
    await w.drainer.tick();

    const admission = await admit(w);
    expect(admission.admitted).toBe(false);
    expect(w.reply.sent).toEqual([]);
    expect(w.queue.pendingCount()).toBe(1);

    w.setLocked(false);
    const report = await w.drainer.tick();
    expect(report.executed).toHaveLength(1);
    expect(w.reply.sent.map((args) => args['text'])).toEqual(['pong']);
  });

  it('re-checks the target against the trajectory when the route table has forgotten', async () => {
    // A restart, modelled exactly: the in-memory routing is gone, and the
    // origin event's own record is all that is left to verify the target with.
    const w = wire({ remember: false });
    expect(w.routes.lookup('feishu-1')).toBeUndefined();
    w.store.append(originRecord('feishu-1'));

    const facts = { chat: CHAT, originTraceId: 'feishu-1', originMessageId: 'msg-1' };
    expect((await w.preconditions.check({ kind: FEISHU_REPLY_PREMISE, facts })).state).toBe('holds');

    // And it is a real check, not a rubber stamp: a target the record
    // disagrees with is refused through the same path.
    const wrong = { ...facts, chat: 'Someone Else' };
    expect((await w.preconditions.check({ kind: FEISHU_REPLY_PREMISE, facts: wrong })).state).toBe('broken');
  });

  it('refuses when neither the routing nor the trajectory knows the origin', async () => {
    const w = wire({ remember: false });
    const verdict = await w.preconditions.check({
      kind: FEISHU_REPLY_PREMISE,
      facts: { chat: CHAT, originTraceId: 'never-seen', originMessageId: '' },
    });
    expect(verdict.state).toBe('broken');
    expect(verdict.detail).toContain('can no longer be identified');
  });

  it('refuses a queued reply whose conversation has left the allowlist', async () => {
    const w = wire({ config: parseConfig({ feishu: { allowedChats: [] } }) });
    await w.drainer.tick();
    await admit(w);

    w.setLocked(false);
    const report = await w.drainer.tick();
    expect(w.reply.sent).toEqual([]);
    expect(report.discarded.map((action) => action.status)).toEqual(['precondition_broken']);
  });

  it('waits for the right conversation rather than sending into the wrong one', async () => {
    const w = wire();
    await w.drainer.tick();
    await admit(w);

    w.setLocked(false);
    w.setOpenChat('Somewhere Else');
    expect((await w.drainer.tick()).stoppedBecause).toContain('not the conversation on screen');
    expect(w.reply.sent).toEqual([]);
  });

  it('reads the allowlist afresh, so a config change reaches an action already queued', async () => {
    const config = parseConfig({ feishu: { allowedChats: [CHAT] } });
    const w = wire({ config });
    await w.drainer.tick();
    await admit(w);

    // The same object the daemon holds; the checker must not have copied it.
    const verdict = await w.preconditions.check({
      kind: FEISHU_REPLY_PREMISE,
      facts: { chat: 'Never Allowed', originTraceId: 'feishu-1', originMessageId: 'msg-1' },
    });
    expect(verdict.state).toBe('broken');
    expect(verdict.detail).toContain('feishu.allowedChats');
  });

  it('hears a lock the sender found, which never reaches the action layer at all', () => {
    // The sender consults health before it touches a driver, so a locked screen
    // found there produces no ActionError. Without this channel the whole
    // refusal path would be dead code in the assembled daemon.
    const w = wire({ locked: false });
    w.noteHealth({ state: 'no_window', pid: 1, detail: 'closed to the tray' });
    expect(w.sensor.blocked).toBe(false);

    w.noteHealth({ state: 'screen_locked', pid: 1, detail: 'the screen is locked, so no window can be addressed' });
    expect(w.sensor.blocked).toBe(true);
    expect(w.sensor.current().blockers[0]?.learnedFrom).toBe('refusal');
    expect(w.lines.join(' ')).toContain('the screen is locked');
  });

  it('does not condemn a chain that names its own conversation', async () => {
    // An ops-channel chain was never answering a sender, so comparing it
    // against the event's origin would drop it every time it was queued —
    // a policy that differed between a locked screen and an open one.
    const w = wire();
    await w.drainer.tick();
    const named = {
      ...FEISHU_REPLY_CHAIN,
      chain: [{ tool: FEISHU_REPLY_TOOL, args: { text: '$text', chat: CHAT }, extractTo: '', condition: 'always' }],
    };
    const admission = await w.gate.admit({ traceId: 'unrelated-event', chain: named, vars: { text: 'nightly build is green' } });
    expect(admission.admitted).toBe(false);

    w.setLocked(false);
    const report = await w.drainer.tick();
    expect(report.executed).toHaveLength(1);
    expect(w.reply.sent.map((args) => args['text'])).toEqual(['nightly build is green']);
  });

  it('reports nothing interrupted on a clean start', () => {
    expect(wire().interrupted).toEqual([]);
  });

  it('settles a run a previous process left claimed, and never replays it', async () => {
    const w = wire();
    await w.drainer.tick();
    await admit(w);
    const [queued] = w.queue.pending();
    w.queue.claim(queued as NonNullable<typeof queued>, Date.now());

    // A second assembly over the same database, as a restart would be.
    const restarted = createActionQueue({
      db: w.db,
      store: w.store,
      runner: async () => toolOk('', 1),
      executors: [],
      routes: w.routes,
      config: parseConfig({ feishu: { allowedChats: [CHAT] } }),
      screen: async () => ({ locked: false }),
      openConversation: async () => ({ title: CHAT, messageIds: ['msg-1'] }),
      log: () => undefined,
    });

    expect(restarted.interrupted.map((action) => action.status)).toEqual(['failed']);
    expect(restarted.queue.pending()).toEqual([]);
    expect(w.reply.sent).toEqual([]);
  });
});

describe('a full-screen Space, in the assembled queue', () => {
  // MEASURED: with Chrome full-screen, 飞书 exposed 0 accessibility windows
  // against 6 known to the window server; activating it gave 1 addressable
  // window; going back to Chrome took it away again. The Mac is unlocked and
  // working throughout, so `env` says nothing about it and the queue hears it
  // only through a reading of the application.

  const held = 'the active Space belongs to a full-screen application (Google Chrome), and macOS composites no window on another Space';

  it('holds a reply while the Space is in force, and sends it once the Space is left', async () => {
    const w = wire({ locked: false });
    await w.drainer.tick();
    expect(w.gate.screenIsUnavailable()).toBe(false);

    w.noteHealth({ state: 'fullscreen_space', pid: 68285, detail: held });
    expect(w.gate.screenIsUnavailable()).toBe(true);

    const admission = await admit(w);
    expect(admission.admitted).toBe(false);
    if (admission.admitted) return;
    expect(admission.reason).toContain('a full-screen application owns the active Space');
    expect(w.reply.sent).toEqual([]);

    // The poll says the screen is unlocked on every pass, and that is not an
    // answer about the Space: the queue must not drain on it.
    const heldStill = await w.drainer.tick();
    expect(heldStill.executed).toEqual([]);
    expect(heldStill.stoppedBecause).toContain('a full-screen application owns the active Space');
    expect(w.queue.pendingCount()).toBe(1);

    // A reading that found Feishu addressable is what says the Space was left.
    w.noteHealth({ state: 'ok', pid: 68285, detail: 'window visible, conversation open' });
    const drained = await w.drainer.tick();
    expect(drained.executed.map((action) => action.status)).toEqual(['executed']);
    expect(w.reply.sent.map((args) => args['trace_id'])).toEqual(['feishu-1']);
    expect(w.lines.join(' ')).toContain('the full-screen Space has been left');
  });

  it('says it once over a long wait, and keeps what is queued queued', async () => {
    // The health monitor runs on the perceiver's poll interval — 3s — and a
    // person can be in full screen for hours. The state is noticed once, said
    // once, and nothing is attempted again until a reading says it is over.
    const w = wire({ locked: false });
    await w.drainer.tick();
    const before = w.lines.length;

    for (let poll = 0; poll < 200; poll += 1) w.noteHealth({ state: 'fullscreen_space', pid: 68285, detail: held });
    await admit(w);
    for (let poll = 0; poll < 200; poll += 1) w.noteHealth({ state: 'fullscreen_space', pid: 68285, detail: held });
    await w.drainer.tick();
    await w.drainer.tick();

    const said = w.lines.slice(before).filter((line) => line.includes('a full-screen application owns the active Space'));
    expect(said).toHaveLength(1);
    expect(w.queue.pendingCount()).toBe(1);
    expect(w.reply.sent).toEqual([]);

    // And the other side of it: the change back is said once too.
    w.noteHealth({ state: 'ok', pid: 68285, detail: 'window visible, conversation open' });
    w.noteHealth({ state: 'ok', pid: 68285, detail: 'window visible, conversation open' });
    expect(w.lines.filter((line) => line.includes('the full-screen Space has been left'))).toHaveLength(1);
  });

  it('learns it from a driver refusal as well, with its own code', async () => {
    const w = wire({ locked: false });
    await w.drainer.tick();

    w.noteActionError(new ActionError('FULLSCREEN_SPACE', held));
    expect(w.sensor.blocked).toBe(true);
    expect(w.sensor.current().blockers[0]?.blocker).toBe('fullscreen_space');
    expect(w.lines.join(' ')).toContain('FULLSCREEN_SPACE');

    expect((await admit(w)).admitted).toBe(false);
  });

  it('is not lifted by a verdict that could not have looked at the Space', async () => {
    // Feishu closed to the tray reads the same on a full-screen Space as on an
    // ordinary one. Clearing on it would admit an action that cannot run.
    const w = wire({ locked: false });
    await w.drainer.tick();
    w.noteHealth({ state: 'fullscreen_space', pid: 68285, detail: held });

    w.noteHealth({ state: 'no_window', pid: 68285, detail: 'Feishu shows no window (closed to the tray)' });
    w.noteHealth({ state: 'not_drawn', pid: 68285, detail: 'Feishu has windows that are not being drawn' });
    w.noteHealth({ state: 'no_window', pid: -1, detail: 'Feishu is not running' });
    expect(w.sensor.blocked).toBe(true);
  });

  it('re-checks the premise on the way out, and holds a reply the Space outlived', async () => {
    const w = wire({ locked: false });
    await w.drainer.tick();
    w.noteHealth({ state: 'fullscreen_space', pid: 68285, detail: held });
    await admit(w);

    // The Space is left, but the person has moved to another conversation:
    // the reply is not sent into whatever happens to be on screen.
    w.setOpenChat('Someone Else');
    w.noteHealth({ state: 'ok', pid: 68285, detail: 'window visible, conversation open' });
    const blocked = await w.drainer.tick();
    expect(blocked.executed).toEqual([]);
    expect(blocked.stoppedBecause).toContain('not the conversation on screen');
    expect(w.reply.sent).toEqual([]);

    w.setOpenChat(CHAT);
    const drained = await w.drainer.tick();
    expect(drained.executed.map((action) => action.status)).toEqual(['executed']);
    expect(w.reply.sent.map((args) => args['text'])).toEqual(['pong']);
  });

  it('holds a lock and a Space independently, and needs both gone to drain', async () => {
    const w = wire();
    await w.drainer.tick();
    w.noteHealth({ state: 'fullscreen_space', pid: 68285, detail: held });
    await admit(w);
    expect(w.queue.pendingCount()).toBe(1);

    // Unlocking is not enough: the poll answers for the lock and nothing else.
    w.setLocked(false);
    expect((await w.drainer.tick()).executed).toEqual([]);
    expect(w.sensor.current().blockers.map((reading) => reading.blocker)).toEqual(['fullscreen_space']);

    w.noteHealth({ state: 'ok', pid: 68285, detail: 'window visible, conversation open' });
    expect((await w.drainer.tick()).executed.map((action) => action.status)).toEqual(['executed']);
  });
});
