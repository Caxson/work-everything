/**
 * Assembling the locked-screen queue.
 *
 * Pulled out of `feishuRuntime.ts` because the assembly *is* the policy, and a
 * policy that only exists inside a function which needs a real Mac to call is a
 * policy nothing can check. Everything a screen touches arrives here as a
 * function — `screen`, `openConversation` — so the whole mechanism can be built
 * and driven without one.
 *
 * The single-source rule lives here in one visible place: `sensor` is
 * constructed with the bridge's poll, and `noteActionError` is the only other
 * thing that may move it, from the bridge's own refusal code. Nothing in this
 * file, or downstream of it, reads a lock state any other way.
 */
import type { Db } from '../memory/db.js';
import type { TrajectoryStore } from '../memory/trajectory.js';
import { DeferredStore } from '../memory/deferred.js';
import type { DeferredAction } from '../queue/deferred.js';
import type { Config } from '../config.js';
import type { Executor, ToolRunner } from '../execution/base.js';
import { screenBoundTools } from '../execution/base.js';
import type { ActionError } from '../actions/errors.js';
import type { FeishuHealth } from '../perception/feishu/health.js';
import type { ChatRouteTable } from '../perception/feishu/chatRoutes.js';
import type { AxScreenState } from '../perception/macos/axProtocol.js';
import type { OpenConversation } from '../execution/feishu/replyPremise.js';
import { FEISHU_REPLY_PREMISE, feishuReplyCapture, feishuReplyChecker } from '../execution/feishu/replyPremise.js';
import { ScreenLockSensor } from '../queue/screenLock.js';
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
  /** Consulted for which tools cannot run behind a lock. */
  readonly executors: readonly Executor[];
  readonly routes: ChatRouteTable;
  readonly config: Config;
  /** The bridge's lock reading. The only poll of the screen in the process. */
  readonly screen: () => Promise<AxScreenState>;
  /** The conversation currently readable, for re-checking a queued reply. */
  readonly openConversation: () => Promise<OpenConversation>;
  readonly log: (line: string) => void;
}

export interface ActionQueueParts {
  readonly sensor: ScreenLockSensor;
  readonly queue: DeferredStore;
  readonly gate: ActionGate;
  readonly drainer: QueueDrainer;
  readonly preconditions: PreconditionRegistry;
  /**
   * Every `ActionError` a driver throws. Only `SCREEN_LOCKED` changes anything,
   * and it is the second of the two channels the sensor listens on — the one
   * that closes the gap between a lock happening and the next poll noticing.
   */
  readonly noteActionError: (error: ActionError) => void;
  /**
   * Every health verdict about the watched application. `screen_locked` is the
   * third way the same helper diagnosis reaches the sensor, and the only one
   * that fires when the sender refuses before touching a driver.
   */
  readonly noteHealth: (health: FeishuHealth) => void;
  /** Runs claimed by a process that did not survive to record what happened. */
  readonly interrupted: readonly DeferredAction[];
}

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

export function createActionQueue(deps: ActionQueueDeps): ActionQueueParts {
  const queue = new DeferredStore(deps.db);
  const sensor = new ScreenLockSensor({ probe: deps.screen });
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
      if (error.code !== 'SCREEN_LOCKED') return;
      sensor.noteLocked(error.message);
      deps.log('[queue] the bridge refused an action with SCREEN_LOCKED; the screen is locked');
    },
    noteHealth: (health) => {
      if (health.state !== 'screen_locked') return;
      sensor.noteLocked(health.detail);
      deps.log('[queue] the screen is locked, so nothing that needs a window will run until it is unlocked');
    },
  };
}
