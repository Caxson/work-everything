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
 * The real answer `windows {meta:true}` gave for pid 730 while
 * `legacyScreenSaver` was running and the session was unlocked. Kept verbatim
 * so the tests are pinned to what the machine did, not to what we expected.
 */
const SCREEN_SAVER_READING: WindowDiagnosis = {
  code: 'AX_SEES_NO_WINDOWS_BUT_CG_DOES',
  details: {
    cgWindows: 5,
    onScreen: 0,
    desktopOnScreen: 25,
    desktopOwnersOnScreen: 8,
    scope: 'application',
    axWindows: { entries: 0, selfEqual: 0, real: 0, nonElement: 0 },
  },
};

function reading(overrides: Partial<HealthObservation> = {}): HealthObservation {
  return {
    pid: PID,
    diagnosis: OK,
    screenSaverRunning: false,
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

  it('a running screen saver: wait for it, and do not go looking for a password', () => {
    // MEASURED, not reasoned about. This is the literal payload `windows`
    // returned for pid 730 with legacyScreenSaver running and the session
    // unlocked. Note `scope: "application"` and eight processes still
    // drawing — the helper's `owners <= 1` rule does not fire here.
    const health = classifyHealth(reading({ windows: [], diagnosis: SCREEN_SAVER_READING, screenSaverRunning: true }));
    expect(health.state).toBe('desktop_blank');
    expect(health.detail).toContain('screen saver');
    expect(health.detail).toContain('not locked');
    expect(health.detail).not.toContain('restart Feishu');
    // The census is the evidence, so it travels with the verdict.
    expect(health.detail).toContain('25 on screen machine-wide across 8 process');
  });

  it('would have missed that case entirely on `scope` alone', () => {
    // The same measured payload, with nothing asking whether a screen saver
    // is running: `scope` says "application", so the desktop-wide state never
    // fires. This is why the classification is not built on it.
    const health = classifyHealth(reading({ windows: [], diagnosis: SCREEN_SAVER_READING, screenSaverRunning: false }));
    expect(health.state).toBe('not_drawn');
  });

  it('still reports a desktop that is genuinely drawing nothing', () => {
    const health = classifyHealth(
      reading({
        windows: [],
        screenSaverRunning: false,
        diagnosis: {
          code: 'AX_SEES_NO_WINDOWS_BUT_CG_DOES',
          message: 'nothing is compositing',
          details: { cgWindows: 3, onScreen: 0, desktopOnScreen: 1, desktopOwnersOnScreen: 1, scope: 'desktop' },
        },
      }),
    );
    expect(health.state).toBe('desktop_blank');
    expect(health.detail).toContain('nothing on this machine is being drawn');
    expect(health.detail).not.toContain('screen saver');
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

  it('never escalates a diagnosed cause to wedged, however many times it repeats', () => {
    for (const diagnosis of [
      { code: 'SCREEN_LOCKED' },
      { code: 'NO_WINDOW' },
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
    expect([...FEISHU_STUCK_STATES].sort()).toEqual(['desktop_blank', 'not_drawn', 'screen_locked', 'wedged']);
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

  it('asks whether a screen saver is running only when that could be the answer', async () => {
    // A subprocess on every poll for a question that is almost always
    // irrelevant is a cost with no reader.
    const probes: string[] = [];
    const make = (diagnosis: WindowDiagnosis): FeishuHealthMonitor =>
      new FeishuHealthMonitor({
        pid: async () => PID,
        windows: async () => ({ windows: [], diagnosis }),
        webAreas: async () => [],
        screenSaverRunning: async () => {
          probes.push('asked');
          return true;
        },
      });

    await make({ code: 'OK', addressable: 1 }).check();
    await make({ code: 'NO_WINDOW' }).check();
    await make({ code: 'SCREEN_LOCKED' }).check();
    expect(probes).toEqual([]);

    const health = await make(SCREEN_SAVER_READING).check();
    expect(probes).toEqual(['asked']);
    expect(health.state).toBe('desktop_blank');
  });

  it('falls back to the general answer when the probe itself fails', async () => {
    const made = new FeishuHealthMonitor({
      pid: async () => PID,
      windows: async () => ({ windows: [], diagnosis: SCREEN_SAVER_READING }),
      webAreas: async () => [],
      screenSaverRunning: async () => {
        throw new Error('pgrep is not here');
      },
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
