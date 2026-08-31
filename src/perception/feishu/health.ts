/**
 * Is Feishu readable right now?
 *
 * Six states, because "there is no window to read" has six different causes
 * and they call for six different responses. Getting this wrong is expensive
 * in both directions: a cause reported as a fault invites somebody to restart
 * a working application, and a fault reported as a wait is a daemon that
 * quietly does nothing forever.
 *
 * | state | what it means | what a person should do |
 * |---|---|---|
 * | `ok` | a real window with web content in it | nothing |
 * | `no_window` | closed to the tray, or only a modal is open | nothing; it resolves itself |
 * | `screen_locked` | the screen is locked | unlock it |
 * | `desktop_blank` | nothing on the machine is being drawn | wait for the screen saver to exit |
 * | `not_drawn` | Feishu's windows exist but none is on screen | bring it to a space that is drawing |
 * | `wedged` | the app is up, its accessibility layer is not | restart Feishu |
 *
 * The important change from the first version of this file: **it no longer
 * infers any of this from an empty array.** The helper classifies the cause —
 * it can see the window server's census and the session's lock state, neither
 * of which is visible from a count here — and this file turns that
 * classification into a state and a sentence. Two of those causes were found
 * by measurement rather than reasoning: a locked screen makes accessibility
 * substitute the application element for every window and report success the
 * whole way down, and a *running screen saver* takes accessibility windows
 * away from every application at once while the session stays unlocked, so
 * `CGSSessionScreenIsLocked` is false throughout and "unlock your Mac" is the
 * wrong thing to tell somebody.
 *
 * `wedged` stays terminal and stays hard to reach: only an app that has
 * windows the helper can address, and no web content in them, across several
 * readings, earns it. Every diagnosed cause is an explanation, and an
 * explained state never escalates.
 */
import type { AxNode, WindowDiagnosis } from '../macos/axProtocol.js';
import { MODAL_WINDOW_PREFIX, ROLE, WEB_AREA } from './selectors.js';

export const FEISHU_HEALTH_STATES = ['ok', 'no_window', 'screen_locked', 'desktop_blank', 'not_drawn', 'wedged'] as const;
export type FeishuHealthState = (typeof FEISHU_HEALTH_STATES)[number];

export interface FeishuHealth {
  readonly state: FeishuHealthState;
  readonly pid: number;
  /** One line, safe to show a user, saying what to do about it. */
  readonly detail: string;
}

/** States where trying again cannot help until something outside changes. */
export const FEISHU_STUCK_STATES: ReadonlySet<FeishuHealthState> = new Set<FeishuHealthState>([
  'screen_locked',
  'desktop_blank',
  'not_drawn',
  'wedged',
]);

/** One reading of the app, with the context needed to interpret it. */
export interface HealthObservation {
  readonly pid: number;
  /** The helper's classification of the window situation. Authoritative. */
  readonly diagnosis: WindowDiagnosis;
  /** The windows it returned, for the modal filter this app needs. */
  readonly windows: readonly Pick<AxNode, 'role' | 'title'>[];
  /** Titles of every `AXWebArea` found. Zero, with a window, is the wedge. */
  readonly webAreaTitles: readonly string[];
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

/**
 * The states the helper's own classification decides on its own. `undefined`
 * means it found addressable windows and the verdict is this file's to make.
 */
function fromDiagnosis(pid: number, diagnosis: WindowDiagnosis): FeishuHealth | undefined {
  switch (diagnosis.code) {
    case 'OK':
      return undefined;
    case 'SCREEN_LOCKED':
      return {
        state: 'screen_locked',
        pid,
        detail: 'the screen is locked, so no window can be addressed; unlock it and this resolves itself. Nothing is retried until then.',
      };
    case 'NO_WINDOW':
      return { state: 'no_window', pid, detail: `Feishu shows no window (closed to the tray, or a menu-bar-only state). ${census(diagnosis)}`.trim() };
    case 'AX_SEES_NO_WINDOWS_BUT_CG_DOES':
      return notDrawn(pid, diagnosis);
    default:
      // A cause the helper has learned to tell apart and this file has not.
      // Reported in its own words rather than guessed at.
      return { state: 'no_window', pid, detail: diagnosis.message ?? `Feishu exposes no window (${diagnosis.code})` };
  }
}

/**
 * Nothing is being drawn — but by whom. One application with no on-screen
 * window is that application's problem; a machine where only the frontmost
 * application is on screen is the desktop not compositing, which is what a
 * running screen saver does. Telling somebody to unlock a Mac that is not
 * locked is the failure this distinction exists to prevent.
 */
function notDrawn(pid: number, diagnosis: WindowDiagnosis): FeishuHealth {
  const details = diagnosis.details;
  if (details?.scope === 'desktop') {
    return {
      state: 'desktop_blank',
      pid,
      detail:
        'nothing on this machine is being drawn, so no application exposes a window — a running screen saver does exactly this with the session ' +
        `still unlocked. Wait for it to exit; the Mac is not locked and unlocking is not what is needed. ${census(diagnosis)}`.trim(),
    };
  }
  return {
    state: 'not_drawn',
    pid,
    detail: `Feishu has windows that are not being drawn (another space, or minimised); bring it to a space that is drawing. ${census(diagnosis)}`.trim(),
  };
}

/** The window-server counts behind a verdict, when the helper supplied them. */
function census(diagnosis: WindowDiagnosis): string {
  const details = diagnosis.details;
  if (details === undefined) return '';
  const parts: string[] = [];
  if (details.cgWindows !== undefined) parts.push(`${details.cgWindows} window(s) known to the window server, ${details.onScreen ?? 0} on screen`);
  if (details.desktopOnScreen !== undefined) {
    parts.push(`${details.desktopOnScreen} on screen machine-wide across ${details.desktopOwnersOnScreen ?? 0} process(es)`);
  }
  return parts.length === 0 ? '' : `(${parts.join('; ')})`;
}

/** The verdict for one reading. Pure: every input it needs is in `observation`. */
export function classifyHealth(observation: HealthObservation, config: FeishuHealthConfig = DEFAULT_FEISHU_HEALTH_CONFIG): FeishuHealth {
  const { pid } = observation;
  const diagnosed = fromDiagnosis(pid, observation.diagnosis);
  if (diagnosed !== undefined) return diagnosed;

  // The helper found windows it can address. Anything wrong from here is
  // Feishu's own accessibility layer, which is the one thing a person has to
  // act on — so it is also the only path that reaches `wedged`.
  const windows = realWindows(observation.windows);
  if (windows.length === 0) {
    return { state: 'no_window', pid, detail: 'Feishu has only a modal window open; the conversation is not readable behind it' };
  }

  if (observation.webAreaTitles.length === 0) {
    if (observation.failures < config.wedgedAfter) {
      return { state: 'no_window', pid, detail: 'Feishu has a window but no web content is readable yet' };
    }
    return {
      state: 'wedged',
      pid,
      detail:
        `Feishu (pid ${pid}) has a window the helper can address but exposes no AXWebArea across ${observation.failures + 1} readings. ` +
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
  /** The helper's classified window reading. */
  readonly windows: (pid: number) => Promise<{ readonly windows: readonly AxNode[]; readonly diagnosis: WindowDiagnosis }>;
  readonly webAreas: (pid: number) => Promise<readonly AxNode[]>;
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

    const [reading, webAreas] = await Promise.all([this.deps.windows(pid), this.deps.webAreas(pid).catch(() => [])]);

    const health = classifyHealth(
      {
        pid,
        diagnosis: reading.diagnosis,
        windows: reading.windows.map((window) => ({ role: window.role, title: window.title })),
        webAreaTitles: webAreas.map((area) => area.title ?? '').filter((title) => title !== ''),
        failures: this.failures,
      },
      this.config,
    );

    if (health.state === 'ok') {
      this.failures = 0;
      return health;
    }
    this.failures += 1;
    return health;
  }

  /** Throwing form, for the paths that must not continue on a wedged app. */
  async require(): Promise<FeishuHealth> {
    const health = await this.check();
    if (health.state === 'wedged') throw new FeishuHealthError(health);
    return health;
  }
}
