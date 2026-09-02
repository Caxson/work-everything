/**
 * Is Feishu readable right now?
 *
 * Seven states, because "there is no window to read" has seven different
 * causes and they call for seven different responses. Getting this wrong is
 * expensive in both directions: a cause reported as a fault invites somebody
 * to restart a working application, and a fault reported as a wait is a daemon
 * that quietly does nothing forever.
 *
 * | state | what it means | what a person should do |
 * |---|---|---|
 * | `ok` | a real window with web content in it | nothing |
 * | `no_window` | closed to the tray, or only a modal is open | nothing; it resolves itself |
 * | `screen_locked` | the screen is locked | unlock it |
 * | `fullscreen_space` | a full-screen app owns the active Space | nothing; it resolves when they leave full screen |
 * | `desktop_blank` | nothing on the machine is being drawn | wait for the screen saver to exit |
 * | `not_drawn` | Feishu's windows exist but none is on screen | bring it to a space that is drawing |
 * | `wedged` | the app is up, its accessibility layer is not | restart Feishu |
 *
 * The important change from the first version of this file: **it no longer
 * infers any of this from an empty array.** The helper classifies the cause —
 * it can see the window server's census, which is not visible from a count
 * here — and this file turns that classification into a state and a sentence.
 *
 * One cause is worth its own note, because the obvious way to detect it is
 * wrong. A displaying screen saver takes accessibility windows away from every
 * application the way a lock does, while the session stays unlocked — so it is
 * neither `SCREEN_LOCKED` nor, measured, `scope: "desktop"` (it came back
 * `scope: "application"` with eight processes still drawing). Asking whether
 * the screen saver *process* is running is a false positive on any Mac where
 * one has ever run: `legacyScreenSaver` is a long-lived plugin host, measured
 * at nineteen days of uptime on a desktop somebody was actively using, with
 * its single window not on screen. A version of this file asked exactly that,
 * and would have told that person to go wait for a screen saver that was not
 * there.
 *
 * What separates the two states is the saver's own window being on screen and
 * covering the display, which lives in `CGWindowList` — readable by the helper
 * and not from here without a native binding. So it arrives as
 * `details.screenSaverOnScreen` and this file consumes it rather than
 * inventing one.
 *
 * The Space is the second cause whose obvious detection is wrong, and it was
 * the `desktop_blank` message that got it wrong: `scope: "desktop"` used to be
 * the helper's inference from `desktopOwnersOnScreen <= 1`, and one full-screen
 * application is exactly one owner on screen. Measured with Chrome full screen
 * and 飞书 on the other Space, that reported a machine drawing nothing while
 * Chrome was drawing at 1728x1003 and somebody was typing into it. The helper
 * now derives `scope: "desktop"` from `desktopOnScreen == 0` — nothing anywhere
 * on screen — and reports the Space separately, in `details.space`, so the two
 * questions are answered by the two signals that address them.
 *
 * `wedged` stays terminal and stays hard to reach: only an app that has
 * windows the helper can address, and no web content in them, across several
 * readings, earns it. Every diagnosed cause is an explanation, and an
 * explained state never escalates.
 */
import type { AxNode, WindowDiagnosis } from '../macos/axProtocol.js';
import { MODAL_WINDOW_PREFIX, ROLE, WEB_AREA } from './selectors.js';

export const FEISHU_HEALTH_STATES = ['ok', 'no_window', 'screen_locked', 'fullscreen_space', 'desktop_blank', 'not_drawn', 'wedged'] as const;
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
  'fullscreen_space',
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
    case 'FULLSCREEN_SPACE':
      return fullScreenSpace(pid, diagnosis);
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
 * Windows exist and none of them is drawn — but why.
 *
 * The full-screen Space is asked first, in the helper's own order: it is the
 * one cause here where the desktop is compositing perfectly well, and reading
 * it as any of the others produces advice about a machine that is fine. A
 * helper that reports the census without the code lands here rather than in
 * `fromDiagnosis`, so the same fact is honoured from either direction.
 *
 * `screenSaverOnScreen` is second: a fact about a window the window server is
 * compositing, and it gets its own answer because the advice is different
 * again — wait, and do not go looking for a password.
 *
 * `scope: "desktop"` is third, and now means what it says: the helper derives
 * it from `desktopOnScreen == 0`, nothing anywhere being drawn. It was
 * `desktopOwnersOnScreen <= 1` until a single full-screen application — one
 * owner, drawing at 1728x1003 — was reported through it as a desktop that was
 * not compositing.
 *
 * Worth knowing about the first branch: the helper measured
 * `screenSaverOnScreen` directly only in the **negative** — an idle saver
 * reads `false` against a desktop provably drawing eight applications. `true`
 * has not been observed, because producing it means taking the machine away
 * from whoever is using it. It fails safe either way: a miss reads as the
 * general "not being drawn" answer below, and a false positive would need a
 * full-screen saver window on screen, which is the thing itself.
 */
function notDrawn(pid: number, diagnosis: WindowDiagnosis): FeishuHealth {
  const details = diagnosis.details;
  if (details?.space?.fullScreen === true) return fullScreenSpace(pid, diagnosis);
  if (details?.screenSaverOnScreen === true) {
    return {
      state: 'desktop_blank',
      pid,
      detail:
        'a screen saver is on screen and compositing over every application, which takes their accessibility windows away exactly the way a lock ' +
        `does. Wait for it to exit — the session is not locked, so there is no password to go and find. ${census(diagnosis)}`.trim(),
    };
  }

  // `false` is a real answer, not a missing one: the helper reports this key
  // on every census it builds. Ruling the screen saver out is worth saying,
  // because it is the first thing somebody looking at a blank desktop guesses.
  const notTheSaver = details?.screenSaverOnScreen === false ? 'No screen saver is on screen, so it is something else.' : '';

  if (details?.scope === 'desktop') {
    return {
      state: 'desktop_blank',
      pid,
      detail: `nothing on this machine is being drawn, so no application exposes a window. ${notTheSaver} ${census(diagnosis)}`.replace(/\s+/g, ' ').trim(),
    };
  }
  return {
    state: 'not_drawn',
    pid,
    detail: (
      'Feishu has windows that are not being drawn — another space, minimised, or something covering the desktop. ' +
      `The Mac is not locked, so unlocking is not what is needed. ${notTheSaver} ${census(diagnosis)}`
    )
      .replace(/\s+/g, ' ')
      .trim(),
  };
}

/**
 * A full-screen application owns the active Space.
 *
 * The remedy is to wait, and the message has to say so plainly, because every
 * other reading of "no window" invites somebody to go and fix something: this
 * one is a working Mac being used by a person, and the only thing that changes
 * it is that person leaving full screen. The application is named when the
 * helper could read the private Space list, and omitted rather than guessed at
 * when it could not.
 */
function fullScreenSpace(pid: number, diagnosis: WindowDiagnosis): FeishuHealth {
  const space = diagnosis.details?.space;
  const app = space?.frontmostApp;
  const evidence = space?.evidence ?? [];
  return {
    state: 'fullscreen_space',
    pid,
    detail: (
      `the active Space belongs to a full-screen application${app === undefined ? '' : ` (${app})`}, and macOS composites no ` +
      'window that lives on another Space — accessibility follows the compositor, so every application on the other Space ' +
      'reads as having no window. Nothing is wrong with the machine and retrying will not help: this waits until the person ' +
      `leaves full screen. ${evidence.length === 0 ? '' : `Evidence: ${evidence.join(', ')}.`} ${census(diagnosis)}`
    )
      .replace(/\s+/g, ' ')
      .trim(),
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
  /**
   * Sees every verdict. The screen-lock sensor listens here, because this is
   * where the helper's `SCREEN_LOCKED` diagnosis is turned into a state — and
   * the sender consults health *before* it touches a driver, so a lock found
   * this way never reaches the action layer's own error channel.
   */
  readonly onHealth?: (health: FeishuHealth) => void;
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

    this.report(health);
    if (health.state === 'ok') {
      this.failures = 0;
      return health;
    }
    this.failures += 1;
    return health;
  }

  /** Observation only: a listener that throws must not change the verdict. */
  private report(health: FeishuHealth): void {
    if (this.deps.onHealth === undefined) return;
    try {
      this.deps.onHealth(health);
    } catch {
      // Intentionally swallowed.
    }
  }

  /** Throwing form, for the paths that must not continue on a wedged app. */
  async require(): Promise<FeishuHealth> {
    const health = await this.check();
    if (health.state === 'wedged') throw new FeishuHealthError(health);
    return health;
  }
}
