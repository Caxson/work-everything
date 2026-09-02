import { describe, expect, it } from 'vitest';
import {
  classifyHealth,
  FEISHU_STUCK_STATES,
  FeishuHealthError,
  FeishuHealthMonitor,
  realWindows,
  type HealthObservation,
} from '../src/perception/feishu/health.js';
import type { AxNode, WindowDiagnosis } from '../src/perception/macos/axProtocol.js';

const PID = 4242;
const OK: WindowDiagnosis = { code: 'OK', addressable: 1 };

/**
 * A real answer from `windows {meta:true}`, kept verbatim so these tests are
 * pinned to what the machine did rather than to what anyone expected.
 *
 * Taken while the `legacyScreenSaver` **host process** was running — nineteen
 * days of uptime — on an unlocked desktop that was drawing eight applications
 * normally. `screenSaverOnScreen: false` is the correct answer and the whole
 * point: matching the process name says "yes" here, and "yes" is wrong.
 */
const SAVER_IDLE: WindowDiagnosis = {
  code: 'AX_SEES_NO_WINDOWS_BUT_CG_DOES',
  details: {
    cgWindows: 5,
    onScreen: 0,
    desktopOnScreen: 25,
    desktopOwnersOnScreen: 8,
    scope: 'application',
    screenSaverOnScreen: false,
    axWindows: { entries: 0, selfEqual: 0, real: 0, nonElement: 0 },
  },
};

/**
 * A saver actually on screen. Constructed, not captured: producing it means
 * taking the machine away from whoever is using it, so the helper measured
 * this signal directly only in the negative. Both sides fail safe — a miss
 * reads as the general "not being drawn" answer, and a false positive needs a
 * full-screen saver window on screen, which is the thing itself.
 *
 * `scope` is `application`, not `desktop`: the saver's own window is on screen,
 * and the helper derives `desktop` from `desktopOnScreen == 0`. The verdict
 * comes from `screenSaverOnScreen`, which is the point — it does not need the
 * scope to agree with it.
 */
const SAVER_ON_SCREEN: WindowDiagnosis = {
  code: 'AX_SEES_NO_WINDOWS_BUT_CG_DOES',
  details: { cgWindows: 5, onScreen: 0, desktopOnScreen: 1, desktopOwnersOnScreen: 1, scope: 'application', screenSaverOnScreen: true },
};

/**
 * A real `FULLSCREEN_SPACE` answer, verbatim. Chrome full-screen on one
 * display with 飞书 on the Space behind it: 0 accessibility windows against 6
 * known to the window server, and 3 windows from 1 process on screen — a
 * desktop compositing perfectly well, which is why the owner count is evidence
 * for nothing. Activating 飞书 gave it 1 addressable window at 1397x937 and
 * returning to Chrome took it away again.
 */
const FULLSCREEN: WindowDiagnosis = {
  code: 'FULLSCREEN_SPACE',
  message:
    'pid 68285 exposes no accessibility window because the active Space belongs to a full-screen application (Google Chrome). ' +
    'macOS does not composite windows that live on another Space, and accessibility follows the compositor: every application ' +
    'on the other Space reads as having no window. Nothing is wrong and retrying will not help — the action has to wait until ' +
    'the person leaves full screen, or be run against an application on this Space. Evidence: AXFullScreen, currentSpaceType=4',
  details: {
    cgWindows: 6,
    onScreen: 0,
    desktopOnScreen: 3,
    desktopOwnersOnScreen: 1,
    screenSaverOnScreen: false,
    scope: 'application',
    space: { fullScreen: true, evidence: ['AXFullScreen', 'currentSpaceType=4'], spaces: 3, currentSpaceType: 4, frontmostApp: 'Google Chrome' },
    axWindows: { entries: 0, real: 0, nonElement: 0, selfEqual: 0 },
  },
};

function reading(overrides: Partial<HealthObservation> = {}): HealthObservation {
  return {
    pid: PID,
    diagnosis: OK,
    windows: [{ role: 'AXWindow', title: '飞书' }],
    webAreaTitles: ['messenger', 'messenger-chat'],
    failures: 0,
    ...overrides,
  };
}

describe('classifying one reading of Feishu', () => {
  it('is ok when a real window exposes the conversation web area', () => {
    const health = classifyHealth(reading());
    expect(health.state).toBe('ok');
    expect(health.detail).toContain('conversation open');
  });

  it('is still ok on another sidebar tab, and says which web areas it found', () => {
    const health = classifyHealth(reading({ webAreaTitles: ['history-list'] }));
    expect(health.state).toBe('ok');
    expect(health.detail).toContain('no conversation open');
    expect(health.detail).toContain('history-list');
  });

  it('does not mistake the helper’s application fallback for a window', () => {
    expect(realWindows([{ role: 'AXApplication', title: '飞书' }])).toEqual([]);
    expect(realWindows([{ role: 'AXWindow', title: 'ModalWebViewWidget' }])).toEqual([]);
    expect(realWindows([{ role: 'AXWindow', title: '飞书' }])).toHaveLength(1);
  });

  it('reports only a modal being open as its own thing, not as a fault', () => {
    const health = classifyHealth(reading({ windows: [{ role: 'AXWindow', title: 'ModalWebViewWidget-1' }] }));
    expect(health.state).toBe('no_window');
    expect(health.detail).toContain('modal');
  });
});

describe('the four reasons an app exposes no window', () => {
  // Each of these looks identical from a window count, and each one needs a
  // different sentence said to a person. That is why the helper classifies
  // them and this file no longer guesses from an empty array.

  it('a locked screen: unlock it, and nothing is retried until then', () => {
    const health = classifyHealth(reading({ diagnosis: { code: 'SCREEN_LOCKED', message: 'locked' }, windows: [] }));
    expect(health.state).toBe('screen_locked');
    expect(health.detail).toContain('unlock');
    expect(health.detail).not.toContain('restart');
  });

  it('a full-screen Space: nothing is wrong, and nothing to do but wait', () => {
    const health = classifyHealth(reading({ windows: [], diagnosis: FULLSCREEN }));
    expect(health.state).toBe('fullscreen_space');
    expect(health.detail).toContain('Google Chrome');
    expect(health.detail).toContain('Nothing is wrong with the machine');
    expect(health.detail).toContain('AXFullScreen, currentSpaceType=4');
    // Every wrong reading of this state sends somebody to fix a working Mac.
    expect(health.detail).not.toContain('restart');
    expect(health.detail).not.toContain('unlock');
    expect(health.detail).toContain('6 window(s) known to the window server, 0 on screen');
  });

  it('reads the Space out of the census when the code does not name it', () => {
    // A helper that reports the census without having learned the code lands
    // in the not-drawn branch, and the fact is honoured from there too.
    const health = classifyHealth(
      reading({
        windows: [],
        diagnosis: {
          code: 'AX_SEES_NO_WINDOWS_BUT_CG_DOES',
          message: 'not drawn',
          details: { ...FULLSCREEN.details, scope: 'application' },
        },
      }),
    );
    expect(health.state).toBe('fullscreen_space');
    expect(health.detail).toContain('Google Chrome');
  });

  it('names no application when the private Space list was not available', () => {
    // `frontmostApp` comes from a list a macOS may stop vending. Absence is not
    // a negative, and it is not something to guess at either.
    const health = classifyHealth(
      reading({ windows: [], diagnosis: { code: 'FULLSCREEN_SPACE', details: { cgWindows: 6, onScreen: 0, space: { fullScreen: true, evidence: ['AXFullScreen'] } } } }),
    );
    expect(health.state).toBe('fullscreen_space');
    expect(health.detail).toContain('a full-screen application');
    expect(health.detail).toContain('Evidence: AXFullScreen');
  });

  it('leaves a census that looked at the Space and found none alone', () => {
    // The same measured not-drawn payload, with the Space answered in the
    // negative: `fullScreen: false` is a real answer and must not be read as
    // one, and this stays the verdict it was before the Space existed.
    const health = classifyHealth(
      reading({
        windows: [],
        diagnosis: {
          code: 'AX_SEES_NO_WINDOWS_BUT_CG_DOES',
          message: 'not drawn',
          details: { cgWindows: 5, onScreen: 0, desktopOnScreen: 25, desktopOwnersOnScreen: 8, scope: 'application', screenSaverOnScreen: false, space: { fullScreen: false, evidence: [] } },
        },
      }),
    );
    expect(health.state).toBe('not_drawn');
    expect(health.detail).toContain('another space');
  });

  it('rules the screen saver out when the helper says it is not on screen', () => {
    // MEASURED, and the case that caught a real bug: the saver's host process
    // was running, so "is the process alive" answered yes. The window is not
    // on screen, so the honest answer is no.
    const health = classifyHealth(reading({ windows: [], diagnosis: SAVER_IDLE }));
    expect(health.state).toBe('not_drawn');
    expect(health.detail).toContain('No screen saver is on screen');
    expect(health.detail).toContain('not locked');
    expect(health.detail).not.toContain('restart Feishu');
    // The census is the evidence, so it travels with the verdict.
    expect(health.detail).toContain('25 on screen machine-wide across 8 process');
  });

  it('names a screen saver, and no password, when one is actually on screen', () => {
    const health = classifyHealth(reading({ windows: [], diagnosis: SAVER_ON_SCREEN }));
    expect(health.state).toBe('desktop_blank');
    expect(health.detail).toContain('screen saver is on screen');
    expect(health.detail).toContain('no password');
    expect(health.detail).not.toContain('restart Feishu');
  });

  it('says nothing either way when the helper does not report the saver at all', () => {
    // An older helper omits the key. `false` is a real negative and absence is
    // not; conflating them would put a claim in the message that nothing
    // measured.
    const health = classifyHealth(
      reading({ windows: [], diagnosis: { code: 'AX_SEES_NO_WINDOWS_BUT_CG_DOES', details: { cgWindows: 5, onScreen: 0, scope: 'application' } } }),
    );
    expect(health.state).toBe('not_drawn');
    expect(health.detail).not.toContain('No screen saver is on screen');
    expect(health.detail).toContain('something covering the desktop');
  });

  it('reports a desktop drawing nothing, with the saver ruled out', () => {
    const health = classifyHealth(
      reading({
        windows: [],
        diagnosis: {
          code: 'AX_SEES_NO_WINDOWS_BUT_CG_DOES',
          message: 'nothing is compositing',
          details: { cgWindows: 3, onScreen: 0, desktopOnScreen: 1, desktopOwnersOnScreen: 1, scope: 'desktop', screenSaverOnScreen: false },
        },
      }),
    );
    expect(health.state).toBe('desktop_blank');
    expect(health.detail).toContain('nothing on this machine is being drawn');
    expect(health.detail).toContain('No screen saver is on screen');
  });

  it('windows that exist but are not being drawn, with no screen saver behind it', () => {
    const health = classifyHealth(
      reading({
        windows: [],
        diagnosis: {
          code: 'AX_SEES_NO_WINDOWS_BUT_CG_DOES',
          message: 'not drawn',
          details: { cgWindows: 3, onScreen: 0, desktopOnScreen: 42, desktopOwnersOnScreen: 12, scope: 'application' },
        },
      }),
    );
    expect(health.state).toBe('not_drawn');
    expect(health.detail).toContain('another space');
    expect(health.detail).toContain('3 window(s) known to the window server, 0 on screen');
  });

  it('genuinely no window: closed to the tray, and not an error state', () => {
    const health = classifyHealth(reading({ windows: [], diagnosis: { code: 'NO_WINDOW', message: 'none', details: { cgWindows: 0, onScreen: 0 } } }));
    expect(health.state).toBe('no_window');
    expect(health.detail).toContain('tray');
  });

  it('passes on a cause it does not recognise in the helper’s own words', () => {
    const health = classifyHealth(reading({ windows: [], diagnosis: { code: 'SOMETHING_NEW', message: 'a cause learned later' } }));
    expect(health.state).toBe('no_window');
    expect(health.detail).toBe('a cause learned later');
  });

  it('never reports a full-screen Space from a reading that does not say so', () => {
    // The screen saver shipped as a false positive because the predicate was
    // only ever exercised on its true side. Every reading here is a machine
    // that is not in a full-screen Space, and two of them carry a census that
    // answered the question in the negative rather than not asking it.
    const elsewhere = [
      { windows: [{ role: 'AXWindow', title: '飞书' }], diagnosis: OK, state: 'ok' },
      { windows: [], diagnosis: { code: 'SCREEN_LOCKED', message: 'locked' }, state: 'screen_locked' },
      { windows: [], diagnosis: { code: 'NO_WINDOW', message: 'none', details: { cgWindows: 0, onScreen: 0 } }, state: 'no_window' },
      { windows: [], diagnosis: SAVER_IDLE, state: 'not_drawn' },
      { windows: [], diagnosis: SAVER_ON_SCREEN, state: 'desktop_blank' },
      {
        windows: [],
        diagnosis: {
          code: 'AX_SEES_NO_WINDOWS_BUT_CG_DOES',
          details: { cgWindows: 3, onScreen: 0, desktopOnScreen: 0, desktopOwnersOnScreen: 0, scope: 'desktop', screenSaverOnScreen: false },
        },
        state: 'desktop_blank',
      },
      {
        windows: [],
        diagnosis: {
          code: 'AX_SEES_NO_WINDOWS_BUT_CG_DOES',
          details: { cgWindows: 3, onScreen: 0, desktopOnScreen: 42, desktopOwnersOnScreen: 12, scope: 'application', space: { fullScreen: false, evidence: [] } },
        },
        state: 'not_drawn',
      },
      { windows: [], diagnosis: { code: 'AX_SEES_NO_WINDOWS_BUT_CG_DOES', details: { cgWindows: 3, onScreen: 0, scope: 'application' } }, state: 'not_drawn' },
    ] satisfies { windows: HealthObservation['windows']; diagnosis: WindowDiagnosis; state: string }[];

    for (const entry of elsewhere) {
      const health = classifyHealth(reading({ windows: entry.windows, diagnosis: entry.diagnosis }));
      expect(health.state).toBe(entry.state);
      expect(health.detail).not.toContain('full-screen');
    }
  });

  it('never escalates a diagnosed cause to wedged, however many times it repeats', () => {
    for (const diagnosis of [
      { code: 'SCREEN_LOCKED' },
      { code: 'NO_WINDOW' },
      { code: 'FULLSCREEN_SPACE', details: { space: { fullScreen: true, evidence: ['AXFullScreen'] } } },
      { code: 'AX_SEES_NO_WINDOWS_BUT_CG_DOES', details: { scope: 'desktop' } },
      { code: 'AX_SEES_NO_WINDOWS_BUT_CG_DOES', details: { scope: 'application' } },
    ] satisfies WindowDiagnosis[]) {
      const health = classifyHealth(reading({ windows: [], diagnosis, failures: 99 }), { wedgedAfter: 1 });
      expect(health.state).not.toBe('wedged');
    }
  });
});

describe('the one thing that is actually wedged', () => {
  it('is a window the helper can address with no web content in it, repeatedly', () => {
    expect(classifyHealth(reading({ webAreaTitles: [], failures: 0 })).state).toBe('no_window');
    const health = classifyHealth(reading({ webAreaTitles: [], failures: 3 }));
    expect(health.state).toBe('wedged');
    expect(health.detail).toContain('accessibility layer is wedged');
    expect(health.detail).toContain('restart Feishu');
  });

  it('respects the configured patience', () => {
    expect(classifyHealth(reading({ webAreaTitles: [], failures: 0 }), { wedgedAfter: 1 }).state).toBe('no_window');
    expect(classifyHealth(reading({ webAreaTitles: [], failures: 1 }), { wedgedAfter: 1 }).state).toBe('wedged');
  });

  it('names the states where trying again cannot help', () => {
    expect([...FEISHU_STUCK_STATES].sort()).toEqual(['desktop_blank', 'fullscreen_space', 'not_drawn', 'screen_locked', 'wedged']);
  });
});

describe('the health monitor', () => {
  const window: AxNode = { nodeId: 1, role: 'AXWindow', title: '飞书' };
  const webArea: AxNode = { nodeId: 2, role: 'AXWebArea', title: 'messenger-chat' };
  const healthy = { windows: [window], diagnosis: OK };

  it('re-resolves the pid on every check, so a Feishu restart is picked up', async () => {
    let pid = 100;
    const made = new FeishuHealthMonitor({
      pid: async () => (pid += 1),
      windows: async () => healthy,
      webAreas: async () => [webArea],
    });
    expect((await made.check()).pid).toBe(101);
    expect((await made.check()).pid).toBe(102);
  });

  it('reports every verdict to whoever is listening, and survives a listener that throws', async () => {
    // The screen-lock sensor listens here, because the sender consults health
    // before it touches a driver: a lock found that way never reaches the
    // action layer's own error channel, so this is the only place it surfaces.
    const seen: string[] = [];
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => healthy,
      webAreas: async () => [webArea],
      onHealth: (health) => {
        seen.push(health.state);
        throw new Error('the listener is broken');
      },
    });

    expect((await made.check()).state).toBe('ok');
    expect(seen).toEqual(['ok']);
  });

  it('reports a locked screen through the same channel', async () => {
    const seen: string[] = [];
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => ({ windows: [], diagnosis: { code: 'SCREEN_LOCKED' } }),
      webAreas: async () => [],
      onHealth: (health) => seen.push(health.state),
    });
    expect((await made.check()).state).toBe('screen_locked');
    expect(seen).toEqual(['screen_locked']);
  });

  it('reports a full-screen Space through the same channel', async () => {
    // The channel the queue's sensor listens on. The sender consults health
    // before it touches a driver, so for this state it is the only one.
    const seen: string[] = [];
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => ({ windows: [], diagnosis: FULLSCREEN }),
      webAreas: async () => [],
      onHealth: (health) => seen.push(health.state),
    });
    expect((await made.check()).state).toBe('fullscreen_space');
    expect(seen).toEqual(['fullscreen_space']);
  });

  it('spawns nothing to reach a verdict', async () => {
    // There was a `pgrep` here for "is a screen saver running". It was a live
    // false positive: `legacyScreenSaver` is a long-lived host that lingers
    // after the saver stops — measured at nineteen days old on a machine
    // somebody was using — so it told an active user to wait for a screen
    // saver that was not on screen. The signal that would work is the saver's
    // own on-screen window, which only the helper can read.
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => ({ windows: [], diagnosis: SAVER_IDLE }),
      webAreas: async () => [],
    });
    expect((await made.check()).state).toBe('not_drawn');
  });

  it('takes the diagnosis from the helper rather than inferring one', async () => {
    // Nothing here launches, raises or activates anything: this runs while
    // somebody else is using the Mac.
    const asked: string[] = [];
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => {
        asked.push('windows');
        return { windows: [], diagnosis: { code: 'SCREEN_LOCKED', message: 'locked' } };
      },
      webAreas: async () => {
        asked.push('webAreas');
        return [];
      },
    });
    const health = await made.check();
    expect(health.state).toBe('screen_locked');
    expect(asked).toEqual(['windows', 'webAreas']);
  });

  it('escalates to wedged only after repeated failures, then stays there', async () => {
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => healthy,
      webAreas: async () => [],
      config: { wedgedAfter: 2 },
    });
    expect((await made.check()).state).toBe('no_window');
    expect((await made.check()).state).toBe('no_window');
    expect((await made.check()).state).toBe('wedged');
    expect((await made.check()).state).toBe('wedged');
    expect(made.consecutiveFailures).toBeGreaterThanOrEqual(4);
  });

  it('forgets past failures as soon as one reading comes back healthy', async () => {
    let broken = true;
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => healthy,
      webAreas: async () => (broken ? [] : [webArea]),
      config: { wedgedAfter: 2 },
    });
    await made.check();
    broken = false;
    expect((await made.check()).state).toBe('ok');
    expect(made.consecutiveFailures).toBe(0);
  });

  it('reports a missing process as something to wait for, not as a wedged app', async () => {
    const made = new FeishuHealthMonitor({
      pid: async () => {
        throw new Error('Feishu (com.bytedance.macos.feishu) is not running');
      },
      windows: async () => healthy,
      webAreas: async () => [webArea],
    });
    const health = await made.check();
    expect(health.state).toBe('no_window');
    expect(health.detail).toContain('not running');
  });

  it('throws on a wedged app when the caller must not continue', async () => {
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => healthy,
      webAreas: async () => [],
      config: { wedgedAfter: 1 },
    });
    await made.check();
    await expect(made.require()).rejects.toBeInstanceOf(FeishuHealthError);
  });

  it('does not throw on anything short of wedged', async () => {
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => ({ windows: [], diagnosis: { code: 'NO_WINDOW', message: 'tray' } }),
      webAreas: async () => [],
    });
    await expect(made.require()).resolves.toMatchObject({ state: 'no_window' });
  });

  it('survives a web-area read that fails outright', async () => {
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => healthy,
      webAreas: async () => {
        throw new Error('find failed');
      },
    });
    expect((await made.check()).state).toBe('no_window');
  });
});
