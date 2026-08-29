/**
 * Is Feishu readable right now?
 *
 * Three states, because "the tree is empty" has three different causes and
 * they call for three different responses:
 *
 * | state | what it means | what the caller does |
 * |---|---|---|
 * | `ok` | a real window, with web content in it | read |
 * | `no_window` | nothing to read, and there is a reason | skip this sweep, try later |
 * | `wedged` | the app is up but its accessibility layer is not | **stop and tell a human** |
 *
 * The distinction that matters is the last one. A tray'd app and a locked
 * screen both report zero `AXWindows`, and so does an app whose accessibility
 * layer has died — the three are indistinguishable from a single reading. So
 * this file does not diagnose from a single reading: it asks the app to show
 * a window, counts how many times in a row that has failed to change
 * anything, and only then calls it wedged. Guessing "wedged" too eagerly is
 * how you end up restarting somebody's chat client for no reason.
 *
 * `wedged` is terminal on purpose. Retrying against a wedged accessibility
 * layer never recovers it; only a human restarting the app does.
 */
import type { AxNode } from '../macos/axProtocol.js';
import { MODAL_WINDOW_PREFIX, ROLE, WEB_AREA } from './selectors.js';

export const FEISHU_HEALTH_STATES = ['ok', 'no_window', 'wedged'] as const;
export type FeishuHealthState = (typeof FEISHU_HEALTH_STATES)[number];

export interface FeishuHealth {
  readonly state: FeishuHealthState;
  readonly pid: number;
  /** One line, safe to show a user, saying what to do about it. */
  readonly detail: string;
}

/** One reading of the app, with the context needed to interpret it. */
export interface HealthObservation {
  readonly pid: number;
  /** What the `windows` op returned. The helper falls back to the
   *  application element when `AXWindows` is empty, so a role that is not
   *  `AXWindow` means "no window", not "a strange window". */
  readonly windows: readonly Pick<AxNode, 'role' | 'title'>[];
  /** Titles of every `AXWebArea` found. A CEF app with a window always has at
   *  least one; zero is the signature of a dead accessibility layer. */
  readonly webAreaTitles: readonly string[];
  readonly screenLocked: boolean;
  /** How many consecutive prior readings failed, before this one. */
  readonly failures: number;
}

export interface FeishuHealthConfig {
  /** Consecutive failed readings before an unexplained one becomes `wedged`. */
  readonly wedgedAfter: number;
}

export const DEFAULT_FEISHU_HEALTH_CONFIG: FeishuHealthConfig = { wedgedAfter: 3 };

export class FeishuHealthError extends Error {
  constructor(readonly health: FeishuHealth) {
    super(health.detail);
    this.name = 'FeishuHealthError';
  }
}

/** Real, non-modal application windows in a reading. */
export function realWindows(windows: HealthObservation['windows']): HealthObservation['windows'] {
  return windows.filter((window) => window.role === ROLE.window && !(window.title ?? '').startsWith(MODAL_WINDOW_PREFIX));
}

/** The verdict for one reading. Pure: every input it needs is in `observation`. */
export function classifyHealth(observation: HealthObservation, config: FeishuHealthConfig = DEFAULT_FEISHU_HEALTH_CONFIG): FeishuHealth {
  const { pid } = observation;
  const windows = realWindows(observation.windows);
  const exhausted = observation.failures >= config.wedgedAfter;

  if (windows.length === 0) {
    // A locked screen explains this completely, and no number of retries
    // changes it, so it never escalates.
    if (observation.screenLocked) {
      return { state: 'no_window', pid, detail: 'the screen is locked, so Feishu exposes no window; unlock it and this resolves itself' };
    }
    if (!exhausted) {
      return { state: 'no_window', pid, detail: 'Feishu shows no window (closed to the tray); asked it to reopen' };
    }
    return {
      state: 'wedged',
      pid,
      detail:
        `Feishu (pid ${pid}) is running and the screen is unlocked, but it has exposed no AXWindow across ` +
        `${observation.failures + 1} readings and does not respond to being reopened. Its accessibility layer is wedged — restart Feishu.`,
    };
  }

  if (observation.webAreaTitles.length === 0) {
    if (!exhausted) {
      return { state: 'no_window', pid, detail: 'Feishu has a window but no web content is readable yet' };
    }
    return {
      state: 'wedged',
      pid,
      detail:
        `Feishu (pid ${pid}) has a window but exposes no AXWebArea across ${observation.failures + 1} readings. ` +
        'Its accessibility layer is wedged — restart Feishu.',
    };
  }

  const messenger = observation.webAreaTitles.includes(WEB_AREA.openChat);
  return {
    state: 'ok',
    pid,
    detail: messenger
      ? `Feishu pid ${pid}: window visible, conversation open`
      : `Feishu pid ${pid}: window visible, but no conversation open (web areas: ${observation.webAreaTitles.join(', ')})`,
  };
}

/** What the monitor needs from the outside world. All injectable. */
export interface FeishuHealthDeps {
  /** Re-resolved on every check: a restart of Feishu changes its pid, and a
   *  cached one turns every later call into the same permanent failure. */
  readonly pid: () => Promise<number>;
  readonly windows: (pid: number) => Promise<readonly AxNode[]>;
  readonly webAreas: (pid: number) => Promise<readonly AxNode[]>;
  readonly screenLocked: () => Promise<boolean>;
  /** Ask the app to show its window. One attempt, not a loop. */
  readonly requestWindow: () => Promise<void>;
  readonly config?: FeishuHealthConfig;
}

/**
 * Runs the check and carries the only state a diagnosis needs: how many
 * readings in a row have failed.
 */
export class FeishuHealthMonitor {
  private failures = 0;
  private readonly config: FeishuHealthConfig;

  constructor(private readonly deps: FeishuHealthDeps) {
    this.config = deps.config ?? DEFAULT_FEISHU_HEALTH_CONFIG;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  async check(): Promise<FeishuHealth> {
    let pid: number;
    try {
      pid = await this.deps.pid();
    } catch (error) {
      this.failures += 1;
      return { state: 'no_window', pid: -1, detail: error instanceof Error ? error.message : String(error) };
    }

    const [windows, webAreas, screenLocked] = await Promise.all([
      this.deps.windows(pid),
      this.deps.webAreas(pid).catch(() => []),
      this.deps.screenLocked(),
    ]);

    const health = classifyHealth(
      {
        pid,
        windows: windows.map((window) => ({ role: window.role, title: window.title })),
        webAreaTitles: webAreas.map((area) => area.title ?? '').filter((title) => title !== ''),
        screenLocked,
        failures: this.failures,
      },
      this.config,
    );

    if (health.state === 'ok') {
      this.failures = 0;
      return health;
    }

    this.failures += 1;
    // Worth one nudge, but never while the screen is locked (it cannot work)
    // and never once the verdict is terminal.
    if (health.state === 'no_window' && !screenLocked && realWindows(windows).length === 0) {
      await this.deps.requestWindow().catch(() => undefined);
    }
    return health;
  }

  /** Throwing form, for the paths that must not continue on a wedged app. */
  async require(): Promise<FeishuHealth> {
    const health = await this.check();
    if (health.state === 'wedged') throw new FeishuHealthError(health);
    return health;
  }
}
