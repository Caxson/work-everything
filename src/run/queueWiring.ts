/**
 * Assembling the queue that holds work while the screen cannot be driven.
 *
 * Pulled out of `feishuRuntime.ts` because the assembly *is* the policy, and a
 * policy that only exists inside a function which needs a real Mac to call is a
 * policy nothing can check. Everything a screen touches arrives here as a
 * function — `screen`, `openConversation` — so the whole mechanism can be built
 * and driven without one.
 *
 * The single-source rule lives here in one visible place. Every channel into
 * the sensor carries the helper's own answer and nothing else: the `env` poll,
 * the bridge's refusal codes, and the health monitor's verdicts. Which of them
 * names which blocker is a table rather than a chain of `if`s, so a state the
 * helper learns to tell apart is wired by adding a row.
 */
import type { Db } from '../memory/db.js';
import type { TrajectoryStore } from '../memory/trajectory.js';
import { DeferredStore } from '../memory/deferred.js';
import type { DeferredAction } from '../queue/deferred.js';
import type { Config } from '../config.js';
import type { Executor, ToolRunner } from '../execution/base.js';
import { screenBoundTools } from '../execution/base.js';
import type { ActionError, ActionErrorCode } from '../actions/errors.js';
import type { FeishuHealth, FeishuHealthState } from '../perception/feishu/health.js';
import type { ChatRouteTable } from '../perception/feishu/chatRoutes.js';
import type { AxScreenState } from '../perception/macos/axProtocol.js';
import type { OpenConversation } from '../execution/feishu/replyPremise.js';
import { FEISHU_REPLY_PREMISE, feishuReplyCapture, feishuReplyChecker } from '../execution/feishu/replyPremise.js';
import type { ScreenBlocker } from '../queue/screen.js';
import { ScreenSensor, describeBlock } from '../queue/screen.js';
import { QueueJournal } from '../queue/journal.js';
import { PreconditionRegistry } from '../queue/preconditions.js';
import { ActionGate } from '../queue/gate.js';
import { QueueDrainer } from '../queue/drain.js';

export interface ActionQueueDeps {
  readonly db: Db;
  /** Where queue transitions are recorded, and where origins are read back. */
  readonly store: TrajectoryStore;
  /** How a released chain is executed. The same runner the daemon uses. */
  readonly runner: ToolRunner;
  /** Consulted for which tools cannot run while the screen is unavailable. */
  readonly executors: readonly Executor[];
  readonly routes: ChatRouteTable;
  readonly config: Config;
  /** The bridge's lock reading. The only poll of the screen in the process,
   *  and the only blocker a poll can answer for. */
  readonly screen: () => Promise<AxScreenState>;
  /** The conversation currently readable, for re-checking a queued reply. */
  readonly openConversation: () => Promise<OpenConversation>;
  readonly log: (line: string) => void;
}

export interface ActionQueueParts {
  readonly sensor: ScreenSensor;
  readonly queue: DeferredStore;
  readonly gate: ActionGate;
  readonly drainer: QueueDrainer;
  readonly preconditions: PreconditionRegistry;
  /**
   * Every `ActionError` a driver throws. Only the codes in `REFUSAL_BLOCKERS`
   * change anything, and they are the channel that closes the gap between a
   * machine state arriving and the next reading noticing it.
   */
  readonly noteActionError: (error: ActionError) => void;
  /**
   * Every health verdict about the watched application: the same helper
   * diagnoses one step earlier, the only channel that fires when the sender
   * refuses before touching a driver, and the only reading of the Space
   * anything on this side gets.
   */
  readonly noteHealth: (health: FeishuHealth) => void;
  /** Runs claimed by a process that did not survive to record what happened. */
  readonly interrupted: readonly DeferredAction[];
}

/** Bridge refusals that name a machine state, rather than a fault to retry. */
const REFUSAL_BLOCKERS: Readonly<Partial<Record<ActionErrorCode, ScreenBlocker>>> = {
  SCREEN_LOCKED: 'locked',
  FULLSCREEN_SPACE: 'fullscreen_space',
};

/** The same states, as the health monitor reports them. */
const HEALTH_BLOCKERS: Readonly<Partial<Record<FeishuHealthState, ScreenBlocker>>> = {
  screen_locked: 'locked',
  fullscreen_space: 'fullscreen_space',
};

/** The premise checkers this daemon knows how to re-verify. */
function knownPremises(deps: ActionQueueDeps): PreconditionRegistry {
  const preconditions = new PreconditionRegistry();
  preconditions.register(
    FEISHU_REPLY_PREMISE,
    feishuReplyChecker({
      // Read through a function: the allowlist is config, and a daemon that is
      // still running should not send to a chat that has just been removed.
      allowedChats: () => deps.config.feishu.allowedChats,
      routes: deps.routes,
      // The durable half of the target check. The route table is in-memory and
      // bounded, so after a restart the origin event's own trajectory is the
      // only surviving record of which conversation it came from.
      recordedChat: (traceId) => {
        const chat = deps.store.get(traceId)?.payload['chat'];
        return typeof chat === 'string' && chat !== '' ? chat : undefined;
      },
      openConversation: deps.openConversation,
    }),
  );
  return preconditions;
}

/**
 * Settle anything a previous process claimed and never finished, and say so.
 * Never replayed: the message may already have gone out.
 */
function recoverInterrupted(queue: DeferredStore, journal: QueueJournal, log: (line: string) => void): readonly DeferredAction[] {
  const interrupted = queue.recoverInterrupted();
  for (const action of interrupted) {
    journal.discarded(action, action.detail);
    log(`[queue] not replaying ${action.id}: ${action.detail}`);
  }
  return interrupted;
}

/**
 * Record a blocker, and say so once rather than once per reading: the health
 * monitor runs on the perceiver's poll interval, so a state that lasts a lunch
 * break would otherwise log the same line hundreds of times.
 */
function note(sensor: ScreenSensor, log: (line: string) => void, blocker: ScreenBlocker, detail: string, source: string): void {
  const before = sensor.current();
  if (sensor.note(blocker, detail) === before) return;
  log(`[queue] ${source}: ${describeBlock(sensor.current())}; nothing that needs a window will run until that changes`);
}

export function createActionQueue(deps: ActionQueueDeps): ActionQueueParts {
  const queue = new DeferredStore(deps.db);
  const sensor = new ScreenSensor({ probe: deps.screen });
  const journal = new QueueJournal(deps.store);
  const preconditions = knownPremises(deps);

  const drainer = new QueueDrainer({
    sensor,
    store: queue,
    journal,
    preconditions,
    runner: deps.runner,
    config: deps.config.queue,
    log: deps.log,
  });

  const gate = new ActionGate({
    sensor,
    store: queue,
    journal,
    screenBound: screenBoundTools(deps.executors),
    capture: feishuReplyCapture({ routes: deps.routes }),
    config: deps.config.queue,
    // While a drain is running, live work joins the back of the queue rather
    // than overtaking replies that have been waiting minutes for the screen.
    busy: () => drainer.draining,
    log: deps.log,
  });

  return {
    sensor,
    queue,
    gate,
    drainer,
    preconditions,
    interrupted: recoverInterrupted(queue, journal, deps.log),
    noteActionError: (error) => {
      const blocker = REFUSAL_BLOCKERS[error.code];
      if (blocker === undefined) return;
      note(sensor, deps.log, blocker, error.message, `the bridge refused an action with ${error.code}`);
    },
    noteHealth: (health) => {
      const blocker = HEALTH_BLOCKERS[health.state];
      if (blocker !== undefined) {
        note(sensor, deps.log, blocker, health.detail, 'the health monitor reports');
        return;
      }
      // A reading that found Feishu addressable is the only thing that can say
      // the full-screen Space has been left: `env` reports the lock and nothing
      // about Spaces, so the drainer's poll cannot answer this either way. Any
      // other verdict is not evidence — an application closed to the tray reads
      // the same on a full-screen Space as on an ordinary one — so the blocker
      // stays until a reading proves the screen is usable.
      if (health.state !== 'ok') return;
      const before = sensor.current();
      if (sensor.clear('fullscreen_space') !== before) {
        deps.log('[queue] the full-screen Space has been left; what is waiting can run again');
      }
    },
  };
}
